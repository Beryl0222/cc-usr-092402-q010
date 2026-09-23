import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '../src/contracts.js';
import {
  registerMembership, registerDelegation, registerRecusal, registerQuorumRule, registerThreshold,
} from '../src/registry.js';
import {
  activeMemberList, holderOf, isRecused, eligibleVoters, seatAuthorization,
  quorumRuleFor, thresholdFor,
} from '../src/governance.js';

const T0 = '2026-09-01T00:00:00+08:00';

function session() {
  return createSession({
    record_id: 'g', occurred_at: T0, source: 'test',
    meeting: { meeting_id: 'M', convened_at: T0 },
  });
}

test('成员资格按生效时间解析：新版本取代旧版本，到期后不回落旧版本', () => {
  const s = session();
  registerMembership(s, { member_id: 'M1', party_id: 'P', role: 'voting', version: 1, effective_from: T0 }, T0);
  assert.equal(activeMemberList(s.governance, '2026-09-05T00:00:00+08:00').length, 1);

  // 资格 9 月 10 日到期
  registerMembership(s, { member_id: 'M1', party_id: 'P', role: 'voting', version: 2, effective_from: '2026-09-06T00:00:00+08:00', effective_until: '2026-09-10T00:00:00+08:00' }, T0);
  assert.equal(activeMemberList(s.governance, '2026-09-07T00:00:00+08:00')[0].version, 2);
  assert.equal(activeMemberList(s.governance, '2026-09-11T00:00:00+08:00').length, 0);
  // 到期前的时点仍可复算出当时状态
  assert.equal(activeMemberList(s.governance, '2026-09-03T00:00:00+08:00')[0].version, 1);
});

test('授权代表在生效期内持票，到期后席位回到本人', () => {
  const s = session();
  registerMembership(s, { member_id: 'M1', party_id: 'P', role: 'voting', version: 1, effective_from: T0 }, T0);
  registerDelegation(s, {
    member_id: 'M1', delegate_id: 'D1', version: 1,
    effective_from: '2026-09-05T00:00:00+08:00', effective_until: '2026-09-10T00:00:00+08:00',
  }, T0);
  assert.equal(holderOf(s.governance, seatAuthorization('M1'), '2026-09-03T00:00:00+08:00').holder_id, 'M1');
  assert.equal(holderOf(s.governance, seatAuthorization('M1'), '2026-09-07T00:00:00+08:00').holder_id, 'D1');
  assert.equal(holderOf(s.governance, seatAuthorization('M1'), '2026-09-11T00:00:00+08:00').holder_id, 'M1');
});

test('临时回避披露立即缩小有效成员集合，且可精确到章节', () => {
  const s = session();
  registerMembership(s, { member_id: 'M1', party_id: 'P', role: 'voting', version: 1, effective_from: T0 }, T0);
  registerMembership(s, { member_id: 'M2', party_id: 'P', role: 'voting', version: 1, effective_from: T0 }, T0);
  registerRecusal(s, {
    recusal_id: 'R1', member_id: 'M1', motion_id: 'MOT', sections: ['S1'],
    version: 1, effective_from: '2026-09-08T08:00:00+08:00',
  }, T0);

  const before = '2026-09-08T07:00:00+08:00';
  const after = '2026-09-08T09:00:00+08:00';
  assert.equal(isRecused(s.governance, 'M1', { motion_id: 'MOT', section_id: 'S1' }, before), false);
  assert.equal(isRecused(s.governance, 'M1', { motion_id: 'MOT', section_id: 'S1' }, after), true);
  assert.equal(isRecused(s.governance, 'M1', { motion_id: 'MOT', section_id: 'S2' }, after), false);
  assert.equal(eligibleVoters(s.governance, { motion_id: 'MOT', section_id: 'S1' }, after).length, 1);
  assert.equal(eligibleVoters(s.governance, { motion_id: 'MOT', section_id: 'S2' }, after).length, 2);
});

test('专用规则按主题覆盖通用规则，并遵循生效时间', () => {
  const s = session();
  registerQuorumRule(s, { rule_id: 'QG', kind: 'fixed', min_count: 1, version: 1, effective_from: T0 }, T0);
  registerQuorumRule(s, { rule_id: 'QP', kind: 'fixed', min_count: 3, topics: ['proto'], version: 1, effective_from: T0 }, T0);
  assert.equal(quorumRuleFor(s.governance, 'pay', T0).rule_id, 'QG');
  assert.equal(quorumRuleFor(s.governance, 'proto', T0).rule_id, 'QP');

  registerThreshold(s, { threshold_id: 'TH0', kind: 'majority', basis: 'non_abstain', numerator: 1, denominator: 2, version: 1, effective_from: T0 }, T0);
  registerThreshold(s, { threshold_id: 'TH1', kind: 'unanimous', basis: 'non_abstain', topics: ['safe'], version: 1, effective_from: '2026-09-05T00:00:00+08:00' }, T0);
  assert.equal(thresholdFor(s.governance, 'safe', '2026-09-04T00:00:00+08:00').threshold_id, 'TH0');
  assert.equal(thresholdFor(s.governance, 'safe', '2026-09-06T00:00:00+08:00').threshold_id, 'TH1');
});
