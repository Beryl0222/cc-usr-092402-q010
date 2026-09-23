import { canonicalize, digest } from './contracts.js';

/**
 * 治理参数全部以“带生效时间的版本条目”保存（只增不改）：
 * 修正参数不是覆盖旧条目，而是追加 effective_from 更新的新版本；
 * 解析任一时点 t 时，同一实体（成员、授权、规则……）取 effective_from <= t 的最高版本，
 * 再判定该版本在 t 时是否仍然有效（未到期、未停用）。
 * 资格到期因此表现为“最新版本已失效”，而不是回落到旧版本。
 * 同一时刻重放历史，必定得到同一组参数。
 */

const latestByKey = (entries, keyFn, at) => {
  const best = new Map();
  for (const e of entries) {
    if (Date.parse(e.effective_from) > Date.parse(at)) continue;
    const key = keyFn(e);
    const cur = best.get(key);
    const newer =
      !cur ||
      Date.parse(cur.effective_from) < Date.parse(e.effective_from) ||
      (Date.parse(cur.effective_from) === Date.parse(e.effective_from) && (cur.version ?? 1) <= (e.version ?? 1));
    if (newer) best.set(key, e);
  }
  return [...best.values()];
};

const isActive = (e, at) =>
  (e.status === undefined || e.status === 'active') &&
  (!e.effective_until || Date.parse(e.effective_until) > Date.parse(at));

const resolve = (entries, keyFn, at) => latestByKey(entries, keyFn, at).filter((e) => isActive(e, at));

/** 成员本人席位授权号；授权代表也投到该席位号下，从源头防止重复计票。 */
export const seatAuthorization = (memberId) => `seat:${memberId}`;

/** 成员资格：回避/资格到期重算时据此缩小有效成员集合。 */
export function activeMemberList(governance, at) {
  return resolve(governance.memberships, (m) => m.member_id, at).sort((a, b) =>
    a.member_id.localeCompare(b.member_id),
  );
}

/**
 * 回避关系：可按整个议案或其中若干章节披露。
 * 临时披露（effective_from 落在表决之后、宣布之前）会即时改变有效集合。
 */
export function isRecused(governance, memberId, { motion_id, section_id = null }, at) {
  return resolve(governance.recusals, (r) => r.recusal_id, at).some(
    (r) =>
      r.member_id === memberId &&
      (!r.motion_id || r.motion_id === motion_id) &&
      (!r.sections || r.sections.length === 0 || (section_id != null && r.sections.includes(section_id))),
  );
}

/** 解析某席位在时点 t 的当前持票人（成员本人或生效中的授权代表）。 */
export function holderOf(governance, authorizationId, at) {
  if (!authorizationId.startsWith('seat:')) return null;
  const memberId = authorizationId.slice('seat:'.length);
  const member = activeMemberList(governance, at).find((m) => m.member_id === memberId);
  if (!member) return null;
  const delegation = resolve(governance.delegations, (d) => d.member_id, at).find(
    (d) => d.member_id === memberId,
  );
  if (delegation) {
    return { authorization_id: authorizationId, holder_id: delegation.delegate_id, via: 'delegation', entry: delegation };
  }
  return { authorization_id: authorizationId, holder_id: memberId, via: 'seat', entry: member };
}

// 规则类解析：同主题下，显式声明 topics 的专用规则优先于通用规则，其次取生效时间新者。
const pickRule = (rules, topic) => {
  const matching = rules.filter((r) => !r.topics || r.topics.length === 0 || r.topics.includes(topic));
  return (
    matching.sort((a, b) => {
      const specA = a.topics && a.topics.length > 0 ? 1 : 0;
      const specB = b.topics && b.topics.length > 0 ? 1 : 0;
      if (specA !== specB) return specB - specA;
      return Date.parse(b.effective_from) - Date.parse(a.effective_from);
    })[0] ?? null
  );
};

export function quorumRuleFor(governance, topic, at) {
  return pickRule(resolve(governance.quorum_rules, (r) => r.rule_id, at), topic);
}

export function thresholdFor(governance, topic, at, actionKind = 'ordinary') {
  const rules = resolve(governance.thresholds, (t) => t.threshold_id, at).filter(
    (r) => !r.action_kinds || r.action_kinds.length === 0 || r.action_kinds.includes(actionKind),
  );
  return pickRule(rules, topic);
}

export function reviewWindowFor(governance, motionId, sectionId, at) {
  const windows = resolve(governance.review_windows, (w) => w.window_id, at).filter(
    (w) => w.motion_id === motionId && (!w.sections || w.sections.length === 0 || (sectionId != null && w.sections.includes(sectionId))),
  );
  return (
    windows.sort((a, b) => {
      const specA = a.sections && a.sections.length > 0 ? 1 : 0;
      const specB = b.sections && b.sections.length > 0 ? 1 : 0;
      if (specA !== specB) return specB - specA;
      return Date.parse(b.effective_from) - Date.parse(a.effective_from);
    })[0] ?? null
  );
}

export function materialFor(governance, materialId, at) {
  return resolve(governance.materials.filter((m) => m.material_id === materialId), (m) => m.material_id, at)[0] ?? null;
}

/** 议案章节在该时点可见的材料版本集合（含章节专属与议案级材料）。 */
export function materialsFor(governance, motionId, sectionId, at) {
  return resolve(governance.materials, (m) => m.material_id, at)
    .filter((m) => (!m.motion_id || m.motion_id === motionId) && (!m.section_id || m.section_id === sectionId))
    .sort((a, b) => a.material_id.localeCompare(b.material_id));
}

export function officerFor(governance, role, at) {
  return resolve(governance.officers.filter((o) => o.role === role), (o) => o.role, at)[0] ?? null;
}

/** 议题范围：章节必须在会议议程收录范围内才可付诸表决。 */
export function inAgendaScope(governance, topic, motionId, sectionId, at) {
  return resolve(governance.agenda_scopes, (s) => s.scope_id, at).some(
    (s) =>
      (!s.topics || s.topics.length === 0 || s.topics.includes(topic)) &&
      (!s.motion_id || s.motion_id === motionId) &&
      (!s.sections || s.sections.length === 0 || (sectionId != null && s.sections.includes(sectionId))),
  );
}

/**
 * 某议案章节在时点 t 的有效成员集合：
 * 资格有效、未就该章节回避、且其席位持票人可确定。
 */
export function eligibleVoters(governance, { motion_id, section_id = null }, at) {
  return activeMemberList(governance, at)
    .filter((m) => m.role !== 'observer') // 观察员在册但无表决权
    .filter((m) => !isRecused(governance, m.member_id, { motion_id, section_id }, at))
    .map((m) => holderOf(governance, seatAuthorization(m.member_id), at))
    .filter(Boolean)
    .sort((a, b) => a.authorization_id.localeCompare(b.authorization_id));
}

/** 参与计票所需的全部参数解析结果，附版本清单供纪要与复算引用。 */
export function governanceSnapshot(governance, scope, at, actionKind = 'ordinary') {
  const voters = eligibleVoters(governance, scope, at);
  const quorum_rule = quorumRuleFor(governance, scope.topic, at);
  const threshold = thresholdFor(governance, scope.topic, at, actionKind);
  const review_window = reviewWindowFor(governance, scope.motion_id, scope.section_id, at);
  const materials = materialsFor(governance, scope.motion_id, scope.section_id, at);
  const in_agenda = scope.topic
    ? inAgendaScope(governance, scope.topic, scope.motion_id, scope.section_id, at)
    : true;
  const versions = {
    memberships: resolve(governance.memberships, (m) => m.member_id, at).map((m) => `${m.member_id}:v${m.version ?? 1}`),
    recusals: resolve(governance.recusals, (r) => r.recusal_id, at).map((r) => `${r.recusal_id}:v${r.version ?? 1}`),
    delegations: resolve(governance.delegations, (d) => d.authorization_id, at).map((d) => `${d.authorization_id}:v${d.version ?? 1}`),
    quorum_rule: quorum_rule ? `${quorum_rule.rule_id}:v${quorum_rule.version ?? 1}` : null,
    threshold: threshold ? `${threshold.threshold_id}:v${threshold.version ?? 1}` : null,
    review_window: review_window ? `${review_window.window_id}:v${review_window.version ?? 1}` : null,
    materials: materials.map((m) => `${m.material_id}:v${m.version}`),
  };
  return {
    at,
    scope,
    action_kind: actionKind,
    voters,
    quorum_rule,
    threshold,
    review_window,
    materials,
    in_agenda,
    versions,
    rules_digest: digest(canonicalize({ quorum_rule, threshold, review_window, versions })),
  };
}
