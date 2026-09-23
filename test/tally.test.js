import test from 'node:test';
import assert from 'node:assert/strict';
import { baseSession, T, castAndReveal } from './helpers.js';
import { computeTally, announceDecision, verifyDecision, fileCorrection } from '../src/tally.js';
import { registerRecusal, registerMembership } from '../src/registry.js';
import { escalateDeadlock, resolveEscalation } from '../src/actions.js';

test('纯函数复算：同一时点重复计算，摘要完全一致', () => {
  const s = baseSession();
  castAndReveal(s, { section_id: 'S1', member: 'M1', choice: 'approve' });
  castAndReveal(s, { section_id: 'S1', member: 'M2', choice: 'reject' });
  castAndReveal(s, { section_id: 'S1', member: 'M3', choice: 'approve' });
  const a = computeTally(s, 'MOT', ['S1'], T.TALLY);
  const b = computeTally(s, 'MOT', ['S1'], T.TALLY);
  assert.equal(a.sections[0].tally_digest, b.sections[0].tally_digest);
  assert.equal(a.sections[0].outcome, 'approved');
  assert.deepEqual(a.sections[0].counts, { approve: 2, reject: 1, abstain: 0, conditional: 0 });
});

test('窗口未关闭与未达法定人数时不能宣布', () => {
  const s = baseSession();
  castAndReveal(s, { section_id: 'S1', member: 'M1', choice: 'approve' });
  // 只有一票，不足 2/3 法定人数
  const tally = computeTally(s, 'MOT', ['S1'], T.TALLY);
  assert.equal(tally.sections[0].outcome, 'no_quorum');
  assert.throws(() => announceDecision(s, {
    decision_id: 'D1', motion_id: 'MOT', section_ids: ['S1'], at: T.TALLY, declared_by: 'M1',
  }), /不具备宣布条件/);
});

test('未宣布前临时回避立即重算结果，有效成员集合随之改变', () => {
  const s = baseSession();
  castAndReveal(s, { section_id: 'S1', member: 'M1', choice: 'reject' });
  castAndReveal(s, { section_id: 'S1', member: 'M2', choice: 'approve' });
  castAndReveal(s, { section_id: 'S1', member: 'M3', choice: 'approve' });

  // 回避前：2 赞成 1 反对，过半数通过
  assert.equal(computeTally(s, 'MOT', ['S1'], T.TALLY).sections[0].outcome, 'approved');

  // M3 临时披露回避：有效集合变为 M1/M2，赞成票 M3 被移出
  registerRecusal(s, {
    recusal_id: 'R1', member_id: 'M3', motion_id: 'MOT', sections: ['S1'],
    reason: '临时披露', version: 1, effective_from: '2026-09-20T20:00:00+08:00',
  }, T.TALLY);
  const t = computeTally(s, 'MOT', ['S1'], T.TALLY).sections[0];
  assert.deepEqual(t.eligible_voters.map((v) => v.holder_id), ['M1', 'M2']);
  assert.deepEqual(t.counts, { approve: 1, reject: 1, abstain: 0, conditional: 0 });
  assert.equal(t.outcome, 'deadlocked');
  assert.equal(t.ballot_accounting.ineligible_seat.length, 1);
});

test('资格到期在未宣布前同样重算，并可导致法定人数不足', () => {
  const s = baseSession();
  // 只有 M1、M2 投票，M3 未投
  castAndReveal(s, { section_id: 'S1', member: 'M1', choice: 'approve' });
  castAndReveal(s, { section_id: 'S1', member: 'M2', choice: 'approve' });
  // M2 资格在计票前到期：有效集合变为 M1/M3，仅剩 M1 一票，2/3 法定人数不足
  registerMembership(s, {
    member_id: 'M2', party_id: 'PB', role: 'voting', version: 2,
    effective_from: '2026-09-20T20:00:00+08:00', effective_until: '2026-09-21T08:00:00+08:00',
  }, T.TALLY);
  const t = computeTally(s, 'MOT', ['S1'], T.TALLY).sections[0];
  assert.deepEqual(t.eligible_voters.map((v) => v.holder_id), ['M1', 'M3']);
  assert.equal(t.participation, 1);
  assert.equal(t.outcome, 'no_quorum');
  assert.equal(t.ballot_accounting.ineligible_seat.length, 1);
});

test('宣布固化结论并通过 verifyDecision 复算一致', () => {
  const s = baseSession();
  castAndReveal(s, { section_id: 'S1', member: 'M1', choice: 'approve' });
  castAndReveal(s, { section_id: 'S1', member: 'M2', choice: 'approve' });
  castAndReveal(s, { section_id: 'S1', member: 'M3', choice: 'abstain' });
  const { decision } = announceDecision(s, {
    decision_id: 'D1', motion_id: 'MOT', section_ids: ['S1'], at: T.TALLY, declared_by: 'M1',
  });
  assert.equal(decision.overall_outcome, 'approved');
  const checks = verifyDecision(s, 'D1');
  assert.ok(checks.every((c) => c.matches));
  // 通过章节获得签署
  assert.equal(s.motions[0].sections[0].last_signoff.decision_id, 'D1');
});

test('宣布后发现错误只能公开更正：原决定保留，更正附复算结论', () => {
  const s = baseSession();
  castAndReveal(s, { section_id: 'S1', member: 'M1', choice: 'approve' });
  castAndReveal(s, { section_id: 'S1', member: 'M2', choice: 'approve' });
  castAndReveal(s, { section_id: 'S1', member: 'M3', choice: 'approve' });
  announceDecision(s, { decision_id: 'D1', motion_id: 'MOT', section_ids: ['S1'], at: T.TALLY, declared_by: 'M1' });

  // 宣布后查实 M1 的利益冲突在宣布时已经存在（漏报）：
  // 条目事后补登，但 effective_from 回溯到冲突真实发生时间，审计时间仍是补登时间
  registerRecusal(s, {
    recusal_id: 'R-LATE', member_id: 'M1', motion_id: 'MOT', sections: ['S1'],
    reason: '宣布后查实的漏报冲突', version: 1, effective_from: T.T0,
  }, T.LATE);

  // 在原宣布时点按补登后的记录复算，差异被暴露
  const checks = verifyDecision(s, 'D1');
  assert.equal(checks[0].matches, false);

  const correction = fileCorrection(s, {
    correction_id: 'C1', decision_id: 'D1', at: T.LATE,
    error_type: 'record_error', reason: 'M1 利益冲突漏报', filed_by: 'SEC',
  });
  assert.equal(s.decisions[0].correction_ids[0], 'C1');
  assert.equal(correction.recomputed[0].eligible_voters.length, 2);
  // 原决定与其固化计票仍然原样保留
  assert.equal(s.decisions[0].overall_outcome, 'approved');
  assert.equal(s.tallies.length, 1);
});

test('不在议题范围内的章节不得付诸表决与宣布', () => {
  const s = baseSession();
  // 议程只收录 pay/proto/safe，给议案加入范围外章节并投满票
  s.motions[0].sections.push({
    section_id: 'S9', topic: 'unscoped_topic', title: '临时追加',
    revision: 1, content_digest: 'x', material_refs: [], introduced_at: T.INTRO, last_signoff: null,
  });
  castAndReveal(s, { section_id: 'S9', member: 'M1', choice: 'approve' });
  castAndReveal(s, { section_id: 'S9', member: 'M2', choice: 'approve' });
  castAndReveal(s, { section_id: 'S9', member: 'M3', choice: 'approve' });
  const t = computeTally(s, 'MOT', ['S9'], T.TALLY).sections[0];
  assert.equal(t.outcome, 'out_of_agenda');
  assert.throws(() => announceDecision(s, {
    decision_id: 'DBAD', motion_id: 'MOT', section_ids: ['S9'], at: T.TALLY, declared_by: 'M1',
  }), /不具备宣布条件/);
});

test('升级逾期未裁断则过期并进入秘书处待办', async () => {
  const s = baseSession();
  castAndReveal(s, { section_id: 'S1', member: 'M1', choice: 'approve' });
  castAndReveal(s, { section_id: 'S1', member: 'M2', choice: 'reject' });
  castAndReveal(s, { section_id: 'S1', member: 'M3', choice: 'abstain' });
  announceDecision(s, { decision_id: 'D-LOCK2', motion_id: 'MOT', section_ids: ['S1'], at: T.TALLY, declared_by: 'M1' });
  escalateDeadlock(s, {
    action_id: 'A2', decision_id: 'D-LOCK2', escalate_to_role: 'steering',
    opened_by: 'M2', due_at: '2026-09-22T18:00:00+08:00', now: T.LATE,
  });
  assert.throws(() => resolveEscalation(s, 'A2', { ruling: 'uphold', resolved_by: 'M1', now: '2026-09-23T09:00:00+08:00' }), /裁断期限/);
  assert.equal(s.actions[0].status, 'expired');
  const { secretariatBacklog } = await import('../src/notices.js');
  assert.deepEqual(secretariatBacklog(s, '2026-09-23T09:00:00+08:00').escalations, ['A2']);
});

test('僵局可升级；越权或逾期裁断被拒绝', () => {
  const s = baseSession();
  castAndReveal(s, { section_id: 'S1', member: 'M1', choice: 'approve' });
  castAndReveal(s, { section_id: 'S1', member: 'M2', choice: 'reject' });
  castAndReveal(s, { section_id: 'S1', member: 'M3', choice: 'abstain' });
  announceDecision(s, { decision_id: 'D-LOCK', motion_id: 'MOT', section_ids: ['S1'], at: T.TALLY, declared_by: 'M1' });

  escalateDeadlock(s, {
    action_id: 'A1', decision_id: 'D-LOCK', escalate_to_role: 'steering',
    opened_by: 'M2', due_at: '2026-09-25T18:00:00+08:00', now: T.LATE,
  });
  assert.throws(() => resolveEscalation(s, 'A1', { ruling: 'uphold', resolved_by: 'M2', now: '2026-09-23T09:00:00+08:00' }), /不具职权/);
  const resolved = resolveEscalation(s, 'A1', { ruling: 'uphold', resolved_by: 'M1', now: '2026-09-23T09:00:00+08:00' });
  assert.equal(resolved.status, 'resolved');
});

test('条件性赞成产生条件记录；整体结论为 conditionally_approved', () => {
  const s = baseSession();
  castAndReveal(s, { section_id: 'S1', member: 'M1', choice: 'conditional', conditions: [
    { text: '审计后付款', owner_party: 'PA', due_at: '2026-10-01T00:00:00+08:00' },
  ], salt: 'c1' });
  castAndReveal(s, { section_id: 'S1', member: 'M2', choice: 'approve' });
  castAndReveal(s, { section_id: 'S1', member: 'M3', choice: 'approve' });
  const { decision } = announceDecision(s, {
    decision_id: 'D-COND', motion_id: 'MOT', section_ids: ['S1'], at: T.TALLY, declared_by: 'M1',
  });
  assert.equal(decision.overall_outcome, 'conditionally_approved');
  assert.equal(s.conditions.length, 1);
  assert.equal(s.conditions[0].status, 'open');
});
