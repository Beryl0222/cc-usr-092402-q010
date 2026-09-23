import { digest, atBefore } from './contracts.js';
import { verifyDecision } from './tally.js';
import { listMinorityOpinions } from './motions.js';

/**
 * 最终纪要：
 * - 附件按合作方权限隐藏（无 visibility 声明的附件视为公开）；
 * - 完整列出本次计票采用的规则版本、有效成员集合、材料摘要、条件与少数意见；
 * - conclusion_digest 覆盖决定与全部计票快照，任何人以同一记录复算都得到相同结论。
 */

const canSee = (attachment, viewer) => {
  const v = attachment.visibility;
  if (!v) return true;
  if (v.parties && v.parties.includes(viewer.party_id)) return true;
  if (v.roles && viewer.roles && v.roles.some((r) => viewer.roles.includes(r))) return true;
  return false;
};

const conditionStatusAt = (condition, now) =>
  condition.status === 'open' && atBefore(condition.due_at, now) ? 'overdue' : condition.status;

/** 结论摘要只覆盖决定、各章节固化计票与公开更正，不含随查看方变化的附件视图。 */
export function conclusionDigest(decision, tallies, corrections) {
  return digest({
    decision: {
      decision_id: decision.decision_id,
      motion_id: decision.motion_id,
      motion_revision: decision.motion_revision,
      section_ids: decision.section_ids,
      overall_outcome: decision.overall_outcome,
      announced_at: decision.announced_at,
      declared_by: decision.declared_by,
      action_kind: decision.action_kind,
    },
    sections: tallies.map((t) => ({
      section_id: t.section_id,
      outcome: t.outcome,
      tally_digest: t.tally_digest,
    })),
    corrections: corrections.map((c) => ({
      correction_id: c.correction_id,
      error_type: c.error_type,
      recomputed: c.recomputed.map((r) => ({ section_id: r.section_id, outcome: r.outcome, tally_digest: r.tally_digest })),
    })),
  });
}

export function renderMinutes(session, decisionId, { viewer, now }) {
  const decision = session.decisions.find((d) => d.decision_id === decisionId);
  if (!decision) throw new Error(`决定不存在: ${decisionId}`);
  const motion = session.motions.find((m) => m.motion_id === decision.motion_id);
  const tallies = session.tallies.filter((t) => t.decision_id === decisionId);
  const corrections = session.corrections.filter((c) => decision.correction_ids.includes(c.correction_id));

  // 附件来自本次计票引用的材料版本；按 viewer 权限过滤，被隐藏的只报数量
  const attachments = [];
  let withheld = 0;
  for (const tally of tallies) {
    for (const m of tally.materials) {
      const entry = session.governance.materials.find(
        (x) => x.material_id === m.material_id && x.version === m.version,
      );
      for (const att of entry?.attachments ?? []) {
        if (canSee(att, viewer)) {
          attachments.push({ material_id: m.material_id, ...att });
        } else {
          withheld += 1;
        }
      }
    }
  }

  const conditions = session.conditions
    .filter((c) => c.decision_id === decisionId)
    .map((c) => ({ ...c, effective_status: conditionStatusAt(c, now) }));

  const opinions = listMinorityOpinions(session, { motion_id: decision.motion_id });

  const minutes = {
    meeting: session.meeting,
    decision: {
      decision_id: decision.decision_id,
      motion_id: decision.motion_id,
      motion_title: motion?.title ?? null,
      motion_revision: decision.motion_revision,
      section_ids: decision.section_ids,
      overall_outcome: decision.overall_outcome,
      announced_at: decision.announced_at,
      declared_by: decision.declared_by,
    },
    generated_at: now,
    generated_for: viewer.party_id,
    sections: tallies.map((t) => ({
      section_id: t.section_id,
      section_revision: t.section_revision,
      outcome: t.outcome,
      counts: t.counts,
      participation: t.participation,
      quorum: t.quorum,
      threshold_check: t.threshold_check,
      // 计票采用的规则版本与有效成员集合：复算结论的全部输入
      rules: t.rules,
      rules_digest: t.rules_digest,
      eligible_voters: t.eligible_voters,
      materials: t.materials,
      ballot_accounting: t.ballot_accounting,
      ballots_counted: t.ballots_counted,
      minority_opinion_ids: t.minority_opinion_ids,
      tally_digest: t.tally_digest,
    })),
    conditions,
    minority_opinions: opinions,
    actions: session.actions.filter(
      (a) => a.motion_id === decision.motion_id || a.decision_id === decisionId,
    ),
    corrections,
    attachments,
    withheld_attachments: withheld,
  };
  minutes.conclusion_digest = conclusionDigest(decision, tallies, corrections);
  return minutes;
}

/**
 * 独立复算校验：
 * 1) 以记录当前状态在原宣布时点重算，逐章节比对计票摘要；
 * 2) 核对纪要列出的结论、规则版本与结论摘要。
 * 全部一致才视为“任何人复算都得到相同结论”。
 */
export function verifyMinutes(session, minutes) {
  const checks = verifyDecision(session, minutes.decision.decision_id);
  const recomputedOk = checks.every((c) => c.matches);
  const decision = session.decisions.find((d) => d.decision_id === minutes.decision.decision_id);
  const tallies = session.tallies.filter((t) => t.decision_id === decision.decision_id);
  const corrections = session.corrections.filter((c) => decision.correction_ids.includes(c.correction_id));
  const digestOk = conclusionDigest(decision, tallies, corrections) === minutes.conclusion_digest;
  const outcomeOk = minutes.sections.every((s) => {
    const check = checks.find((c) => c.section_id === s.section_id);
    return check && check.recomputed_outcome === s.outcome;
  });
  return {
    ok: recomputedOk && digestOk && outcomeOk,
    recomputed_ok: recomputedOk,
    digest_ok: digestOk,
    outcome_ok: outcomeOk,
    sections: checks,
  };
}
