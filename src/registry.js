import { audit } from './contracts.js';

/**
 * 秘书处登记入口：治理参数只能追加新版本，不能改写或删除既有条目。
 * 每个表要求一个稳定实体标识（member_id / rule_id / …），
 * 新版本沿用同一标识、给出新的 effective_from 与 version。
 */

const appendVersioned = (session, table, entry, required, at, kind) => {
  for (const field of required) {
    if (entry[field] === undefined || entry[field] === null) {
      throw new Error(`${table} 条目缺少 ${field}`);
    }
  }
  if (!Number.isInteger(entry.version) || entry.version < 1) {
    throw new Error(`${table} 条目 version 必须为正整数`);
  }
  if (!entry.effective_from) throw new Error(`${table} 条目缺少 effective_from`);
  session.governance[table].push({ ...entry });
  audit(session, at, kind, { id: required[0] ? entry[required[0]] : null, version: entry.version });
  return entry;
};

export const registerMembership = (s, e, at) =>
  appendVersioned(s, 'memberships', e, ['member_id', 'party_id'], at, 'membership_registered');

export const registerDelegation = (s, e, at) => {
  // 同一代表不得在重叠时段内持有两个席位，否则等于一人两票
  const start = Date.parse(e.effective_from);
  const end = e.effective_until ? Date.parse(e.effective_until) : Infinity;
  const clash = s.governance.delegations.find(
    (d) =>
      d.delegate_id === e.delegate_id &&
      d.member_id !== e.member_id &&
      Date.parse(d.effective_from) < end &&
      (!d.effective_until || Date.parse(d.effective_until) > start),
  );
  if (clash) {
    throw new Error(`代表 ${e.delegate_id} 已在重叠时段持有成员 ${clash.member_id} 的席位授权`);
  }
  return appendVersioned(s, 'delegations', e, ['member_id', 'delegate_id'], at, 'delegation_registered');
};

export const registerRecusal = (s, e, at) =>
  appendVersioned(s, 'recusals', e, ['recusal_id', 'member_id'], at, 'recusal_registered');

export const registerMaterial = (s, e, at) => {
  if (!e.material_id || !Number.isInteger(e.version)) {
    throw new Error('材料条目缺少 material_id 或 version');
  }
  if (!e.content_digest) {
    throw new Error('材料版本必须登记 content_digest（秘书处对原件取摘要）');
  }
  s.governance.materials.push({ ...e });
  audit(s, at, 'material_registered', { material_id: e.material_id, version: e.version, content_digest: e.content_digest });
  return e;
};

export const registerReviewWindow = (s, e, at) =>
  appendVersioned(s, 'review_windows', e, ['window_id', 'motion_id', 'opens_at', 'closes_at'], at, 'review_window_registered');

export const registerQuorumRule = (s, e, at) =>
  appendVersioned(s, 'quorum_rules', e, ['rule_id', 'kind'], at, 'quorum_rule_registered');

export const registerThreshold = (s, e, at) =>
  appendVersioned(s, 'thresholds', e, ['threshold_id', 'kind'], at, 'threshold_registered');

export const registerOfficer = (s, e, at) =>
  appendVersioned(s, 'officers', e, ['role', 'holder_id'], at, 'officer_registered');

export const registerAgendaScope = (s, e, at) =>
  appendVersioned(s, 'agenda_scopes', e, ['scope_id'], at, 'agenda_scope_registered');

/** 登记一次通知投递尝试的回执（成功或失败都落账，失败由待办持续列出）。 */
export function recordNotice(session, notice, at) {
  const entry = {
    notice_id: notice.notice_id,
    decision_id: notice.decision_id ?? null,
    action_id: notice.action_id ?? null,
    recipient_id: notice.recipient_id,
    channel: notice.channel ?? 'default',
    attempted_at: notice.attempted_at ?? at,
    status: notice.status, // delivered | failed
    failure_reason: notice.failure_reason ?? null,
    retry_of: notice.retry_of ?? null,
  };
  session.notices.push(entry);
  audit(session, at, 'notice_recorded', { notice_id: entry.notice_id, status: entry.status });
  return entry;
}
