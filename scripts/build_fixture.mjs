/**
 * 构建经过脱敏的 v2 业务样例：第三十七次联合药研委员会，
 * 同一议案包含里程碑付款、试验方案变更、安全暂停三个章节，
 * 覆盖离线密封意见、临时回避重算、修订重签、安全紧急动作、条件性批准与通知失败待办。
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createSession, exportSession, digest, sealBallot } from '../src/contracts.js';
import {
  registerMembership, registerDelegation, registerRecusal, registerMaterial,
  registerReviewWindow, registerQuorumRule, registerThreshold, registerOfficer,
  registerAgendaScope, recordNotice,
} from '../src/registry.js';
import { createMotion, reviseMotion, appendMinorityOpinion } from '../src/motions.js';
import { castBallot, revealBallot } from '../src/ballots.js';
import { announceDecision } from '../src/tally.js';
import { safetyEmergencyAction, ratifySafetyAction } from '../src/actions.js';

const MOTION = 'M-2026-031';
const MILESTONE = 'SEC-MILESTONE';
const PROTOCOL = 'SEC-PROTOCOL';
const SAFETY = 'SEC-SAFETY';

export function buildSampleSession() {
  const session = createSession({
    record_id: 'sample-018',
    occurred_at: '2026-09-23T12:00:00+08:00',
    source: '业务样例',
    meeting: {
      meeting_id: 'JDC-2026-037',
      title: '第三十七次联合药研委员会',
      convened_at: '2026-09-23T09:00:00+08:00',
    },
  });

  const t0 = '2026-09-01T08:00:00+08:00';
  // 成员资格：三家合作方各一席有表决权，另设观察员（无表决权）
  registerMembership(session, { member_id: 'M-ALPHA', party_id: 'P-ALPHA', party_name: '阿尔法生物', role: 'voting', version: 1, effective_from: t0 }, t0);
  registerMembership(session, { member_id: 'M-BETA', party_id: 'P-BETA', party_name: '贝塔制药', role: 'voting', version: 1, effective_from: t0 }, t0);
  registerMembership(session, { member_id: 'M-GAMMA', party_id: 'P-GAMMA', party_name: '伽马临床研究中心', role: 'voting', version: 1, effective_from: t0 }, t0);
  registerMembership(session, { member_id: 'M-OBS', party_id: 'P-GAMMA', party_name: '伽马临床研究中心', role: 'observer', version: 1, effective_from: t0 }, t0);

  // 贝塔代表出差：席位授权给代表 D-BETA
  registerDelegation(session, {
    member_id: 'M-BETA', delegate_id: 'D-BETA', delegate_name: '贝塔授权代表',
    version: 1, effective_from: '2026-09-15T00:00:00+08:00', effective_until: '2026-09-25T00:00:00+08:00',
  }, t0);

  // 职权：主席（追认安全动作）、安全官（发起安全紧急动作）、升级受理方
  registerOfficer(session, { role: 'chair', holder_id: 'M-ALPHA', version: 1, effective_from: t0 }, t0);
  registerOfficer(session, { role: 'safety_officer', holder_id: 'M-GAMMA', version: 1, effective_from: t0 }, t0);
  registerOfficer(session, { role: 'steering_group_chair', holder_id: 'M-ALPHA', version: 1, effective_from: t0 }, t0);

  // 议题范围：三项议题均在本次会议议程内
  registerAgendaScope(session, {
    scope_id: 'AS-037', version: 1, effective_from: t0,
    topics: ['milestone_payment', 'protocol_amendment', 'safety_hold'],
    motion_id: MOTION,
  }, t0);

  // 法定人数：有效成员三分之二；门槛：一般过半，方案变更三分之二，安全暂停需一致
  registerQuorumRule(session, { rule_id: 'QR-GENERAL', kind: 'fraction', numerator: 2, denominator: 3, version: 1, effective_from: t0 }, t0);
  registerThreshold(session, { threshold_id: 'TH-MAJORITY', kind: 'majority', basis: 'non_abstain', numerator: 1, denominator: 2, inclusive: false, version: 1, effective_from: t0 }, t0);
  registerThreshold(session, { threshold_id: 'TH-PROTOCOL', kind: 'supermajority', basis: 'eligible', numerator: 2, denominator: 3, topics: ['protocol_amendment'], version: 1, effective_from: t0 }, t0);
  registerThreshold(session, { threshold_id: 'TH-SAFETY', kind: 'unanimous', basis: 'non_abstain', topics: ['safety_hold'], version: 1, effective_from: t0 }, t0);

  // 材料版本（附件按合作方可见性控制）
  const bankDigest = digest({ kind: 'banking-schedule', v: 1 });
  registerMaterial(session, {
    material_id: 'MAT-MILESTONE', version: 1, title: '里程碑付款计划', motion_id: MOTION, section_id: MILESTONE,
    content_digest: digest({ doc: 'milestone schedule', v: 1 }), version_note: 'v1', effective_from: t0,
    attachments: [{
      attachment_id: 'ATT-BANK-1', filename: 'payment_accounts.xlsx', content_digest: bankDigest,
      visibility: { parties: ['P-ALPHA', 'P-BETA'] }, // 收款账户信息对伽马不可见
    }],
  }, t0);
  registerMaterial(session, {
    material_id: 'MAT-PROTOCOL', version: 1, title: '三期试验方案 C 稿', motion_id: MOTION, section_id: PROTOCOL,
    content_digest: digest({ doc: 'protocol', v: 1 }), effective_from: t0,
  }, t0);
  registerMaterial(session, {
    material_id: 'MAT-SAFETY', version: 1, title: 'SAE-2026-094 初步报告', motion_id: MOTION, section_id: SAFETY,
    content_digest: digest({ doc: 'sae report', v: 1 }), effective_from: '2026-09-20T18:00:00+08:00',
    attachments: [{
      attachment_id: 'ATT-SAE-1', filename: 'sae_raw_e2d4.pdf', content_digest: digest({ raw: 'sae' }),
      visibility: { parties: ['P-BETA', 'P-GAMMA'] }, // 原始病例对申办方阿尔法暂不可见
    }],
  }, '2026-09-20T18:00:00+08:00');

  // 议案提出（三章节）
  createMotion(session, {
    motion_id: MOTION,
    title: '关于 III 期项目第 4 里程碑付款、方案第 3 次修订及安全暂停的议案',
    introduced_at: '2026-09-16T09:30:00+08:00',
    sponsor_id: 'M-ALPHA',
    sections: [
      { section_id: MILESTONE, topic: 'milestone_payment', title: '第 4 里程碑付款', content: '付款 1.2 亿元', material_refs: ['MAT-MILESTONE'] },
      { section_id: PROTOCOL, topic: 'protocol_amendment', title: '方案第 3 次修订', content: '主要终点不变，样本量调整', material_refs: ['MAT-PROTOCOL'] },
      { section_id: SAFETY, topic: 'safety_hold', title: '301 中心安全暂停', content: '暂停入组 14 天', material_refs: ['MAT-SAFETY'] },
    ],
  });

  // 议案级评议窗口
  registerReviewWindow(session, {
    window_id: 'RW-037', motion_id: MOTION, version: 1,
    opens_at: '2026-09-16T10:00:00+08:00', closes_at: '2026-09-22T18:00:00+08:00',
    effective_from: '2026-09-16T10:00:00+08:00',
  }, '2026-09-16T10:00:00+08:00');

  // 方案章节 v1 期间的投票（修订后全部失效，需重签）
  castBallot(session, { motion_id: MOTION, section_id: PROTOCOL, authorization_id: 'seat:M-ALPHA', cast_by: 'M-ALPHA', seq: 1, choice: 'approve', salt: 'alpha-p-v1', now: '2026-09-17T09:00:00+08:00' });
  castBallot(session, { motion_id: MOTION, section_id: PROTOCOL, authorization_id: 'seat:M-BETA', cast_by: 'D-BETA', seq: 1, choice: 'approve', salt: 'dbeta-p-v1', now: '2026-09-17T09:10:00+08:00' });
  castBallot(session, { motion_id: MOTION, section_id: PROTOCOL, authorization_id: 'seat:M-GAMMA', cast_by: 'M-GAMMA', seq: 1, choice: 'approve', salt: 'gamma-p-v1', now: '2026-09-17T09:20:00+08:00' });

  // 方案章节修订（监管反馈），材料同步刷新 v2：仅该章节需重签
  registerMaterial(session, {
    material_id: 'MAT-PROTOCOL', version: 2, title: '三期试验方案 C 稿（监管反馈修订）', motion_id: MOTION, section_id: PROTOCOL,
    content_digest: digest({ doc: 'protocol', v: 2 }), effective_from: '2026-09-19T08:00:00+08:00',
  }, '2026-09-19T08:00:00+08:00');
  reviseMotion(session, MOTION, {
    at: '2026-09-19T10:00:00+08:00',
    changed_sections: [PROTOCOL],
    rationale: '按药监 9 月 18 日反馈补充安全性随访',
    editor_id: 'M-GAMMA',
    section_updates: [{ section_id: PROTOCOL, content: '主要终点不变，样本量调整，新增 30 日安全性随访' }],
    materials_refreshed: { [PROTOCOL]: ['MAT-PROTOCOL@v2'] },
  });

  // 里程碑章节投票
  castBallot(session, { motion_id: MOTION, section_id: MILESTONE, authorization_id: 'seat:M-ALPHA', cast_by: 'M-ALPHA', seq: 1, choice: 'approve', salt: 'alpha-m-1', now: '2026-09-20T09:00:00+08:00' });
  castBallot(session, { motion_id: MOTION, section_id: MILESTONE, authorization_id: 'seat:M-BETA', cast_by: 'D-BETA', seq: 1, choice: 'approve', salt: 'dbeta-m-1', now: '2026-09-20T09:15:00+08:00' });

  // 安全暂停投票（伽马弃权并将保留少数意见）
  castBallot(session, { motion_id: MOTION, section_id: SAFETY, authorization_id: 'seat:M-ALPHA', cast_by: 'M-ALPHA', seq: 1, choice: 'approve', salt: 'alpha-s-1', now: '2026-09-20T10:00:00+08:00' });
  castBallot(session, { motion_id: MOTION, section_id: SAFETY, authorization_id: 'seat:M-BETA', cast_by: 'D-BETA', seq: 1, choice: 'approve', salt: 'dbeta-s-1', now: '2026-09-20T10:15:00+08:00' });

  // 安全紧急动作：安全官不等表决直接暂停，主席 48 小时内追认
  safetyEmergencyAction(session, {
    action_id: 'ACT-SAFE-1', actor_id: 'M-GAMMA', role: 'safety_officer',
    motion_id: MOTION, section_id: SAFETY, measure: 'pause',
    reason: '301 中心报告两例可疑严重不良事件',
    review_by: '2026-09-23T11:00:00+08:00', now: '2026-09-21T11:00:00+08:00',
  });
  ratifySafetyAction(session, 'ACT-SAFE-1', { ratified_by: 'M-ALPHA', now: '2026-09-22T09:30:00+08:00' });

  // 伽马离线期间生成两条带序列的密封意见（seq1 否决、seq2 条件性批准），返岗后一并交秘书处
  castBallot(session, {
    motion_id: MOTION, section_id: MILESTONE, authorization_id: 'seat:M-GAMMA', cast_by: 'M-GAMMA',
    seq: 1, choice: 'reject', salt: 'gamma-m-offline-1',
    cast_at: '2026-09-21T20:00:00+08:00', now: '2026-09-22T08:55:00+08:00',
  });
  castBallot(session, {
    motion_id: MOTION, section_id: MILESTONE, authorization_id: 'seat:M-GAMMA', cast_by: 'M-GAMMA',
    seq: 2, choice: 'conditional',
    conditions: [{ text: '付款前完成独立财务审计并向委员会报告', owner_party: 'P-ALPHA', due_at: '2026-10-31T18:00:00+08:00' }],
    salt: 'gamma-m-offline-2',
    cast_at: '2026-09-21T21:00:00+08:00', now: '2026-09-22T08:56:00+08:00',
  });

  // 方案修订后的重签投票
  castBallot(session, { motion_id: MOTION, section_id: PROTOCOL, authorization_id: 'seat:M-ALPHA', cast_by: 'M-ALPHA', seq: 2, choice: 'approve', salt: 'alpha-p-v2', now: '2026-09-22T11:00:00+08:00' });
  castBallot(session, { motion_id: MOTION, section_id: PROTOCOL, authorization_id: 'seat:M-BETA', cast_by: 'D-BETA', seq: 2, choice: 'approve', salt: 'dbeta-p-v2', now: '2026-09-22T11:10:00+08:00' });
  castBallot(session, { motion_id: MOTION, section_id: PROTOCOL, authorization_id: 'seat:M-GAMMA', cast_by: 'M-GAMMA', seq: 2, choice: 'approve', salt: 'gamma-p-v2', now: '2026-09-22T11:20:00+08:00' });

  // 伽马安全暂停弃权 + 少数意见（任何修订都不能覆盖）
  const gammaSafety = castBallot(session, { motion_id: MOTION, section_id: SAFETY, authorization_id: 'seat:M-GAMMA', cast_by: 'M-GAMMA', seq: 1, choice: 'abstain', salt: 'gamma-s-1', now: '2026-09-22T16:00:00+08:00' });
  appendMinorityOpinion(session, {
    opinion_id: 'OP-001', motion_id: MOTION, section_id: SAFETY, ballot_id: gammaSafety.ballot_id,
    author_holder_id: 'M-GAMMA', revision: 1, at: '2026-09-22T17:00:00+08:00',
    text: '同意暂停入组，但主张暂停范围应限定于 301 中心而非全部中心，以免延误整体试验。',
  });

  // 开票：窗口关闭后统一揭示（含方案 v1 旧票与被高序列取代的 seq1，全部留账目）
  const revealAt = '2026-09-22T18:30:00+08:00';
  const reveals = {
    'alpha-p-v1': { choice: 'approve' }, 'dbeta-p-v1': { choice: 'approve' }, 'gamma-p-v1': { choice: 'approve' },
    'alpha-m-1': { choice: 'approve' }, 'dbeta-m-1': { choice: 'approve' },
    'alpha-s-1': { choice: 'approve' }, 'dbeta-s-1': { choice: 'approve' },
    'gamma-m-offline-1': { choice: 'reject' },
    'gamma-m-offline-2': { choice: 'conditional', conditions: [{ text: '付款前完成独立财务审计并向委员会报告', owner_party: 'P-ALPHA', due_at: '2026-10-31T18:00:00+08:00' }] },
    'alpha-p-v2': { choice: 'approve' }, 'dbeta-p-v2': { choice: 'approve' }, 'gamma-p-v2': { choice: 'approve' },
    'gamma-s-1': { choice: 'abstain' },
  };
  for (const ballot of session.ballots) {
    const match = Object.entries(reveals).find(([salt, payload]) =>
      sealBallot({
        motion_id: ballot.motion_id,
        section_id: ballot.section_id,
        section_revision: ballot.section_revision,
        authorization_id: ballot.authorization_id,
        seq: ballot.seq,
        choice: payload.choice,
        conditions: payload.conditions ?? [],
        salt,
      }) === ballot.commitment,
    );
    if (!match) throw new Error(`开票失败：找不到 ${ballot.ballot_id} 的盐值`);
    const [salt, payload] = match;
    revealBallot(session, ballot.ballot_id, { choice: payload.choice, conditions: payload.conditions ?? [], salt, now: revealAt });
  }

  // 会议当天临时披露：阿尔法为收款方，对里程碑章节回避——法定人数与计票据此重算
  registerRecusal(session, {
    recusal_id: 'REC-ALPHA-M', member_id: 'M-ALPHA', motion_id: MOTION, sections: [MILESTONE],
    reason: '里程碑付款直接收款方，临时披露利益冲突',
    version: 1, effective_from: '2026-09-23T08:30:00+08:00',
  }, '2026-09-23T08:30:00+08:00');

  // 宣布（重算采用临时回避后的有效成员集合）
  announceDecision(session, {
    decision_id: 'DEC-2026-031', motion_id: MOTION,
    section_ids: [MILESTONE, PROTOCOL, SAFETY],
    at: '2026-09-23T10:00:00+08:00', declared_by: 'M-ALPHA',
  });

  // 通知：两家送达，贝塔渠道投递失败——决定照常落账，失败项留在秘书处待办
  recordNotice(session, { notice_id: 'NTC-1', decision_id: 'DEC-2026-031', recipient_id: 'P-ALPHA', channel: 'secure_mail', status: 'delivered', attempted_at: '2026-09-23T10:05:00+08:00' }, '2026-09-23T10:05:00+08:00');
  recordNotice(session, { notice_id: 'NTC-2', decision_id: 'DEC-2026-031', recipient_id: 'P-GAMMA', channel: 'secure_mail', status: 'delivered', attempted_at: '2026-09-23T10:05:00+08:00' }, '2026-09-23T10:05:00+08:00');
  recordNotice(session, { notice_id: 'NTC-3', decision_id: 'DEC-2026-031', recipient_id: 'P-BETA', channel: 'secure_mail', status: 'failed', failure_reason: '550 mailbox temporarily unavailable', attempted_at: '2026-09-23T10:06:00+08:00' }, '2026-09-23T10:06:00+08:00');

  return session;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'committee_session.json');
  await writeFile(out, JSON.stringify(exportSession(buildSampleSession()), null, 2) + '\n', 'utf8');
  console.log(`已写出 ${out}`);
}
