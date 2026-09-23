import { audit, sealBallot, atOrBefore, atBefore } from './contracts.js';
import { holderOf, reviewWindowFor } from './governance.js';
import { getMotion } from './motions.js';

/**
 * 密封意见（选票）：
 * - 成员离线期间即可生成带序列号的密封承诺，恢复在线后提交，秘书处只确认收到；
 * - 开票（评议窗口关闭）前，公开视图只有回执，不含任何选择内容；
 * - 同一授权（席位）在同一章节上只计一票：序列号高者有效，低者作废；
 * - 同一序列号出现不同承诺视为冲突，整组作废并留痕；
 * - 章节修订后，按旧版本投出的票失效（stale），需重新签署投出。
 */

export const CHOICES = ['approve', 'reject', 'abstain', 'conditional'];

const windowOf = (session, motionId, sectionId, at) =>
  reviewWindowFor(session.governance, motionId, sectionId, at);

export function castBallot(session, { motion_id, section_id, authorization_id, cast_by, seq, choice, conditions = [], salt, cast_at = null, now }) {
  const motion = getMotion(session, motion_id);
  const section = motion.sections.find((s) => s.section_id === section_id);
  if (!section) throw new Error(`议案 ${motion_id} 不存在章节 ${section_id}`);
  const window = windowOf(session, motion_id, section_id, now);
  if (!window || !atOrBefore(window.opens_at, now) || !atOrBefore(now, window.closes_at)) {
    throw new Error('不在评议窗口内，密封意见拒收');
  }
  if (!Number.isInteger(seq) || seq < 1) throw new Error('密封意见缺少有效序列号');
  if (!CHOICES.includes(choice)) throw new Error(`非法表决选项: ${choice}`);
  if (choice === 'conditional' && conditions.length === 0) {
    throw new Error('条件性批准必须附条件');
  }
  for (const c of conditions) {
    if (!c.text || !c.owner_party || !c.due_at) throw new Error('条件缺少正文、责任方或期限');
  }
  if (typeof salt !== 'string' || salt.length === 0) throw new Error('密封承诺缺少盐值');
  const holder = holderOf(session.governance, authorization_id, now);
  if (!holder) throw new Error(`授权 ${authorization_id} 在接收时无效`);
  if (holder.holder_id !== cast_by) {
    throw new Error(`成员 ${cast_by} 在接收时不持有授权 ${authorization_id}`);
  }
  const commitment = sealBallot({
    motion_id,
    section_id,
    authorization_id,
    seq,
    section_revision: section.revision,
    choice,
    conditions,
    salt,
  });
  // 离线重传：同一授权同一序列同一承诺，幂等返回原回执
  const replay = session.ballots.find(
    (b) => b.authorization_id === authorization_id && b.section_id === section_id && b.seq === seq && b.commitment === commitment,
  );
  if (replay) {
    return { ballot_id: replay.ballot_id, commitment, received_at: replay.received_at, duplicate: true };
  }
  const ballot = {
    ballot_id: `BAL-${session.ballots.length + 1}`,
    motion_id,
    section_id,
    authorization_id,
    cast_by,
    seq,
    section_revision: section.revision,
    commitment,
    cast_at,
    received_at: now,
    revealed: null,
  };
  session.ballots.push(ballot);
  audit(session, now, 'ballot_received', { ballot_id: ballot.ballot_id, authorization_id, section_id, seq, commitment });
  return { ballot_id: ballot.ballot_id, commitment, received_at: now, duplicate: false };
}

/** 开票前的公开视图：只能确认是否收到，表决内容不可见。 */
export function receiptsFor(session, motion_id) {
  return session.ballots
    .filter((b) => b.motion_id === motion_id)
    .map((b) => ({
      ballot_id: b.ballot_id,
      section_id: b.section_id,
      authorization_id: b.authorization_id,
      seq: b.seq,
      commitment: b.commitment,
      received_at: b.received_at,
      revealed: b.revealed != null,
    }))
    .sort((a, b) => a.ballot_id.localeCompare(b.ballot_id));
}

/** 开票：窗口关闭后揭示内容，必须与密封承诺一致。 */
export function revealBallot(session, ballot_id, { choice, conditions = [], salt, now }) {
  const ballot = session.ballots.find((b) => b.ballot_id === ballot_id);
  if (!ballot) throw new Error(`未找到密封意见: ${ballot_id}`);
  const window = windowOf(session, ballot.motion_id, ballot.section_id, now);
  if (!window || !atBefore(window.closes_at, now)) {
    throw new Error('评议窗口未关闭，未到开票时间');
  }
  if (ballot.revealed) throw new Error('该密封意见已开票');
  const commitment = sealBallot({
    motion_id: ballot.motion_id,
    section_id: ballot.section_id,
    authorization_id: ballot.authorization_id,
    seq: ballot.seq,
    section_revision: ballot.section_revision,
    choice,
    conditions,
    salt,
  });
  if (commitment !== ballot.commitment) {
    audit(session, now, 'ballot_reveal_rejected', { ballot_id });
    throw new Error('开票内容与密封承诺不一致');
  }
  ballot.revealed = { choice, conditions, salt, revealed_at: now };
  audit(session, now, 'ballot_revealed', { ballot_id });
  return ballot;
}

/**
 * 计票解析：某章节在时点 at 的有效票集合。
 * 返回每个席位恰好一条有效选择，以及完整的废票分类账目（全部留痕可复算）。
 */
export function resolveBallots(session, motion, section, at) {
  const window = windowOf(session, motion.motion_id, section.section_id, at);
  const accounting = { counted: [], superseded: [], stale: [], conflicted: [], sealed: [], invalid: [], out_of_window: [], ineligible_seat: [] };
  const ballots = session.ballots.filter((b) => b.motion_id === motion.motion_id && b.section_id === section.section_id);

  // 同一授权同一序列出现不同承诺：整组冲突作废
  const bySeq = new Map();
  for (const b of ballots) {
    const key = `${b.authorization_id}#${b.seq}`;
    bySeq.set(key, [...(bySeq.get(key) ?? []), b]);
  }
  const conflicted = new Set();
  for (const group of bySeq.values()) {
    if (new Set(group.map((b) => b.commitment)).size > 1) {
      for (const b of group) conflicted.add(b.ballot_id);
    }
  }

  const candidates = [];
  for (const b of ballots) {
    if (conflicted.has(b.ballot_id)) {
      accounting.conflicted.push(b.ballot_id);
      continue;
    }
    if (window && (!atOrBefore(window.opens_at, b.received_at) || !atOrBefore(b.received_at, window.closes_at))) {
      accounting.out_of_window.push(b.ballot_id);
      continue;
    }
    const holder = holderOf(session.governance, b.authorization_id, b.received_at);
    if (!holder || holder.holder_id !== b.cast_by) {
      accounting.invalid.push(b.ballot_id);
      continue;
    }
    if (b.section_revision !== section.revision) {
      accounting.stale.push(b.ballot_id); // 章节已修订，需重签
      continue;
    }
    if (!b.revealed) {
      accounting.sealed.push(b.ballot_id);
      continue;
    }
    candidates.push(b);
  }

  // 同一授权只计序列号最高的一票
  const votes = new Map();
  for (const b of candidates) {
    const cur = votes.get(b.authorization_id);
    if (!cur || cur.seq < b.seq) {
      if (cur) accounting.superseded.push(cur.ballot_id);
      votes.set(b.authorization_id, b);
    } else {
      accounting.superseded.push(b.ballot_id);
    }
  }
  for (const b of votes.values()) accounting.counted.push(b.ballot_id);
  for (const key of Object.keys(accounting)) accounting[key].sort();

  return { votes, accounting, window };
}
