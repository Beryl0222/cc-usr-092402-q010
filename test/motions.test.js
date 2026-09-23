import test from 'node:test';
import assert from 'node:assert/strict';
import { baseSession, T } from './helpers.js';
import {
  createMotion, reviseMotion, needsSignoff, sectionsNeedingSignoff, sectionRevisionAt,
  appendMinorityOpinion, listMinorityOpinions,
} from '../src/motions.js';

test('修订只要求受影响章节重签，未改章节保持已签状态', () => {
  const s = baseSession();
  // 初始：两章节均未签
  assert.deepEqual(sectionsNeedingSignoff(s.motions[0]), ['S1', 'S2']);

  // 模拟 S1 在 rev1 获得签署
  const motion = s.motions[0];
  motion.sections[0].last_signoff = { revision: 1, decision_id: 'DEC-OLD', at: T.MID };
  assert.equal(needsSignoff(motion, 'S1'), false);

  // 只修订 S2
  reviseMotion(s, 'MOT', {
    at: '2026-09-16T09:00:00+08:00', changed_sections: ['S2'],
    rationale: 'r', editor_id: 'M2',
    section_updates: [{ section_id: 'S2', content: '方案章节修订' }],
  });
  assert.equal(sectionRevisionAt(motion, 'S1'), 1);
  assert.equal(sectionRevisionAt(motion, 'S2'), 2);
  assert.equal(needsSignoff(motion, 'S1'), false); // 不受影响，无需重签
  assert.deepEqual(sectionsNeedingSignoff(motion), ['S2']);
  assert.equal(motion.current_revision, 2);
});

test('已签章节在被修订后需要重签', () => {
  const s = baseSession();
  const motion = s.motions[0];
  motion.sections[0].last_signoff = { revision: 1, decision_id: 'DEC-OLD', at: T.MID };
  reviseMotion(s, 'MOT', {
    at: '2026-09-16T09:00:00+08:00', changed_sections: ['S1'],
    rationale: 'r', editor_id: 'M1', section_updates: [{ section_id: 'S1', content: '付款条款变更' }],
  });
  assert.equal(needsSignoff(motion, 'S1'), true);
  // 历史签署事实仍保留
  assert.equal(motion.sections[0].last_signoff.decision_id, 'DEC-OLD');
});

test('少数意见只增不改：追加可查，不能覆盖，议案修订后仍然完整', () => {
  const s = baseSession();
  appendMinorityOpinion(s, {
    opinion_id: 'OP-1', motion_id: 'MOT', section_id: 'S1',
    author_holder_id: 'M3', revision: 1, at: T.MID, text: '保留意见一',
  });
  appendMinorityOpinion(s, {
    opinion_id: 'OP-2', motion_id: 'MOT', section_id: null,
    author_holder_id: 'M2', revision: 1, at: T.MID, text: '保留意见二',
  });
  assert.throws(() =>
    appendMinorityOpinion(s, {
      opinion_id: 'OP-1', motion_id: 'MOT', author_holder_id: 'M3', revision: 1, at: T.MID, text: '覆盖尝试',
    }),
  );
  reviseMotion(s, 'MOT', {
    at: '2026-09-16T09:00:00+08:00', changed_sections: ['S1'],
    rationale: 'r', editor_id: 'M1', section_updates: [{ section_id: 'S1', content: '改' }],
  });
  const all = listMinorityOpinions(s, { motion_id: 'MOT' });
  assert.deepEqual(all.map((o) => o.opinion_id), ['OP-1', 'OP-2']);
  assert.equal(all[0].text, '保留意见一');
  // 挂在旧修订的意见在新版本默认仍列出（永久记录）
  assert.equal(listMinorityOpinions(s, { motion_id: 'MOT', section_id: 'S1' }).length, 1);
});

test('不能创建重复议案，修订时间不得倒退', () => {
  const s = baseSession();
  assert.throws(() => createMotion(s, {
    motion_id: 'MOT', title: 'x', introduced_at: T.INTRO, sponsor_id: 'M1',
    sections: [{ section_id: 'S9', content: 'x' }],
  }));
  assert.throws(() => reviseMotion(s, 'MOT', {
    at: '2026-09-01T00:00:00+08:00', changed_sections: ['S1'], rationale: 'x', editor_id: 'M1',
  }));
});
