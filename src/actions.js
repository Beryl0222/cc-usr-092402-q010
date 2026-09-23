import { audit, atBefore } from './contracts.js';
import { officerFor } from './governance.js';

/**
 * 三类特别行动各自遵循独立的权限与期限，互不借用普通表决的规则：
 * - 僵局升级：仅已宣布为僵局（或被否决）的决定可升级，由指定职权的成员在期限内裁断；
 * - 条件性批准：宣布时落账的条件由责任方在期限内履行，逾期自动进入待办；
 * - 安全紧急动作：安全官可不等表决直接采取措施，但须在期限内由主席代表委员会追认。
 * 期限到达而未处理不静默失效：状态转为 expired/overdue 并持续列入秘书处待办。
 */

function getAction(session, actionId, kind) {
  const action = session.actions.find((a) => a.action_id === actionId);
  if (!action || action.kind !== kind) throw new Error(`行动不存在或类型不符: ${actionId}`);
  return action;
}

// ---- 僵局升级 ----

export function escalateDeadlock(session, { action_id, decision_id, escalate_to_role, opened_by, due_at, now }) {
  const decision = session.decisions.find((d) => d.decision_id === decision_id);
  if (!decision) throw new Error(`决定不存在: ${decision_id}`);
  if (!['deadlocked', 'rejected'].includes(decision.overall_outcome)) {
    throw new Error('仅僵局或被否决的决定可以升级');
  }
  if (session.actions.some((a) => a.kind === 'deadlock_escalation' && a.decision_id === decision_id && a.status === 'open')) {
    throw new Error('该决定已有进行中的升级');
  }
  const action = {
    action_id,
    kind: 'deadlock_escalation',
    decision_id,
    escalate_to_role,
    opened_by,
    opened_at: now,
    due_at,
    status: 'open',
    resolution: null,
  };
  session.actions.push(action);
  audit(session, now, 'escalation_opened', { action_id, decision_id, escalate_to_role, due_at });
  return action;
}

export function resolveEscalation(session, action_id, { ruling, resolved_by, now }) {
  const action = getAction(session, action_id, 'deadlock_escalation');
  if (action.status !== 'open') throw new Error('升级已关闭');
  if (atBefore(action.due_at, now)) {
    action.status = 'expired';
    audit(session, now, 'escalation_expired', { action_id });
    throw new Error('升级已逾裁断期限');
  }
  const officer = officerFor(session.governance, action.escalate_to_role, now);
  if (!officer || officer.holder_id !== resolved_by) {
    throw new Error(`成员 ${resolved_by} 不具职权 ${action.escalate_to_role}`);
  }
  action.status = 'resolved';
  action.resolution = { ruling, resolved_by, resolved_at: now };
  audit(session, now, 'escalation_resolved', { action_id, ruling });
  return action;
}

// ---- 条件性批准 ----

export function fulfillCondition(session, condition_id, { fulfilled_by, evidence_digest = null, now }) {
  const condition = session.conditions.find((c) => c.condition_id === condition_id);
  if (!condition) throw new Error(`条件不存在: ${condition_id}`);
  if (condition.status !== 'open') throw new Error('条件已关闭');
  if (atBefore(condition.due_at, now)) {
    condition.status = 'expired';
    audit(session, now, 'condition_expired', { condition_id });
    throw new Error('条件已逾履行期限');
  }
  condition.status = 'fulfilled';
  condition.fulfilled_by = fulfilled_by;
  condition.fulfilled_at = now;
  condition.evidence_digest = evidence_digest;
  audit(session, now, 'condition_fulfilled', { condition_id, fulfilled_by });
  return condition;
}

// ---- 安全紧急动作 ----

export function safetyEmergencyAction(session, { action_id, actor_id, role = 'safety_officer', motion_id = null, section_id = null, measure, reason, review_by, now }) {
  if (!['pause', 'resume', 'restrict'].includes(measure)) {
    throw new Error('安全紧急动作仅支持 pause / resume / restrict');
  }
  const officer = officerFor(session.governance, role, now);
  if (!officer || officer.holder_id !== actor_id) {
    throw new Error(`成员 ${actor_id} 不具职权 ${role}，不能采取安全紧急动作`);
  }
  const action = {
    action_id,
    kind: 'safety_emergency',
    motion_id,
    section_id,
    measure,
    reason,
    actor_id,
    role,
    acted_at: now,
    review_by,
    status: 'active',
    ratification: null,
  };
  session.actions.push(action);
  audit(session, now, 'safety_emergency_acted', { action_id, measure, actor_id, review_by });
  return action;
}

export function ratifySafetyAction(session, action_id, { ratified_by, now }) {
  const action = getAction(session, action_id, 'safety_emergency');
  if (action.status !== 'active') throw new Error('动作已关闭');
  if (atBefore(action.review_by, now)) {
    action.status = 'overdue';
    audit(session, now, 'safety_action_overdue', { action_id });
    throw new Error('已超过委员会追认期限');
  }
  const chair = officerFor(session.governance, 'chair', now);
  if (!chair || chair.holder_id !== ratified_by) {
    throw new Error('仅主席可代表委员会追认安全紧急动作');
  }
  action.status = 'ratified';
  action.ratification = { ratified_by, ratified_at: now };
  audit(session, now, 'safety_action_ratified', { action_id, ratified_by });
  return action;
}
