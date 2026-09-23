import { createSession } from '../src/contracts.js';
import {
  registerMembership, registerDelegation, registerRecusal, registerMaterial,
  registerReviewWindow, registerQuorumRule, registerThreshold, registerOfficer,
  registerAgendaScope,
} from '../src/registry.js';
import { createMotion } from '../src/motions.js';
import { castBallot, revealBallot } from '../src/ballots.js';

export const T = {
  T0: '2026-09-01T00:00:00+08:00',
  INTRO: '2026-09-10T09:00:00+08:00',
  OPEN: '2026-09-10T10:00:00+08:00',
  MID: '2026-09-15T10:00:00+08:00',
  CLOSE: '2026-09-20T18:00:00+08:00',
  REVEAL: '2026-09-20T19:00:00+08:00',
  TALLY: '2026-09-21T09:00:00+08:00',
  LATE: '2026-09-22T09:00:00+08:00',
};

/** 最小可用会议：三名有表决权成员 + 一名观察员，两章节议案，统一评议窗口。 */
export function baseSession() {
  const session = createSession({
    record_id: 'test-session',
    occurred_at: T.T0,
    source: 'test',
    meeting: { meeting_id: 'MTG-1', title: '测试会议', convened_at: T.INTRO },
  });
  registerMembership(session, { member_id: 'M1', party_id: 'PA', role: 'voting', version: 1, effective_from: T.T0 }, T.T0);
  registerMembership(session, { member_id: 'M2', party_id: 'PB', role: 'voting', version: 1, effective_from: T.T0 }, T.T0);
  registerMembership(session, { member_id: 'M3', party_id: 'PC', role: 'voting', version: 1, effective_from: T.T0 }, T.T0);
  registerMembership(session, { member_id: 'OBS', party_id: 'PC', role: 'observer', version: 1, effective_from: T.T0 }, T.T0);
  registerOfficer(session, { role: 'chair', holder_id: 'M1', version: 1, effective_from: T.T0 }, T.T0);
  registerOfficer(session, { role: 'safety_officer', holder_id: 'M3', version: 1, effective_from: T.T0 }, T.T0);
  registerOfficer(session, { role: 'steering', holder_id: 'M1', version: 1, effective_from: T.T0 }, T.T0);
  registerAgendaScope(session, { scope_id: 'AG', topics: ['pay', 'proto', 'safe'], motion_id: 'MOT', version: 1, effective_from: T.T0 }, T.T0);
  registerQuorumRule(session, { rule_id: 'Q', kind: 'fraction', numerator: 2, denominator: 3, version: 1, effective_from: T.T0 }, T.T0);
  registerThreshold(session, { threshold_id: 'TH', kind: 'majority', basis: 'non_abstain', numerator: 1, denominator: 2, inclusive: false, version: 1, effective_from: T.T0 }, T.T0);
  registerReviewWindow(session, { window_id: 'W', motion_id: 'MOT', version: 1, opens_at: T.OPEN, closes_at: T.CLOSE, effective_from: T.OPEN }, T.OPEN);
  createMotion(session, {
    motion_id: 'MOT', title: '测试议案', introduced_at: T.INTRO, sponsor_id: 'M1',
    sections: [
      { section_id: 'S1', topic: 'pay', content: '付款章节' },
      { section_id: 'S2', topic: 'proto', content: '方案章节' },
    ],
  });
  return session;
}

/** 投出并立即开票一票；返回 ballot_id。 */
export function castAndReveal(session, { section_id = 'S1', member, seq = 1, choice = 'approve', conditions = [], salt = null, castAt = T.MID, revealAt = T.REVEAL }) {
  const useSalt = salt ?? `${member}-${section_id}-seq${seq}`;
  const receipt = castBallot(session, {
    motion_id: 'MOT', section_id, authorization_id: `seat:${member}`, cast_by: member,
    seq, choice, conditions, salt: useSalt, now: castAt,
  });
  revealBallot(session, receipt.ballot_id, { choice, conditions, salt: useSalt, now: revealAt });
  return receipt.ballot_id;
}
