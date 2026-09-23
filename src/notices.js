import { atBefore } from './contracts.js';

/**
 * 通知与决定解耦：决定一经宣布即落账，投递失败绝不影响其效力；
 * 未送达的通知持续列在秘书处待办中，直到重试成功
 * （重试通过 recordNotice 追加新条目并以 retry_of 关联原通知）。
 * 逾期的升级、安全动作与条件同样在此汇总：只要仍是开放状态就会被持续追踪。
 */

// 同一（决定/行动, 接收方）只保留最后一次投递尝试
const latestNoticeByTarget = (session) => {
  const latest = new Map();
  const keyOf = (n) => `${n.decision_id ?? n.action_id ?? ''}::${n.recipient_id}`;
  for (const n of session.notices) {
    const key = keyOf(n);
    const cur = latest.get(key);
    if (!cur || Date.parse(cur.attempted_at) <= Date.parse(n.attempted_at)) latest.set(key, n);
  }
  return latest;
};

export function secretariatBacklog(session, now) {
  const notices = [...latestNoticeByTarget(session).values()]
    .filter((n) => n.status === 'failed')
    .map((n) => n.notice_id)
    .sort();

  const escalations = session.actions
    .filter(
      (a) =>
        a.kind === 'deadlock_escalation' &&
        ((a.status === 'open' && atBefore(a.due_at, now)) || a.status === 'expired'),
    )
    .map((a) => a.action_id)
    .sort();

  const safety_actions = session.actions
    .filter(
      (a) =>
        a.kind === 'safety_emergency' &&
        ((a.status === 'active' && atBefore(a.review_by, now)) || a.status === 'overdue'),
    )
    .map((a) => a.action_id)
    .sort();

  const conditions = session.conditions
    .filter((c) => (c.status === 'open' && atBefore(c.due_at, now)) || c.status === 'expired')
    .map((c) => c.condition_id)
    .sort();

  return { notices, escalations, safety_actions, conditions };
}
