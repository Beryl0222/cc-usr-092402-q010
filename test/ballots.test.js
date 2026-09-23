import test from 'node:test';
import assert from 'node:assert/strict';
import { baseSession, T, castAndReveal } from './helpers.js';
import { castBallot, receiptsFor, revealBallot, resolveBallots } from '../src/ballots.js';
import { reviseMotion } from '../src/motions.js';
import { getMotion } from '../src/motions.js';
import { registerDelegation } from '../src/registry.js';

test('开票前只能确认收到，公开视图不含任何选择内容', () => {
  const s = baseSession();
  const salt = 'secret-salt';
  const receipt = castBallot(s, {
    motion_id: 'MOT', section_id: 'S1', authorization_id: 'seat:M1', cast_by: 'M1',
    seq: 1, choice: 'reject', salt, now: T.MID,
  });
  assert.equal(receipt.commitment.length, 64);
  const view = receiptsFor(s, 'MOT')[0];
  assert.equal(view.revealed, false);
  assert.equal(JSON.stringify(view).includes('reject'), false);
  assert.equal(view.seq, 1);
  assert.equal(view.authorization_id, 'seat:M1');

  // 开票内容与承诺不一致被拒绝
  const ballotId = receipt.ballot_id;
  assert.throws(() => revealBallot(s, ballotId, { choice: 'approve', conditions: [], salt, now: T.REVEAL }), /承诺不一致/);
  revealBallot(s, ballotId, { choice: 'reject', conditions: [], salt, now: T.REVEAL });
  assert.equal(receiptsFor(s, 'MOT')[0].revealed, true);
});

test('窗口外拒收；窗口关闭前不得开票', () => {
  const s = baseSession();
  assert.throws(() => castBallot(s, {
    motion_id: 'MOT', section_id: 'S1', authorization_id: 'seat:M1', cast_by: 'M1',
    seq: 1, choice: 'approve', salt: 'x', now: '2026-09-09T00:00:00+08:00',
  }), /评议窗口/);
  const receipt = castBallot(s, {
    motion_id: 'MOT', section_id: 'S1', authorization_id: 'seat:M1', cast_by: 'M1',
    seq: 1, choice: 'approve', salt: 'x', now: T.MID,
  });
  assert.throws(() => revealBallot(s, receipt.ballot_id, { choice: 'approve', conditions: [], salt: 'x', now: T.MID }), /未到开票/);
});

test('同一授权重复提交：高序列取代低序列，低序列留 superseded 账目；同承诺重传幂等', () => {
  const s = baseSession();
  const r1 = castBallot(s, { motion_id: 'MOT', section_id: 'S1', authorization_id: 'seat:M1', cast_by: 'M1', seq: 1, choice: 'reject', salt: 'a', now: T.MID });
  const r2 = castBallot(s, { motion_id: 'MOT', section_id: 'S1', authorization_id: 'seat:M1', cast_by: 'M1', seq: 2, choice: 'approve', salt: 'b', now: T.MID });
  const replay = castBallot(s, { motion_id: 'MOT', section_id: 'S1', authorization_id: 'seat:M1', cast_by: 'M1', seq: 2, choice: 'approve', salt: 'b', now: T.MID });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.ballot_id, r2.ballot_id);
  revealBallot(s, r1.ballot_id, { choice: 'reject', conditions: [], salt: 'a', now: T.REVEAL });
  revealBallot(s, r2.ballot_id, { choice: 'approve', conditions: [], salt: 'b', now: T.REVEAL });

  const { votes, accounting } = resolveBallots(s, getMotion(s, 'MOT'), getMotion(s, 'MOT').sections[0], T.TALLY);
  assert.equal(votes.size, 1);
  assert.equal(votes.get('seat:M1').revealed.choice, 'approve');
  assert.deepEqual(accounting.superseded, [r1.ballot_id]);
});

test('同一序列不同承诺视为冲突，整组作废', () => {
  const s = baseSession();
  const r1 = castBallot(s, { motion_id: 'MOT', section_id: 'S1', authorization_id: 'seat:M1', cast_by: 'M1', seq: 1, choice: 'approve', salt: 'a', now: T.MID });
  const r2 = castBallot(s, { motion_id: 'MOT', section_id: 'S1', authorization_id: 'seat:M1', cast_by: 'M1', seq: 1, choice: 'reject', salt: 'z', now: T.MID });
  revealBallot(s, r1.ballot_id, { choice: 'approve', conditions: [], salt: 'a', now: T.REVEAL });
  revealBallot(s, r2.ballot_id, { choice: 'reject', conditions: [], salt: 'z', now: T.REVEAL });
  const { votes, accounting } = resolveBallots(s, getMotion(s, 'MOT'), getMotion(s, 'MOT').sections[0], T.TALLY);
  assert.equal(votes.size, 0);
  assert.deepEqual(accounting.conflicted.sort(), [r1.ballot_id, r2.ballot_id].sort());
});

test('章节修订后旧票记为 stale，需重新签署投出', () => {
  const s = baseSession();
  castAndReveal(s, { section_id: 'S1', member: 'M1', seq: 1, choice: 'approve' });
  reviseMotion(s, 'MOT', {
    at: '2026-09-17T09:00:00+08:00', changed_sections: ['S1'],
    rationale: 'r', editor_id: 'M1', section_updates: [{ section_id: 'S1', content: '付款条款改' }],
  });
  const before = resolveBallots(s, getMotion(s, 'MOT'), getMotion(s, 'MOT').sections[0], T.TALLY);
  assert.equal(before.votes.size, 0);
  assert.equal(before.accounting.stale.length, 1);

  castAndReveal(s, { section_id: 'S1', member: 'M1', seq: 2, choice: 'approve', castAt: '2026-09-18T09:00:00+08:00' });
  const after = resolveBallots(s, getMotion(s, 'MOT'), getMotion(s, 'MOT').sections[0], T.TALLY);
  assert.equal(after.votes.size, 1);
});

test('非持票人不能以该席位投票；授权到期后本人恢复持票', () => {
  const s = baseSession();
  registerDelegation(s, {
    member_id: 'M2', delegate_id: 'D2', version: 1,
    effective_from: '2026-09-12T00:00:00+08:00', effective_until: '2026-09-18T00:00:00+08:00',
  }, T.T0);
  assert.throws(() => castBallot(s, {
    motion_id: 'MOT', section_id: 'S1', authorization_id: 'seat:M2', cast_by: 'M2',
    seq: 1, choice: 'approve', salt: 'x', now: T.MID,
  }), /不持有授权/);
  const r = castBallot(s, {
    motion_id: 'MOT', section_id: 'S1', authorization_id: 'seat:M2', cast_by: 'D2',
    seq: 1, choice: 'approve', salt: 'x', now: T.MID,
  });
  revealBallot(s, r.ballot_id, { choice: 'approve', conditions: [], salt: 'x', now: T.REVEAL });
});

test('条件性批准必须附条件', () => {
  const s = baseSession();
  assert.throws(() => castBallot(s, {
    motion_id: 'MOT', section_id: 'S1', authorization_id: 'seat:M1', cast_by: 'M1',
    seq: 1, choice: 'conditional', salt: 'x', now: T.MID,
  }), /必须附条件/);
});
