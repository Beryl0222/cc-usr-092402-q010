import test from 'node:test';
import assert from 'node:assert/strict';
import { baseSession, T, castAndReveal } from './helpers.js';
import { announceDecision } from '../src/tally.js';
import { safetyEmergencyAction, ratifySafetyAction, fulfillCondition } from '../src/actions.js';
import { recordNotice } from '../src/registry.js';
import { secretariatBacklog } from '../src/notices.js';

test('安全紧急动作：安全官先行，主席期限内追认；越权与逾期被拒绝', () => {
  const s = baseSession();
  assert.throws(() => safetyEmergencyAction(s, {
    action_id: 'A-BAD', actor_id: 'M2', motion_id: 'MOT', measure: 'pause',
    reason: 'x', review_by: T.LATE, now: T.MID,
  }), /不具职权/);

  safetyEmergencyAction(s, {
    action_id: 'A-SAFE', actor_id: 'M3', role: 'safety_officer', motion_id: 'MOT', section_id: 'S2',
    measure: 'pause', reason: '可疑 SAE', review_by: '2026-09-22T00:00:00+08:00', now: '2026-09-19T08:00:00+08:00',
  });
  // 仅主席可追认
  assert.throws(() => ratifySafetyAction(s, 'A-SAFE', { ratified_by: 'M3', now: '2026-09-19T10:00:00+08:00' }), /仅主席/);
  ratifySafetyAction(s, 'A-SAFE', { ratified_by: 'M1', now: '2026-09-19T10:00:00+08:00' });
  assert.equal(s.actions[0].status, 'ratified');

  // 逾期未追认的动作转入 overdue，不能再追认
  safetyEmergencyAction(s, {
    action_id: 'A-LATE', actor_id: 'M3', role: 'safety_officer', motion_id: 'MOT',
    measure: 'pause', reason: 'x', review_by: '2026-09-20T00:00:00+08:00', now: '2026-09-18T08:00:00+08:00',
  });
  assert.throws(() => ratifySafetyAction(s, 'A-LATE', { ratified_by: 'M1', now: '2026-09-21T08:00:00+08:00' }), /追认期限/);
  assert.equal(s.actions.find((a) => a.action_id === 'A-LATE').status, 'overdue');
  assert.deepEqual(secretariatBacklog(s, '2026-09-21T08:00:00+08:00').safety_actions, ['A-LATE']);
});

test('通知投递失败不妨碍决定落账，但持续列入秘书处待办，重试成功后移出', () => {
  const s = baseSession();
  castAndReveal(s, { section_id: 'S1', member: 'M1', choice: 'approve' });
  castAndReveal(s, { section_id: 'S1', member: 'M2', choice: 'approve' });
  castAndReveal(s, { section_id: 'S1', member: 'M3', choice: 'approve' });
  announceDecision(s, { decision_id: 'D1', motion_id: 'MOT', section_ids: ['S1'], at: T.TALLY, declared_by: 'M1' });

  recordNotice(s, { notice_id: 'N1', decision_id: 'D1', recipient_id: 'PA', channel: 'mail', status: 'failed', failure_reason: 'bounce', attempted_at: T.TALLY }, T.TALLY);
  recordNotice(s, { notice_id: 'N2', decision_id: 'D1', recipient_id: 'PB', channel: 'mail', status: 'delivered', attempted_at: T.TALLY }, T.TALLY);

  // 决定已落账，不受失败影响
  assert.equal(s.decisions.length, 1);
  assert.deepEqual(secretariatBacklog(s, T.LATE).notices, ['N1']);

  // 重试成功（retry_of 关联原通知）后从待办移出
  recordNotice(s, { notice_id: 'N3', decision_id: 'D1', recipient_id: 'PA', channel: 'mail', status: 'delivered', attempted_at: '2026-09-22T08:00:00+08:00', retry_of: 'N1' }, '2026-09-22T08:00:00+08:00');
  assert.deepEqual(secretariatBacklog(s, '2026-09-22T09:00:00+08:00').notices, []);
});

test('条件逾期履行被拒绝并标记过期，进入待办；按期履行则关闭', () => {
  const s = baseSession();
  castAndReveal(s, { section_id: 'S1', member: 'M1', choice: 'conditional', conditions: [
    { text: '补交审计', owner_party: 'PA', due_at: '2026-10-01T00:00:00+08:00' },
  ], salt: 'c1' });
  castAndReveal(s, { section_id: 'S1', member: 'M2', choice: 'approve' });
  castAndReveal(s, { section_id: 'S1', member: 'M3', choice: 'approve' });
  announceDecision(s, { decision_id: 'D1', motion_id: 'MOT', section_ids: ['S1'], at: T.TALLY, declared_by: 'M1' });

  assert.deepEqual(secretariatBacklog(s, '2026-09-25T00:00:00+08:00').conditions, []);
  assert.deepEqual(secretariatBacklog(s, '2026-10-02T00:00:00+08:00').conditions, ['CON-1']);
  assert.throws(() => fulfillCondition(s, 'CON-1', { fulfilled_by: 'PA', now: '2026-10-02T00:00:00+08:00' }), /履行期限/);
  assert.equal(s.conditions[0].status, 'expired');
});
