import { SCHEMA_VERSION, digest } from './contracts.js';
import {
  tallyIssue,
  commitmentFor,
  announcementView,
  issueKey,
  ts,
} from './engine.js';

/**
 * 只追加议事簿构建器。
 * 所有“变更”都是追加事实（新区间 / 新版本 / 新宣布 / 更正），
 * 从不改写既有事实；区间类事实通过关闭旧区间实现更替。
 */
export function createCouncil({ record_id, name = '联合药研委员会', occurred_at }) {
  return {
    schema_version: SCHEMA_VERSION,
    record_id,
    domain: 'drug_council',
    occurred_at,
    revision: 1,
    source: '议事流程样例',
    council: {
      committee_id: record_id,
      name,
      timeline: [],
      members: [],
      delegations: [],
      topic_scopes: [],
      recusals: [],
      materials: [],
      review_windows: [],
      quorum_rules: [],
      threshold_rules: [],
      motions: [],
      votes: [],
      announcements: [],
      corrections: [],
      escalations: [],
      emergency_actions: [],
      emergency_ratifications: [],
      notifications: [],
    },
  };
}

let seq = 0;
const id = (p) => `${p}-${(++seq).toString(16).padStart(4, '0')}`;

function log(record, at, type, detail) {
  record.council.timeline.push({ at, type, detail, event_id: id('EV') });
}

function closeOpen(entries, match, at) {
  for (const e of entries) {
    if (e.effective_to == null && match(e) && ts(e.effective_from) < ts(at)) e.effective_to = at;
  }
}

// ── 成员资格（按生效时间） ─────────────────────────────────────────
export function seatMember(record, { member_id, party, role, effective_from, effective_to = null }) {
  record.council.members.push({ member_id, party, role, effective_from, effective_to });
  log(record, effective_from, 'member_seated', { member_id, party });
}

export function unseatMember(record, member_id, at) {
  closeOpen(record.council.members, (m) => m.member_id === member_id, at);
  log(record, at, 'member_unseated', { member_id });
}

// ── 授权代表（区间可撤销，到期自动失效） ───────────────────────────
export function delegate(record, d) {
  const entry = {
    delegation_id: d.delegation_id ?? id('DLG'),
    delegator_member_id: d.delegator_member_id,
    delegate_member_id: d.delegate_member_id,
    scope_topics: d.scope_topics ?? null, // null = 全部议题
    effective_from: d.effective_from,
    effective_to: d.effective_to ?? null,
  };
  record.council.delegations.push(entry);
  log(record, d.effective_from, 'delegation_granted', {
    delegation_id: entry.delegation_id,
    delegator: entry.delegator_member_id,
    delegate: entry.delegate_member_id,
  });
  return entry.delegation_id;
}

export function revokeDelegation(record, delegation_id, at) {
  closeOpen(record.council.delegations, (x) => x.delegation_id === delegation_id, at);
  log(record, at, 'delegation_revoked', { delegation_id });
}

// ── 议题范围与规则版本（区间化，规则本身带版本号） ──────────────────
export function addTopicScope(record, s) {
  record.council.topic_scopes.push({
    scope_id: s.scope_id ?? id('SCP'),
    topic_id: s.topic_id,
    kind: s.kind,
    title: s.title,
    effective_from: s.effective_from,
    effective_to: s.effective_to ?? null,
  });
}

export function addQuorumRule(record, r) {
  // 同一适用范围在新生效时点的规则取代旧版：旧版关闭区间，永不删除。
  closeOpen(
    record.council.quorum_rules,
    (x) => JSON.stringify(x.scope) === JSON.stringify(r.scope ?? { kind: '*' }),
    r.effective_from,
  );
  record.council.quorum_rules.push({
    rule_id: r.rule_id ?? id('QR'),
    scope: r.scope ?? { kind: '*' },
    basis: r.basis, // 'eligible'（扣回避后）| 'seated'（全体在席）
    ratio_num: r.ratio_num,
    ratio_den: r.ratio_den,
    effective_from: r.effective_from,
    effective_to: null,
  });
}

export function addThresholdRule(record, r) {
  closeOpen(
    record.council.threshold_rules,
    (x) => JSON.stringify(x.scope) === JSON.stringify(r.scope ?? { kind: '*' }),
    r.effective_from,
  );
  record.council.threshold_rules.push({
    rule_id: r.rule_id ?? id('TR'),
    scope: r.scope ?? { kind: '*' },
    basis: r.basis, // 'present' | 'voting' | 'eligible'
    mode: r.mode ?? 'weak', // 'strict'=严格超过；'weak'=达到即可
    ratio_num: r.ratio_num,
    ratio_den: r.ratio_den,
    effective_from: r.effective_from,
    effective_to: null,
  });
}

// ── 回避关系（临时披露：在披露时点生效，可解除） ────────────────────
export function discloseRecusal(record, r) {
  const entry = {
    recusal_id: r.recusal_id ?? id('RCU'),
    member_id: r.member_id,
    subject: r.subject, // {kind:'motion'|'topic', id}
    reason: r.reason,
    disclosed_at: r.disclosed_at,
    effective_from: r.effective_from ?? r.disclosed_at,
    effective_to: null,
  };
  record.council.recusals.push(entry);
  log(record, entry.disclosed_at, 'recusal_disclosed', {
    recusal_id: entry.recusal_id,
    member_id: entry.member_id,
    subject: entry.subject,
  });
  return entry.recusal_id;
}

export function releaseRecusal(record, recusal_id, at) {
  closeOpen(record.council.recusals, (x) => x.recusal_id === recusal_id, at);
  log(record, at, 'recusal_released', { recusal_id });
}

// ── 材料版本（不可变新版本；窗口钉住具体版本） ─────────────────────
export function publishMaterial(record, m) {
  const entry = {
    material_id: m.material_id,
    motion_id: m.motion_id,
    version_seq: m.version_seq,
    supersedes: m.supersedes ?? null,
    title: m.title,
    summary: m.summary,
    body: m.body,
    attachments: m.attachments ?? [], // {attachment_id, title, visible_to:[party|'*']}
    sha256: m.sha256 ?? digest(m.body ?? ''),
    published_at: m.published_at,
  };
  record.council.materials.push(entry);
  if (m.supersedes != null) {
    const prior = record.council.materials.find(
      (x) => x.material_id === m.material_id && x.version_seq === m.supersedes,
    );
    if (prior) prior.superseded_at = m.published_at;
  }
  log(record, m.published_at, 'material_published', {
    material_id: entry.material_id,
    version_seq: entry.version_seq,
  });
  return entry;
}

// ── 议案与修订 ─────────────────────────────────────────────────────
export function createMotion(record, m) {
  const entry = {
    motion_id: m.motion_id,
    title: m.title,
    current_revision: 1,
    revisions: [{ revision_seq: 1, at: m.opened_at, changed_topic_ids: [], note: '立案' }],
    opened_at: m.opened_at,
    topics: m.topics.map((t) => ({
      topic_id: t.topic_id,
      kind: t.kind, // milestone_payment | protocol_change | safety | ratification
      title: t.title,
      affected_by_revisions: [1],
      last_changed_revision: 1,
    })),
    conditions: [],
  };
  record.council.motions.push(entry);
  log(record, m.opened_at, 'motion_created', { motion_id: entry.motion_id });
  return entry;
}

/** 议案修订：只登记被触及的议题；未触及议题既有批准继续有效。 */
export function reviseMotion(record, motion_id, { revision_seq, at, changed_topic_ids, note }) {
  const motion = record.council.motions.find((x) => x.motion_id === motion_id);
  if (revision_seq !== motion.current_revision + 1) throw new Error('议案修订号必须连续');
  motion.current_revision = revision_seq;
  motion.revisions.push({ revision_seq, at, changed_topic_ids, note });
  for (const t of motion.topics) {
    if (changed_topic_ids.includes(t.topic_id)) {
      t.affected_by_revisions.push(revision_seq);
      t.last_changed_revision = revision_seq;
    }
  }
  log(record, at, 'motion_revised', { motion_id, revision_seq, changed_topic_ids, note });
}

export function addCondition(record, motion_id, c) {
  const motion = record.council.motions.find((x) => x.motion_id === motion_id);
  motion.conditions.push({
    condition_id: c.condition_id ?? id('CND'),
    topic_id: c.topic_id,
    text: c.text,
    deadline: c.deadline,
    satisfied_at: null,
  });
}

export function satisfyCondition(record, motion_id, condition_id, at) {
  const cond = record.council.motions
    .find((x) => x.motion_id === motion_id).conditions
    .find((x) => x.condition_id === condition_id);
  cond.satisfied_at = at;
  log(record, at, 'condition_satisfied', { condition_id });
}

// ── 评议窗口（钉住材料版本清单） ───────────────────────────────────
export function openWindow(record, { issue_key, opens_at, closes_at, materials }) {
  const w = {
    window_id: id('WIN'),
    issue_key,
    opens_at,
    closes_at,
    materials: materials.map((m) => ({
      material_id: m.material_id,
      version_seq: m.version_seq,
      sha256: m.sha256,
    })),
  };
  record.council.review_windows.push(w);
  log(record, opens_at, 'window_opened', { window_id: w.window_id, issue_key });
  return w.window_id;
}

// ── 密封意见：承诺-揭示；开票前系统只持有承诺与收讫事实 ──────────────
export function submitSealed(record, v) {
  const entry = {
    vote_id: v.vote_id ?? id('VOT'),
    issue_key: v.issue_key,
    window_id: v.window_id,
    voter_member_id: v.voter_member_id,
    delegation_id: v.delegation_id ?? null,
    seq: v.seq,
    received_at: v.received_at,
    channel: v.channel ?? 'secure_drop',
    commitment: v.commitment, // sha256(canonical({position,opinion,nonce,attachments}))
    revealed: false,
    reveal: null,
    opened_at: null,
  };
  record.council.votes.push(entry);
  // 开票房前只能给出收讫确认，不泄露任何意见内容。
  return {
    receipt: {
      vote_id: entry.vote_id,
      issue_key: entry.issue_key,
      seq: entry.seq,
      received_at: entry.received_at,
      commitment: entry.commitment,
      status: 'received_sealed',
    },
  };
}

/** 离线端本地构造承诺，提交时只发送 commitment。 */
export function sealEnvelope({ position, opinion = '', nonce, attachments = [] }) {
  const reveal = { position, opinion, nonce, attachments };
  return { commitment: commitmentFor(reveal), reveal };
}

export function revealVote(record, vote_id, reveal, opened_at) {
  const v = record.council.votes.find((x) => x.vote_id === vote_id);
  if (v.revealed) throw new Error('密封意见不得重复揭示');
  if (commitmentFor(reveal) !== v.commitment) {
    throw new Error(`揭示内容与密封承诺不符: ${vote_id}`);
  }
  v.revealed = true;
  v.reveal = reveal;
  v.opened_at = opened_at;
  log(record, opened_at, 'vote_revealed', { vote_id, seq: v.seq });
}

// ── 宣布：冻结当时的完整计票包 ─────────────────────────────────────
export function announce(record, motion_id, topic_id, { as_of, condition_ids = [] }) {
  const motion = record.council.motions.find((x) => x.motion_id === motion_id);
  const topic = motion.topics.find((x) => x.topic_id === topic_id);
  const tally = tallyIssue(record, motion_id, topic_id, as_of);
  if (ts(as_of) < ts(tally.window.closes_at)) throw new Error('评议窗口未关闭，不得宣布');
  if (tally.outcome === 'failed_quorum' && condition_ids.length) {
    throw new Error('未达法定人数不能附条件批准');
  }
  const entry = {
    announcement_id: id('ANN'),
    motion_id,
    topic_id,
    issue_key: tally.issue_key,
    revision_seq: tally.revision_seq,
    announced_at: as_of,
    outcome: tally.outcome,
    tally_digest: tally.tally_digest,
    rules: tally.rules,
    window: tally.window,
    materials: tally.materials,
    eligible_seats: tally.eligible_seats,
    counts: tally.counts,
    included_votes: tally.included_votes,
    excluded_votes: tally.excluded_votes,
    received_only: tally.received_only,
    minority_opinions: tally.minority_opinions,
    condition_ids,
    tally_snapshot: stripDigest(tally),
  };
  record.council.announcements.push(entry);
  log(record, as_of, 'result_announced', {
    announcement_id: entry.announcement_id,
    issue_key: tally.issue_key,
    outcome: tally.outcome,
  });
  return entry;
}

function stripDigest(t) {
  const { tally_digest, ...rest } = t;
  return rest;
}

/**
 * 公开更正：宣布之后的任何错误不得静默改写，只能追加更正，
 * 并在更正中给出按新时点复算的计票包与哈希。
 */
export function correctAnnouncement(record, announcement_id, { issued_at, kind, explanation, recount_as_of }) {
  const ann = record.council.announcements.find((a) => a.announcement_id === announcement_id);
  if (!ann) throw new Error('宣布记录不存在');
  const retally = tallyIssue(record, ann.motion_id, ann.topic_id, recount_as_of, {
    revision_seq: ann.revision_seq,
  });
  const entry = {
    correction_id: id('COR'),
    announcement_id,
    issued_at,
    kind, // tally_recount | rule_version | eligibility | clerical
    explanation,
    old_outcome: ann.outcome,
    new_outcome: retally.outcome,
    tally_digest: retally.tally_digest,
    recount_as_of,
  };
  record.council.corrections.push(entry);
  log(record, issued_at, 'announcement_corrected', {
    correction_id: entry.correction_id,
    announcement_id,
    kind,
    old_outcome: entry.old_outcome,
    new_outcome: entry.new_outcome,
  });
  return { correction: entry, view: announcementView(record, announcement_id), retally };
}

// ── 僵局升级 ───────────────────────────────────────────────────────
export function openEscalation(record, e) {
  const entry = {
    escalation_id: e.escalation_id ?? id('ESC'),
    issue_key: e.issue_key,
    motion_id: e.motion_id,
    tier: e.tier, // 1=联合指导委员会；2=发起人科学委员会
    authority: e.authority,
    opened_at: e.opened_at,
    deadline: e.deadline, // 本级必须在此前裁决
    status: 'open',
    resolution: null,
    resolved_at: null,
  };
  record.council.escalations.push(entry);
  log(record, e.opened_at, 'escalation_opened', { escalation_id: entry.escalation_id, tier: e.tier });
  return entry.escalation_id;
}

export function resolveEscalation(record, escalation_id, { resolution, at }) {
  const e = record.council.escalations.find((x) => x.escalation_id === escalation_id);
  e.status = 'resolved';
  e.resolution = resolution;
  e.resolved_at = at;
  log(record, at, 'escalation_resolved', { escalation_id, resolution });
}

// ── 安全紧急动作（独立权限，先落账后追认） ──────────────────────────
export function invokeEmergency(record, a) {
  const entry = {
    emergency_action_id: a.emergency_action_id ?? id('EMR'),
    topic_id: a.topic_id,
    title: a.title,
    authority: a.authority, // 安全监察官 / DSMB
    invoked_at: a.invoked_at,
    basis: a.basis,
    action: a.action, // safety_hold 等
    ratification_window: { opens_at: a.ratification_window.opens_at, closes_at: a.ratification_window.closes_at },
    ratification_deadline: a.ratification_deadline,
  };
  record.council.emergency_actions.push(entry);
  log(record, a.invoked_at, 'emergency_invoked', {
    emergency_action_id: entry.emergency_action_id,
    action: entry.action,
  });
  return entry.emergency_action_id;
}

/** 追认是一次普通委员会投票（独立议题、独立窗口），结果回填到紧急动作。 */
export function recordRatification(record, emergency_action_id, { ratification_issue_key, ratified_at }) {
  const action = record.council.emergency_actions.find((x) => x.emergency_action_id === emergency_action_id);
  const ann = record.council.announcements.find((a) => a.issue_key === ratification_issue_key);
  if (!ann) throw new Error('追认议题尚无宣布结果');
  const entry = {
    ratification_id: id('RAT'),
    emergency_action_id,
    issue_key: ratification_issue_key,
    announcement_id: ann.announcement_id,
    outcome: ann.outcome === 'approved' ? 'approved' : 'rejected',
    tally_digest: ann.tally_digest,
    ratified_at,
    within_deadline: ts(ratified_at) <= ts(action.ratification_deadline),
  };
  record.council.emergency_ratifications.push(entry);
  log(record, ratified_at, 'emergency_ratified', {
    emergency_action_id,
    outcome: entry.outcome,
    within_deadline: entry.within_deadline,
  });
}

// ── 通知（投递失败不阻断决定落账；持续挂秘书处待办） ────────────────
export function registerNotification(record, n) {
  const entry = {
    notification_id: n.notification_id ?? id('NTF'),
    about: n.about, // {kind:'announcement'|'correction'|..., id}
    channel: n.channel,
    attempts: n.attempts, // [{at, ok, error?}]
    status: n.status, // delivered | failed
    resolved_at: n.resolved_at ?? null,
  };
  record.council.notifications.push(entry);
  return entry.notification_id;
}

export function resolveNotification(record, notification_id, at) {
  const n = record.council.notifications.find((x) => x.notification_id === notification_id);
  n.resolved_at = at;
  n.status = 'delivered';
}

export { issueKey, tallyIssue };
