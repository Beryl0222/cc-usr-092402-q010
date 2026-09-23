import { audit, canonicalize, digest, atBefore } from './contracts.js';
import { governanceSnapshot } from './governance.js';
import { getMotion, sectionRevisionAt, recordSignoffs, listMinorityOpinions } from './motions.js';
import { resolveBallots } from './ballots.js';

/**
 * 计票是纯函数：给定记录在时点 at 的完整状态，任何人复算必得同一结论。
 * - 尚未宣布的结果不落账；回避或资格到期后用新状态重新 computeTally 即可；
 * - 宣布（announceDecision）把计票快照（规则版本、有效成员、账目、摘要）固化；
 * - 宣布后发现错误只能走 fileCorrection 公开更正，原决定不被静默改写。
 */

// 比例一律整数交叉相乘比较，避免浮点误差影响“复算一致”
function checkQuorum(rule, participation, eligibleCount) {
  if (!rule) return { ok: false, detail: '缺少法定人数规则' };
  if (rule.kind === 'fixed') {
    return { ok: participation >= rule.min_count, detail: { need: rule.min_count, have: participation } };
  }
  if (rule.kind === 'fraction') {
    return {
      ok: participation * rule.denominator >= rule.numerator * eligibleCount,
      detail: { need: `${rule.numerator}/${rule.denominator}`, have: participation, eligible: eligibleCount },
    };
  }
  throw new Error(`未知法定人数规则类型: ${rule.kind}`);
}

function checkThreshold(rule, counts, eligibleCount) {
  if (!rule) return { ok: false, detail: '缺少表决门槛规则' };
  const positive = counts.approve + counts.conditional;
  const negative = counts.reject;
  const nonAbstaining = positive + negative;
  const basis = rule.basis ?? 'non_abstain';
  const denominator =
    basis === 'eligible' ? eligibleCount : basis === 'cast' ? nonAbstaining + counts.abstain : nonAbstaining;
  const numerator = rule.kind === 'unanimous' ? 1 : rule.numerator;
  const ratioDen = rule.kind === 'unanimous' ? 1 : rule.denominator;
  // “过半数”不含本数（inclusive:false，平手不通过）；“三分之二以上”等含本数（默认）
  const inclusive = rule.inclusive !== false;
  const passed =
    denominator > 0 &&
    (inclusive
      ? positive * ratioDen >= numerator * denominator
      : positive * ratioDen > numerator * denominator);
  let rejected = false;
  if (rule.negative_numerator != null && denominator > 0) {
    rejected = negative * rule.negative_denominator >= rule.negative_numerator * denominator;
  }
  return {
    ok: passed,
    rejected,
    detail: { kind: rule.kind, basis, numerator, denominator: ratioDen, positive, negative, basis_count: denominator },
  };
}

/** 单章节复算。action_kind 用于选择门槛（ordinary / escalation / conditional_approval / safety_emergency）。 */
export function computeSectionTally(session, motion, section, at, actionKind = 'ordinary') {
  const scope = { motion_id: motion.motion_id, section_id: section.section_id, topic: section.topic };
  const snapshot = governanceSnapshot(session.governance, scope, at, actionKind);
  const { votes, accounting, window } = resolveBallots(session, motion, section, at);

  // 回避或资格到期的席位不计入：其已投出的票从计票账目中移出，单列留痕
  const eligibleIds = new Set(snapshot.voters.map((v) => v.authorization_id));
  const countedVotes = new Map();
  for (const [authorizationId, ballot] of votes) {
    if (eligibleIds.has(authorizationId)) countedVotes.set(authorizationId, ballot);
    else accounting.ineligible_seat.push(ballot.ballot_id);
  }
  const ineligibleSet = new Set(accounting.ineligible_seat);
  accounting.counted = accounting.counted.filter((id) => !ineligibleSet.has(id));

  const counts = { approve: 0, reject: 0, abstain: 0, conditional: 0 };
  const conditions = [];
  for (const ballot of countedVotes.values()) {
    counts[ballot.revealed.choice] += 1;
    if (ballot.revealed.choice === 'conditional') conditions.push(...ballot.revealed.conditions);
  }

  const participation = countedVotes.size;
  const quorum = checkQuorum(snapshot.quorum_rule, participation, snapshot.voters.length);
  const threshold = checkThreshold(snapshot.threshold, counts, snapshot.voters.length);

  const window_closed = window ? atBefore(window.closes_at, at) : false;
  const revision = sectionRevisionAt(motion, section.section_id);

  let outcome;
  if (!snapshot.in_agenda) outcome = 'out_of_agenda';
  else if (!window_closed) outcome = 'window_open';
  else if (!quorum.ok) outcome = 'no_quorum';
  else if (threshold.ok) outcome = conditions.length > 0 ? 'conditionally_approved' : 'approved';
  else if (threshold.rejected) outcome = 'rejected';
  else outcome = 'deadlocked';

  const minority = listMinorityOpinions(session, {
    motion_id: motion.motion_id,
    section_id: section.section_id,
  }).filter((o) => o.revision <= revision);

  const result = {
    motion_id: motion.motion_id,
    section_id: section.section_id,
    section_revision: revision,
    at,
    action_kind: actionKind,
    outcome,
    counts,
    participation,
    quorum,
    threshold_check: threshold,
    conditions,
    review_window: window ? { window_id: window.window_id, opens_at: window.opens_at, closes_at: window.closes_at } : null,
    rules: snapshot.versions,
    rules_digest: snapshot.rules_digest,
    eligible_voters: snapshot.voters.map((v) => ({
      authorization_id: v.authorization_id,
      holder_id: v.holder_id,
      via: v.via,
    })),
    materials: snapshot.materials.map((m) => ({
      material_id: m.material_id,
      version: m.version,
      title: m.title ?? null,
      content_digest: m.content_digest,
    })),
    ballot_accounting: accounting,
    ballots_counted: [...countedVotes.values()].map((b) => ({
      ballot_id: b.ballot_id,
      authorization_id: b.authorization_id,
      choice: b.revealed.choice,
      seq: b.seq,
    })),
    minority_opinion_ids: minority.map((o) => o.opinion_id),
  };
  result.tally_digest = digest(canonicalize(withoutDigest(result)));
  return result;
}

const withoutDigest = (r) => {
  const { tally_digest, ...rest } = r;
  return rest;
};

/** 多章节复算（同一次宣布可合并多章节；各章节独立计票）。 */
export function computeTally(session, motionId, sectionIds, at, { action_kind = 'ordinary' } = {}) {
  const motion = getMotion(session, motionId);
  const sections = sectionIds.map((id) => {
    const section = motion.sections.find((s) => s.section_id === id);
    if (!section) throw new Error(`议案 ${motionId} 不存在章节 ${id}`);
    return computeSectionTally(session, motion, section, at, action_kind);
  });
  // 整体结论归并：全部通过才算通过；否则按 否决 > 僵局 > 人数不足 > 其他阻塞 的优先级呈现
  const outcomes = sections.map((s) => s.outcome);
  let overall;
  if (outcomes.every((o) => o === 'approved' || o === 'conditionally_approved')) {
    overall = outcomes.includes('conditionally_approved') ? 'conditionally_approved' : 'approved';
  } else if (outcomes.includes('rejected')) overall = 'rejected';
  else if (outcomes.includes('deadlocked')) overall = 'deadlocked';
  else if (outcomes.includes('no_quorum')) overall = 'no_quorum';
  else if (outcomes.includes('out_of_agenda')) overall = 'out_of_agenda';
  else overall = 'window_open';
  return {
    motion_id: motionId,
    at,
    action_kind,
    sections,
    overall_outcome: overall,
  };
}

const FINAL_OUTCOMES = new Set(['approved', 'conditionally_approved', 'rejected', 'deadlocked']);

/** 宣布：把复算结果固化为决定；只有通过的章节触发签署，条件同步落账。 */
export function announceDecision(session, { decision_id, motion_id, section_ids, at, action_kind = 'ordinary', declared_by }) {
  if (session.decisions.some((d) => d.decision_id === decision_id)) {
    throw new Error(`决定已存在: ${decision_id}`);
  }
  const tally = computeTally(session, motion_id, section_ids, at, { action_kind });
  const motion = getMotion(session, motion_id);

  for (const s of tally.sections) {
    if (!FINAL_OUTCOMES.has(s.outcome)) {
      throw new Error(`章节 ${s.section_id} 当前结论为 ${s.outcome}，不具备宣布条件（窗口未闭/不足法定人数/不在议题范围）`);
    }
  }

  const tallyIds = [];
  for (const result of tally.sections) {
    const tally_id = `TAL-${session.tallies.length + 1}`;
    session.tallies.push({ tally_id, decision_id, ...result, announced: true, announced_at: at });
    tallyIds.push(tally_id);
  }

  const passed = tally.sections.filter((s) => s.outcome === 'approved' || s.outcome === 'conditionally_approved');
  recordSignoffs(motion, passed.map((s) => s.section_id), { decision_id, at, revision: motion.current_revision });

  const conditionIds = [];
  for (const result of passed) {
    for (const c of result.conditions) {
      const condition_id = `CON-${session.conditions.length + 1}`;
      session.conditions.push({
        condition_id,
        decision_id,
        motion_id,
        section_id: result.section_id,
        text: c.text,
        owner_party: c.owner_party,
        due_at: c.due_at,
        status: 'open',
        created_at: at,
      });
      conditionIds.push(condition_id);
    }
  }

  const decision = {
    decision_id,
    motion_id,
    section_ids: [...section_ids],
    motion_revision: motion.current_revision,
    action_kind,
    announced_at: at,
    declared_by,
    overall_outcome: tally.overall_outcome,
    tally_ids: tallyIds,
    condition_ids: conditionIds,
    correction_ids: [],
  };
  session.decisions.push(decision);
  audit(session, at, 'decision_announced', {
    decision_id,
    motion_id,
    section_ids,
    overall_outcome: tally.overall_outcome,
    tally_digests: tally.sections.map((s) => s.tally_digest),
  });
  return { decision, tally };
}

/** 用记录当前状态在原宣布时点复算，逐章节比对摘要，供任何人验证。 */
export function verifyDecision(session, decisionId) {
  const decision = session.decisions.find((d) => d.decision_id === decisionId);
  if (!decision) throw new Error(`决定不存在: ${decisionId}`);
  const recomputed = computeTally(session, decision.motion_id, decision.section_ids, decision.announced_at, {
    action_kind: decision.action_kind,
  });
  const stored = new Map(
    session.tallies.filter((t) => t.decision_id === decisionId).map((t) => [t.section_id, t]),
  );
  return recomputed.sections.map((s) => {
    const original = stored.get(s.section_id);
    return {
      section_id: s.section_id,
      original_digest: original.tally_digest,
      recomputed_digest: s.tally_digest,
      matches: original.tally_digest === s.tally_digest,
      original_outcome: original.outcome,
      recomputed_outcome: s.outcome,
    };
  });
}

/**
 * 宣布后的公开更正：追加更正记录并附复算结论，原决定保留不动。
 * error_type: counting_error（计票错误）| record_error（资格/回避/材料等基础记录错误）。
 */
export function fileCorrection(session, { correction_id, decision_id, at, error_type, reason, filed_by }) {
  const decision = session.decisions.find((d) => d.decision_id === decision_id);
  if (!decision) throw new Error(`决定不存在: ${decision_id}`);
  if (session.corrections.some((c) => c.correction_id === correction_id)) {
    throw new Error(`更正已存在: ${correction_id}`);
  }
  if (!['counting_error', 'record_error'].includes(error_type)) {
    throw new Error('更正类型必须为 counting_error 或 record_error');
  }
  const recomputed = computeTally(session, decision.motion_id, decision.section_ids, decision.announced_at, {
    action_kind: decision.action_kind,
  });
  const entry = {
    correction_id,
    decision_id,
    at,
    error_type,
    reason,
    filed_by,
    recomputed: recomputed.sections.map((s) => ({
      section_id: s.section_id,
      outcome: s.outcome,
      tally_digest: s.tally_digest,
      counts: s.counts,
      eligible_voters: s.eligible_voters,
      ballot_accounting: s.ballot_accounting,
    })),
  };
  session.corrections.push(entry);
  decision.correction_ids.push(correction_id);
  audit(session, at, 'correction_filed', { correction_id, decision_id, error_type });
  return entry;
}
