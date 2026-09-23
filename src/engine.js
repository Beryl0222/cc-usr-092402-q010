import { canonicalJSON, digest } from './contracts.js';

/**
 * 议事计票引擎 —— 全部函数纯函数，只读取不可变记录。
 * 计票结果 = f(记录, 议题, 复算时点)，任一人在同一时点复算得到同一结论。
 */

export const ts = (s) => Date.parse(s);

/** 半开区间 [effective_from, effective_to) 内在 at 时点有效的条目。 */
export function activeAt(entries, at) {
  const t = ts(at);
  return entries.filter(
    (e) =>
      ts(e.effective_from) <= t &&
      (e.effective_to == null || t < ts(e.effective_to)),
  );
}

function scopeMatches(rule, topic) {
  const s = rule.scope ?? { kind: '*' };
  if (s.kind === '*') return true;
  if (s.kind === 'topic_kind') return s.value === topic.kind;
  if (s.kind === 'topic') return s.value === topic.topic_id;
  return false;
}

function scopeRank(rule, topic) {
  const s = rule.scope ?? { kind: '*' };
  if (s.kind === 'topic' && s.value === topic.topic_id) return 3;
  if (s.kind === 'topic_kind' && s.value === topic.kind) return 2;
  if (s.kind === '*') return 1;
  return 0;
}

function pickRule(entries, at, topic) {
  const cands = activeAt(entries, at)
    .filter((r) => scopeMatches(r, topic))
    .sort(
      (a, b) =>
        scopeRank(b, topic) - scopeRank(a, topic) ||
        ts(b.effective_from) - ts(a.effective_from) ||
        (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0),
    );
  return cands[0] ?? null;
}

export function getMotion(record, motionId) {
  const m = record.council.motions.find((x) => x.motion_id === motionId);
  if (!m) throw new Error(`议案不存在: ${motionId}`);
  return m;
}

export const issueKey = (topicId, revisionSeq) => `${topicId}@r${revisionSeq}`;

function recusalApplies(r, motionId, topicId) {
  const s = r.subject ?? { kind: 'motion', id: motionId };
  return (
    (s.kind === 'motion' && s.id === motionId) ||
    (s.kind === 'topic' && s.id === topicId)
  );
}

/**
 * at 时点某议题的有效席位集合。
 * 回避与资格（成员到期、授权到期/撤销）全部按该时点重算。
 */
export function eligibleSeats(record, motionId, topicId, at) {
  const c = record.council;
  const seated = activeAt(c.members, at);
  const recusedIds = new Set(
    activeAt(c.recusals, at)
      .filter((r) => recusalApplies(r, motionId, topicId))
      .map((r) => r.member_id),
  );
  // 同一授权人的有效授权取最晚生效的一条；授权到期或被关闭即消失。
  // 受权人本人在该议题被回避时，授权不可行使（防止借授权绕过回避）。
  const delegationFor = new Map();
  for (const d of activeAt(c.delegations, at)) {
    if (d.scope_topics && !d.scope_topics.includes(topicId)) continue;
    if (recusedIds.has(d.delegate_member_id)) continue;
    const prev = delegationFor.get(d.delegator_member_id);
    if (!prev || ts(d.effective_from) > ts(prev.effective_from)) {
      delegationFor.set(d.delegator_member_id, d);
    }
  }
  const seatedIds = new Set(seated.map((m) => m.member_id));
  return seated
    .filter((m) => !recusedIds.has(m.member_id))
    .map((m) => {
      const d = delegationFor.get(m.member_id);
      // 受权人自身已不在席 → 授权在该时点不可行使。
      const valid = d && seatedIds.has(d.delegate_member_id);
      return {
        seat_member_id: m.member_id,
        holder_member_id: valid ? d.delegate_member_id : m.member_id,
        delegation_id: valid ? d.delegation_id : null,
      };
    });
}

function windowForIssue(record, key, at) {
  const cands = record.council.review_windows.filter(
    (w) => w.issue_key === key || w.issue_key === null,
  );
  cands.sort(
    (a, b) =>
      ts(b.opens_at) - ts(a.opens_at) ||
      (a.window_id < b.window_id ? -1 : a.window_id > b.window_id ? 1 : 0),
  );
  const w = cands[0];
  if (!w) throw new Error(`议题 ${key} 缺少评议窗口`);
  return w;
}

/** 密封承诺：承诺值与揭示内容必须逐字节对应。 */
export function commitmentFor({ position, opinion = '', nonce, attachments = [] }) {
  return digest({ position, opinion, nonce, attachments });
}

/**
 * 计票。返回确定性计票包：
 *  - 未到揭示时点的密封票只计入 received_only，不参与任何统计
 *  - 同一席位（授权）多张票：序列最高者有效，其余剔除
 *  - 回避 / 资格 / 授权在 as_of 时点重算
 */
export function tallyIssue(record, motionId, topicId, asOf, opts = {}) {
  const c = record.council;
  const motion = getMotion(record, motionId);
  const topic = motion.topics.find((t) => t.topic_id === topicId);
  if (!topic) throw new Error(`议题不存在: ${topicId}`);
  // 更正旧宣布时按该宣布对应的修订复算，缺省为议题最新修订。
  const rev = opts.revision_seq ?? topic.last_changed_revision;
  const key = issueKey(topicId, rev);
  const window = windowForIssue(record, key, asOf);
  const seats = eligibleSeats(record, motionId, topicId, asOf);
  const seatById = new Map(seats.map((s) => [s.seat_member_id, s]));
  const quorumRule = pickRule(c.quorum_rules, asOf, topic);
  const thresholdRule = pickRule(c.threshold_rules, asOf, topic);
  if (!quorumRule) throw new Error(`议题 ${key} 在 ${asOf} 无法定人数规则生效`);
  if (!thresholdRule) throw new Error(`议题 ${key} 在 ${asOf} 无表决门槛规则生效`);

  const ballots = c.votes.filter((v) => v.issue_key === key);
  const evaluated = [];
  for (const v of ballots) {
    const note = (ok, reason) => ({ vote: v, ok, reason });
    if (v.window_id !== window.window_id) {
      evaluated.push(note(false, 'wrong_window'));
      continue;
    }
    if (ts(v.received_at) < ts(window.opens_at) || ts(v.received_at) > ts(window.closes_at)) {
      evaluated.push(note(false, 'outside_window'));
      continue;
    }
    if (!v.revealed) {
      evaluated.push(note(false, 'sealed_unopened')); // 开票前只能确认收讫
      continue;
    }
    if (ts(v.opened_at) > ts(asOf)) {
      evaluated.push(note(false, 'sealed_unopened'));
      continue;
    }
    // 解析该票实际行使的席位（本人席或被授权席）。
    let seatId = v.voter_member_id;
    if (v.delegation_id) {
      const d = c.delegations.find((x) => x.delegation_id === v.delegation_id);
      if (!d || !activeAt([d], asOf).length) { evaluated.push(note(false, 'delegation_inactive')); continue; }
      if (d.delegate_member_id !== v.voter_member_id) { evaluated.push(note(false, 'delegation_holder_mismatch')); continue; }
      seatId = d.delegator_member_id;
    }
    const seat = seatById.get(seatId);
    if (!seat) { evaluated.push(note(false, 'seat_ineligible')); continue; } // 回避或资格到期
    if (seat.holder_member_id !== v.voter_member_id) { evaluated.push(note(false, 'authorization_mismatch')); continue; }
    if (commitmentFor(v.reveal) !== v.commitment) { evaluated.push(note(false, 'commitment_mismatch')); continue; }
    evaluated.push({ vote: v, ok: true, seat: seatId });
  }

  // 同一席位只计一张：序列最高 → 收票最早 → vote_id 字典序。
  const winners = new Map();
  const excluded = [];
  for (const e of evaluated.filter((x) => x.ok)) {
    const cur = winners.get(e.seat);
    const cand = e.vote;
    const better =
      !cur ||
      cand.seq > cur.seq ||
      (cand.seq === cur.seq && ts(cand.received_at) < ts(cur.received_at)) ||
      (cand.seq === cur.seq && ts(cand.received_at) === ts(cur.received_at) && cand.vote_id < cur.vote_id);
    if (better) {
      if (cur) excluded.push({ vote_id: cur.vote_id, reason: 'superseded_within_seat' });
      winners.set(e.seat, cand);
    } else {
      excluded.push({ vote_id: cand.vote_id, reason: 'superseded_within_seat' });
    }
  }
  for (const e of evaluated.filter((x) => !x.ok && x.reason !== 'sealed_unopened')) {
    excluded.push({ vote_id: e.vote.vote_id, reason: e.reason });
  }
  const receivedOnly = evaluated
    .filter((x) => !x.ok && x.reason === 'sealed_unopened')
    .map((x) => ({ vote_id: x.vote.vote_id, received_at: x.vote.received_at }));

  const included = [...winners.values()];
  const counts = { approve: 0, disapprove: 0, abstain: 0 };
  for (const v of included) counts[v.reveal.position] += 1;
  const present = included.length;
  const eligible = seats.length;
  const seatedCount = activeAt(c.members, asOf).length;

  const qDen = quorumRule.basis === 'seated' ? seatedCount : eligible;
  const quorumRequired = Math.ceil((qDen * quorumRule.ratio_num) / quorumRule.ratio_den);
  const quorumMet = present >= quorumRequired;

  let outcome = 'failed_quorum';
  let thresholdPassed = false;
  let deadlock = false;
  if (quorumMet) {
    // present=含弃权的出席票；voting=只算赞成/反对（弃权不计入门槛分母）；eligible=全部有效席位
    const votingDen = counts.approve + counts.disapprove;
    const tDen =
      thresholdRule.basis === 'present' ? present :
      thresholdRule.basis === 'eligible' ? eligible : votingDen;
    // strict=严格超过（简单多数，平局不通过）；weak=达到即可（2/3 特别多数）。
    thresholdPassed =
      tDen > 0 &&
      (thresholdRule.mode === 'strict'
        ? counts.approve * thresholdRule.ratio_den > thresholdRule.ratio_num * tDen
        : counts.approve * thresholdRule.ratio_den >= thresholdRule.ratio_num * tDen);
    if (thresholdPassed) outcome = 'approved';
    // 赞成与反对持平且无人达到门槛 → 僵局（走升级程序），不等同于否决。
    else if (counts.approve === counts.disapprove) { deadlock = true; outcome = 'deadlock'; }
    else outcome = 'rejected';
  }

  const minority_opinions = included
    .filter((v) => v.reveal.position !== 'approve' && v.reveal.opinion)
    .map((v) => ({
      seat_member_id: v.delegation_id
        ? c.delegations.find((d) => d.delegation_id === v.delegation_id).delegator_member_id
        : v.voter_member_id,
      voter_member_id: v.voter_member_id,
      delegation_id: v.delegation_id,
      position: v.reveal.position,
      opinion: v.reveal.opinion,
      attachments: v.reveal.attachments ?? [],
    }));

  const bundle = {
    kind: 'tally_bundle',
    issue_key: key,
    motion_id: motionId,
    topic_id: topicId,
    revision_seq: rev,
    as_of: asOf,
    window: { window_id: window.window_id, opens_at: window.opens_at, closes_at: window.closes_at },
    materials: window.materials,
    rules: {
      quorum: { rule_id: quorumRule.rule_id, version_effective_from: quorumRule.effective_from },
      threshold: { rule_id: thresholdRule.rule_id, version_effective_from: thresholdRule.effective_from },
    },
    eligible_seats: seats,
    counts: {
      eligible,
      seated: seatedCount,
      present,
      quorum_required: quorumRequired,
      threshold_num: thresholdRule.ratio_num,
      threshold_den: thresholdRule.ratio_den,
      threshold_basis: thresholdRule.basis,
      threshold_mode: thresholdRule.mode ?? 'weak',
      ...counts,
    },
    quorum_met: quorumMet,
    threshold_passed: thresholdPassed,
    deadlock,
    outcome,
    included_votes: included.map((v) => v.vote_id).sort(),
    excluded_votes: excluded.sort((a, b) => (a.vote_id < b.vote_id ? -1 : 1)),
    received_only: receivedOnly.sort((a, b) => (a.vote_id < b.vote_id ? -1 : 1)),
    minority_opinions: minority_opinions.sort((a, b) =>
      a.seat_member_id < b.seat_member_id ? -1 : 1),
  };
  return { ...bundle, tally_digest: digest(bundle) };
}

/** 议题最后一次被修订触及的修订号；批准只在其之后的修订才需要重签。 */
export function lastChangedRevision(motion, topicId) {
  const t = motion.topics.find((x) => x.topic_id === topicId);
  return Math.max(1, ...t.affected_by_revisions);
}

/** 宣布结果的当前视图：沿公开更正链取最新结论，原宣布始终保留。 */
export function announcementView(record, announcementId) {
  const ann = record.council.announcements.find((a) => a.announcement_id === announcementId);
  if (!ann) throw new Error(`宣布记录不存在: ${announcementId}`);
  const chain = record.council.corrections
    .filter((x) => x.announcement_id === announcementId)
    .sort((a, b) => ts(a.issued_at) - ts(b.issued_at));
  const latest = chain[chain.length - 1] ?? null;
  return {
    announcement: ann,
    corrections: chain,
    original_outcome: ann.outcome,
    effective_outcome: latest ? latest.new_outcome : ann.outcome,
    effective_tally_digest: latest ? latest.tally_digest : ann.tally_digest,
  };
}

export function conditionStatus(record, cond, asOf) {
  if (cond.satisfied_at && ts(cond.satisfied_at) <= ts(asOf)) return 'satisfied';
  if (ts(asOf) > ts(cond.deadline)) return 'lapsed';
  return 'pending';
}

/** 安全紧急动作：作出即落账生效；追认按独立期限计算。 */
export function emergencyStatus(record, action, asOf) {
  const rat = (record.council.emergency_ratifications ?? [])
    .filter((r) => r.emergency_action_id === action.emergency_action_id && ts(r.ratified_at) <= ts(asOf))
    .sort((a, b) => ts(b.ratified_at) - ts(a.ratified_at))[0];
  let ratification = 'pending';
  if (rat) ratification = rat.outcome === 'approved' ? 'ratified' : 'rejected';
  else if (ts(asOf) > ts(action.ratification_deadline)) ratification = 'lapsed';
  return {
    effective: true,
    invoked_at: action.invoked_at,
    ratification,
    ratified_at: rat?.ratified_at ?? null,
  };
}

export function escalationStatus(esc, asOf) {
  if (esc.status === 'resolved') return { status: 'resolved', overdue: false };
  return { status: 'open', overdue: ts(asOf) > ts(esc.deadline) };
}

/** 秘书处待办：通知失败不阻断决定落账，但必须持续挂账。 */
export function secretaryTodos(record, asOf) {
  const todos = [];
  for (const n of record.council.notifications) {
    if (n.status === 'failed' && !n.resolved_at) {
      todos.push({ kind: 'notification_retry', ref: n.notification_id, about: n.about, last_error: n.last_error });
    }
  }
  for (const a of record.council.emergency_actions) {
    const s = emergencyStatus(record, a, asOf);
    if (s.ratification === 'lapsed') todos.push({ kind: 'emergency_ratification_lapsed', ref: a.emergency_action_id });
  }
  for (const e of record.council.escalations) {
    const s = escalationStatus(e, asOf);
    if (s.status === 'open' && s.overdue) todos.push({ kind: 'escalation_overdue', ref: e.escalation_id });
  }
  for (const cond of record.council.motions.flatMap((m) => m.conditions ?? [])) {
    if (conditionStatus(record, cond, asOf) === 'lapsed') todos.push({ kind: 'condition_lapsed', ref: cond.condition_id });
  }
  return todos;
}

/** 某议题当前批准状态：继续有效 / 需重签 / 无。修订只影响被触及议题。 */
export function approvalContinuity(record, motionId, asOf) {
  const motion = getMotion(record, motionId);
  const out = [];
  for (const t of motion.topics) {
    const lastChanged = lastChangedRevision(motion, t.topic_id);
    const anns = record.council.announcements
      .filter(
        (a) =>
          a.motion_id === motionId &&
          a.topic_id === t.topic_id &&
          ts(a.announced_at) <= ts(asOf),
      )
      .sort((a, b) => ts(b.announced_at) - ts(a.announced_at));
    const ann = anns[0] ?? null;
    let status = 'no_announcement';
    if (ann) {
      const view = announcementView(record, ann.announcement_id);
      if (ann.revision_seq < lastChanged) status = 'needs_resignature';
      else if (view.effective_outcome === 'approved') status = 'operative';
      else status = `not_operative:${view.effective_outcome}`;
    }
    out.push({
      topic_id: t.topic_id,
      last_changed_revision: lastChanged,
      latest_announcement_revision: ann?.revision_seq ?? null,
      status,
    });
  }
  return out;
}

function visibleTo(entry, viewerParty) {
  if (!viewerParty) return true;
  const list = entry.visible_to ?? ['*'];
  return list.includes('*') || list.includes(viewerParty);
}

function redactBody(full, viewerParty) {
  if (!viewerParty) return { body: full, hidden: [] };
  const body = structuredClone(full);
  const hidden = [];
  for (const m of body.materials) {
    m.attachments = m.attachments.filter((a) => {
      const ok = visibleTo(a, viewerParty);
      if (!ok) hidden.push(a.attachment_id);
      return ok;
    });
  }
  for (const i of body.issues) {
    for (const o of i.minority_opinions) {
      o.attachments = o.attachments.filter((a) => {
        const ok = visibleTo(a, viewerParty);
        if (!ok) hidden.push(a.attachment_id);
        return ok;
      });
    }
  }
  return { body, hidden: [...new Set(hidden)].sort() };
}

/**
 * 最终纪要。viewerParty=null 为全量版；指定合作方时隐藏其无权附件，
 * 但材料摘要、规则版本、有效成员集合、条件与少数意见始终完整列出。
 * full_digest 恒为未脱敏正文的哈希，任何观看者看到的该值都相同。
 */
export function renderMinutes(record, { as_of, viewer_party = null } = {}) {
  if (!as_of) throw new Error('纪要需要 as_of 时点');
  const c = record.council;

  const materials = c.materials
    .filter((m) => ts(m.published_at) <= ts(as_of))
    .sort((a, b) => (a.material_id < b.material_id ? -1 : 1))
    .map((m) => ({
      material_id: m.material_id,
      motion_id: m.motion_id,
      version_seq: m.version_seq,
      title: m.title,
      summary: m.summary, // 摘要对所有合作方完整
      sha256: m.sha256,
      superseded_at: m.superseded_at ?? null,
      attachments: m.attachments ?? [],
    }));

  const issues = [];
  for (const m of c.motions) {
    for (const t of m.topics) {
      const anns = c.announcements
        .filter((a) => a.motion_id === m.motion_id && a.topic_id === t.topic_id)
        .sort((a, b) => ts(a.announced_at) - ts(b.announced_at));
      for (const ann of anns) {
        const view = announcementView(record, ann.announcement_id);
        issues.push({
          motion_id: m.motion_id,
          topic_id: t.topic_id,
          topic_kind: t.kind,
          revision_seq: ann.revision_seq,
          announced_at: ann.announced_at,
          rules: ann.rules,
          window: ann.window,
          materials: ann.materials,
          eligible_seats: ann.eligible_seats,
          counts: ann.counts,
          outcome: ann.outcome,
          effective_outcome: view.effective_outcome,
          conditions: (ann.condition_ids ?? []).map((id) => {
            const cond = (m.conditions ?? []).find((x) => x.condition_id === id);
            return {
              condition_id: id,
              text: cond.text,
              deadline: cond.deadline,
              satisfied_at: cond.satisfied_at ?? null,
              status: conditionStatus(record, cond, as_of),
            };
          }),
          minority_opinions: ann.minority_opinions.map((o) => ({ ...o, attachments: o.attachments ?? [] })),
          corrections: view.corrections.map((x) => ({
            correction_id: x.correction_id,
            issued_at: x.issued_at,
            kind: x.kind,
            explanation: x.explanation,
            old_outcome: x.old_outcome,
            new_outcome: x.new_outcome,
            tally_digest: x.tally_digest,
          })),
        });
      }
    }
  }
  issues.sort((a, b) =>
    a.announced_at === b.announced_at
      ? a.topic_id < b.topic_id ? -1 : 1
      : ts(a.announced_at) - ts(b.announced_at),
  );

  const full = {
    kind: 'committee_minutes',
    record_id: record.record_id,
    schema_version: 2,
    as_of,
    materials,
    issues,
    escalations: c.escalations
      .map((e) => ({ ...e, ...escalationStatus(e, as_of) }))
      .sort((a, b) => (a.escalation_id < b.escalation_id ? -1 : 1)),
    emergency_actions: c.emergency_actions
      .map((a) => ({
        emergency_action_id: a.emergency_action_id,
        topic_id: a.topic_id,
        authority: a.authority,
        invoked_at: a.invoked_at,
        basis: a.basis,
        ...emergencyStatus(record, a, as_of),
      }))
      .sort((a, b) => (a.emergency_action_id < b.emergency_action_id ? -1 : 1)),
    notifications: c.notifications
      .map((n) => ({
        notification_id: n.notification_id,
        about: n.about,
        channel: n.channel,
        status: n.status,
        attempts: n.attempts.length,
        resolved_at: n.resolved_at ?? null,
      }))
      .sort((a, b) => (a.notification_id < b.notification_id ? -1 : 1)),
    secretary_todos: secretaryTodos(record, as_of),
  };

  const full_digest = digest(full);
  const { body, hidden } = redactBody(full, viewer_party);
  return {
    ...body,
    redaction: { viewer_party, hidden_attachments: hidden },
    full_digest,
    view_digest: digest({ ...body, viewer_party }),
  };
}

export { canonicalJSON, digest };
