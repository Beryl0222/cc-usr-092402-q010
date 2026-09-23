/**
 * 生成 v2 端到端业务样例 fixtures/committee_council.json。
 * 场景：M-018 议案同时含里程碑付款、方案变更、安全暂停；
 * 临时回避改变法定人数、离线密封票、授权不重复计票、修订只重签受影响议题、
 * 僵局升级、条件批准、安全紧急动作与追认、宣布后更正、通知失败挂账、
 * 按合作方脱敏附件的纪要。
 * 运行：node scripts/generate_fixture.mjs
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as B from '../src/builder.js';
import { issueKey } from '../src/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const record = B.createCouncil({
  record_id: 'sample-018',
  occurred_at: '2026-09-20T09:00:00+08:00',
});
const R = record;
const MO = 'MO-018';
const T_MILE = 'T-MILESTONE';
const T_PROTO = 'T-PROTOCOL';
const T_SAFE = 'T-SAFETY';
const T_ENROLL = 'T-ENROLL';
const T_RAT = 'T-RATIFY';

// ── 规则 v1（2026-09-19 生效）：法定人数按“扣回避后有效席位”过半 ──
B.addQuorumRule(R, {
  rule_id: 'QR-001', scope: { kind: '*' }, basis: 'eligible',
  ratio_num: 1, ratio_den: 2, effective_from: '2026-09-19T00:00:00+08:00',
});
// 一般门槛：非弃权票严格过半（平局不通过 → 僵局）；方案变更：出席票三分之二（达到即可）。
B.addThresholdRule(R, {
  rule_id: 'TR-001', scope: { kind: '*' }, basis: 'voting', mode: 'strict',
  ratio_num: 1, ratio_den: 2, effective_from: '2026-09-19T00:00:00+08:00',
});
B.addThresholdRule(R, {
  rule_id: 'TR-002', scope: { kind: 'topic_kind', value: 'protocol_change' }, basis: 'present', mode: 'weak',
  ratio_num: 2, ratio_den: 3, effective_from: '2026-09-19T00:00:00+08:00',
});

// ── 6 个席位，分属三方；M6 资格于 09-24 晚到期 ──
const seats = [
  ['M1', 'ALPHA', '临床负责人'],
  ['M2', 'ALPHA', '生物统计师'],
  ['M3', 'BETA', '医学总监'],
  ['M4', 'BETA', '药学负责人'],
  ['M5', 'GAMMA', '独立委员（第三方研究机构）'],
  ['M6', 'DELTA', '独立安全委员'],
];
for (const [member_id, party, role] of seats) {
  B.seatMember(R, {
    member_id, party, role,
    effective_from: '2026-09-19T00:00:00+08:00',
    effective_to: member_id === 'M6' ? '2026-09-24T20:00:00+08:00' : null,
  });
}

// M2 出差离线：09-20 起将表决权授权给 M1（09-26 前有效）。
B.delegate(R, {
  delegation_id: 'DLG-M2-M1', delegator_member_id: 'M2', delegate_member_id: 'M1',
  scope_topics: null,
  effective_from: '2026-09-20T08:00:00+08:00',
  effective_to: '2026-09-26T18:00:00+08:00',
});

// ── 议案立案（rev1）：三类议题 + 一个入组议题 ──
B.createMotion(R, {
  motion_id: MO, opened_at: '2026-09-20T09:00:00+08:00',
  title: 'M3 里程碑付款、试验方案第 4 版与 SAE 后安全暂停',
  topics: [
    { topic_id: T_MILE, kind: 'milestone_payment', title: 'M3 里程碑付款 5,000 万元' },
    { topic_id: T_PROTO, kind: 'protocol_change', title: '试验方案第 4 版：新增 II 期扩展队列' },
    { topic_id: T_SAFE, kind: 'safety', title: 'SAE-2026-014 后安全暂停决定' },
    { topic_id: T_ENROLL, kind: 'operational', title: '入组加速与站点预算追加' },
    { topic_id: T_RAT, kind: 'ratification', title: '安全紧急暂停的委员会追认' },
  ],
});

// ── 材料 v1：附件按合作方权限标记可见范围 ──
B.publishMaterial(R, {
  material_id: 'MAT-018', motion_id: MO, version_seq: 1,
  supersedes: null, published_at: '2026-09-20T10:00:00+08:00',
  title: 'M-018 议案材料（v1）',
  summary: '含 M3 里程碑付款测算、方案第 4 版全文、SAE-2026-014 初步安全性报告。',
  body: '【脱敏正文 v1】里程碑：III 期主要终点达成，发票要件齐备。方案：新增扩展队列 120 例。安全：1 例致死性 SAE，疑与试验用药相关。',
  attachments: [
    { attachment_id: 'ATT-PRICE', title: '里程碑单价测算（仅限发起方）', visible_to: ['ALPHA'] },
    { attachment_id: 'ATT-IP', title: '知识产权附录', visible_to: ['ALPHA', 'BETA'] },
    { attachment_id: 'ATT-CRO', title: 'CRO 监查报告', visible_to: ['*'] },
  ],
});

// ── 三个 rev1 评议窗口（钉住材料 v1） ──
const winCommon = {
  opens_at: '2026-09-21T09:00:00+08:00',
  closes_at: '2026-09-22T18:00:00+08:00',
  materials: [{ material_id: 'MAT-018', version_seq: 1 }],
};
const W_MILE = B.openWindow(R, { issue_key: issueKey(T_MILE, 1), ...winCommon });
const W_PROTO = B.openWindow(R, { issue_key: issueKey(T_PROTO, 1), ...winCommon });
const W_ENROLL = B.openWindow(R, { issue_key: issueKey(T_ENROLL, 1), ...winCommon });

/** 投密封票：离线端先封存再投递，开票时再揭示。 */
function sealed(vote) {
  const { commitment } = B.sealEnvelope(vote.envelope);
  const { receipt } = B.submitSealed(R, { ...vote, commitment });
  return receipt;
}

// ── 里程碑票（09-21）：临时回避、授权改票、越权票、未开票票 ──
sealed({
  vote_id: 'V-MILE-M1', issue_key: issueKey(T_MILE, 1), window_id: W_MILE,
  voter_member_id: 'M1', seq: 1, received_at: '2026-09-21T09:05:00+08:00',
  envelope: { position: 'approve', opinion: '', nonce: 'n-mile-m1' },
});
// M1 代 M2 先投赞成（seq1），同日改投反对并附少数意见（seq2）——同席位只计 seq2。
sealed({
  vote_id: 'V-MILE-M2-S1', issue_key: issueKey(T_MILE, 1), window_id: W_MILE,
  voter_member_id: 'M1', delegation_id: 'DLG-M2-M1', seq: 1,
  received_at: '2026-09-21T09:08:00+08:00',
  envelope: { position: 'approve', opinion: '', nonce: 'n-mile-m2-s1' },
});
sealed({
  vote_id: 'V-MILE-M2-S2', issue_key: issueKey(T_MILE, 1), window_id: W_MILE,
  voter_member_id: 'M1', delegation_id: 'DLG-M2-M1', seq: 2,
  received_at: '2026-09-21T12:40:00+08:00',
  envelope: {
    position: 'disapprove',
    opinion: '独立数据复核尚未完成，M3 付款要件存在实质瑕疵，要求暂缓。',
    nonce: 'n-mile-m2-s2',
  },
});
// M2 本人又亲自投了一票：其席位持有权已归 M1，该票剔除（同一授权不得重复计票）。
sealed({
  vote_id: 'V-MILE-M2-OWN', issue_key: issueKey(T_MILE, 1), window_id: W_MILE,
  voter_member_id: 'M2', seq: 1, received_at: '2026-09-21T10:00:00+08:00',
  envelope: { position: 'approve', opinion: '', nonce: 'n-mile-m2-own' },
});
// M3 在 09:15 投递密封反对；09:30 临时披露里程碑付款关联利益 —— 尚未宣布，结果重算。
sealed({
  vote_id: 'V-MILE-M3', issue_key: issueKey(T_MILE, 1), window_id: W_MILE,
  voter_member_id: 'M3', seq: 1, received_at: '2026-09-21T09:15:00+08:00',
  envelope: { position: 'disapprove', opinion: '付款节奏应与入组率挂钩。', nonce: 'n-mile-m3' },
});
B.discloseRecusal(R, {
  recusal_id: 'RCU-M3-MILE', member_id: 'M3',
  subject: { kind: 'topic', id: T_MILE },
  reason: 'BETA 为 M3 里程碑付款的关联收款方，会前补充披露。',
  disclosed_at: '2026-09-21T09:30:00+08:00',
});
sealed({
  vote_id: 'V-MILE-M4', issue_key: issueKey(T_MILE, 1), window_id: W_MILE,
  voter_member_id: 'M4', seq: 1, received_at: '2026-09-21T15:20:00+08:00',
  envelope: { position: 'approve', opinion: '', nonce: 'n-mile-m4' },
});
sealed({
  vote_id: 'V-MILE-M5', issue_key: issueKey(T_MILE, 1), window_id: W_MILE,
  voter_member_id: 'M5', seq: 1, received_at: '2026-09-21T16:02:00+08:00',
  envelope: {
    position: 'abstain',
    opinion: '等待独立数据复核报告；弃权不构成对付款的反对。',
    nonce: 'n-mile-m5',
  },
});
// M6 的票开票会前仍处密封：宣布时只能确认收讫。
sealed({
  vote_id: 'V-MILE-M6', issue_key: issueKey(T_MILE, 1), window_id: W_MILE,
  voter_member_id: 'M6', seq: 1, received_at: '2026-09-21T17:30:00+08:00',
  envelope: { position: 'approve', opinion: '', nonce: 'n-mile-m6' },
});

// 开票（09-23 09:00）：除 M6 外逐一揭示；秘书处此前只持有收讫回执。
for (const [vid, env] of [
  ['V-MILE-M1', { position: 'approve', opinion: '', nonce: 'n-mile-m1' }],
  ['V-MILE-M2-S1', { position: 'approve', opinion: '', nonce: 'n-mile-m2-s1' }],
  ['V-MILE-M2-S2', { position: 'disapprove', opinion: '独立数据复核尚未完成，M3 付款要件存在实质瑕疵，要求暂缓。', nonce: 'n-mile-m2-s2' }],
  ['V-MILE-M2-OWN', { position: 'approve', opinion: '', nonce: 'n-mile-m2-own' }],
  ['V-MILE-M3', { position: 'disapprove', opinion: '付款节奏应与入组率挂钩。', nonce: 'n-mile-m3' }],
  ['V-MILE-M4', { position: 'approve', opinion: '', nonce: 'n-mile-m4' }],
  ['V-MILE-M5', { position: 'abstain', opinion: '等待独立数据复核报告；弃权不构成对付款的反对。', nonce: 'n-mile-m5' }],
]) {
  B.revealVote(R, vid, env, '2026-09-23T09:00:00+08:00');
}
// M6 直到 09-24 才揭示 —— 里程碑早已宣布，迟到揭示不能改变已冻结结果。
B.revealVote(R, 'V-MILE-M6', { position: 'approve', opinion: '', nonce: 'n-mile-m6' }, '2026-09-24T09:00:00+08:00');

// ── 方案变更 rev1 票：4 赞成 2 反对，恰好达到 2/3 ──
const protoEnvelopes = [
  ['V-PROTO-M1', 'M1', null, 1, 'approve', '', 'n-proto-m1'],
  ['V-PROTO-M2', 'M1', 'DLG-M2-M1', 1, 'approve', '', 'n-proto-m2'],
  ['V-PROTO-M3', 'M3', null, 1, 'approve', '', 'n-proto-m3'],
  ['V-PROTO-M4', 'M4', null, 1, 'approve', '', 'n-proto-m4'],
  ['V-PROTO-M5', 'M5', null, 1, 'disapprove',
    '扩展队列 120 例缺乏 II 期安全性支撑，样本量论证不成立。', 'n-proto-m5',
    [{ attachment_id: 'ATT-DISSENT-PROTO', title: 'M5 少数意见原件', visible_to: ['GAMMA'] }]],
  ['V-PROTO-M6', 'M6', null, 1, 'disapprove',
    '安全委员认为应在暂停调查结论作出后再议扩展队列。', 'n-proto-m6'],
];
for (const [vid, voter, dlg, sq, position, opinion, nonce, attachments] of protoEnvelopes) {
  sealed({
    vote_id: vid, issue_key: issueKey(T_PROTO, 1), window_id: W_PROTO,
    voter_member_id: voter, delegation_id: dlg, seq: sq,
    received_at: '2026-09-21T18:00:00+08:00',
    envelope: { position, opinion, nonce, attachments: attachments ?? [] },
  });
  B.revealVote(R, vid, { position, opinion, nonce, attachments: attachments ?? [] }, '2026-09-23T10:30:00+08:00');
}

// ── 入组议题票：2:2 僵局 ──
const enrollEnvelopes = [
  ['V-ENR-M1', 'M1', null, 'approve', ''],
  ['V-ENR-M2', 'M1', 'DLG-M2-M1', 'approve', ''],
  ['V-ENR-M3', 'M3', null, 'disapprove', '预算追加无依据。'],
  ['V-ENR-M4', 'M4', null, 'disapprove', '站点能力不支持加速。'],
];
for (const [vid, voter, dlg, position, opinion] of enrollEnvelopes) {
  sealed({
    vote_id: vid, issue_key: issueKey(T_ENROLL, 1), window_id: W_ENROLL,
    voter_member_id: voter, delegation_id: dlg, seq: 1,
    received_at: '2026-09-22T11:00:00+08:00',
    envelope: { position, opinion, nonce: `n-${vid.toLowerCase()}` },
  });
  B.revealVote(R, vid, { position, opinion, nonce: `n-${vid.toLowerCase()}` }, '2026-09-23T13:00:00+08:00');
}

// ── 安全紧急动作：DSMB 直接下令暂停，立即落账，不等法定人数 ──
B.invokeEmergency(R, {
  emergency_action_id: 'EMR-HOLD-014',
  topic_id: T_SAFE,
  title: 'SAE-2026-014 后全部站点给药暂停',
  authority: 'DSMB（数据与安全监察委员会）当值安全监察官',
  invoked_at: '2026-09-22T23:40:00+08:00',
  basis: '《联合开发安全章程》第 12 条：可疑非预期严重不良反应可先行暂停。',
  action: 'safety_hold',
  ratification_window: { opens_at: '2026-09-23T08:00:00+08:00', closes_at: '2026-09-24T18:00:00+08:00' },
  ratification_deadline: '2026-09-25T23:40:00+08:00', // 72 小时追认期限
});
const W_RAT = B.openWindow(R, {
  issue_key: issueKey(T_RAT, 1),
  opens_at: '2026-09-23T08:00:00+08:00',
  closes_at: '2026-09-24T18:00:00+08:00',
  materials: [{ material_id: 'MAT-018', version_seq: 1 }],
});
const ratEnvelopes = [
  ['V-RAT-M1', 'M1', null, 'approve', ''],
  ['V-RAT-M2', 'M1', 'DLG-M2-M1', 'approve', ''],
  ['V-RAT-M3', 'M3', null, 'approve', ''],
  ['V-RAT-M4', 'M4', null, 'disapprove', '暂停范围过宽，建议仅限相关批次与站点。'],
  ['V-RAT-M5', 'M5', null, 'approve', ''],
  ['V-RAT-M6', 'M6', null, 'approve', ''],
];
for (const [vid, voter, dlg, position, opinion] of ratEnvelopes) {
  sealed({
    vote_id: vid, issue_key: issueKey(T_RAT, 1), window_id: W_RAT,
    voter_member_id: voter, delegation_id: dlg, seq: 1,
    received_at: '2026-09-24T10:00:00+08:00',
    envelope: { position, opinion, nonce: `n-${vid.toLowerCase()}` },
  });
  B.revealVote(R, vid, { position, opinion, nonce: `n-${vid.toLowerCase()}` }, '2026-09-24T18:30:00+08:00');
}

// ── 宣布（冻结计票包；通知失败不阻断落账） ──
const ANN_MILE = B.announce(R, MO, T_MILE, { as_of: '2026-09-23T10:00:00+08:00' }).announcement_id;
B.registerNotification(R, {
  about: { kind: 'announcement', id: ANN_MILE }, channel: 'secure_email',
  attempts: [
    { at: '2026-09-23T10:05:00+08:00', ok: false, error: 'bounce: mailbox_full' },
    { at: '2026-09-23T10:30:00+08:00', ok: false, error: 'bounce: mailbox_full' },
  ],
  status: 'failed',
});
const ANN_PROTO_R1 = B.announce(R, MO, T_PROTO, { as_of: '2026-09-23T11:30:00+08:00' }).announcement_id;
const ANN_ENROLL = B.announce(R, MO, T_ENROLL, { as_of: '2026-09-23T14:00:00+08:00' }).announcement_id;

// ── 僵局升级：本级 5 个自然日期限内裁决 ──
const ESC = B.openEscalation(R, {
  issue_key: issueKey(T_ENROLL, 1), motion_id: MO,
  tier: 1, authority: '联合指导委员会（JSC）',
  opened_at: '2026-09-23T15:00:00+08:00',
  deadline: '2026-09-28T15:00:00+08:00',
});
B.resolveEscalation(R, ESC, {
  at: '2026-09-27T11:00:00+08:00',
  resolution: 'JSC 裁决维持现行入组节奏，预算追加请求驳回；僵局终结。',
});
B.registerNotification(R, {
  notification_id: 'NTF-ESC', about: { kind: 'escalation', id: ESC }, channel: 'portal',
  attempts: [{ at: '2026-09-27T11:05:00+08:00', ok: true }], status: 'delivered',
});

// 追认宣布并回填（M6 资格 20:00 才到期，19:00 仍为有效席位）。
const ANN_RAT = B.announce(R, MO, T_RAT, { as_of: '2026-09-24T19:00:00+08:00' }).announcement_id;
B.recordRatification(R, 'EMR-HOLD-014', {
  ratification_issue_key: issueKey(T_RAT, 1), ratified_at: '2026-09-24T19:15:00+08:00',
});
B.registerNotification(R, {
  notification_id: 'NTF-EMR', about: { kind: 'emergency', id: 'EMR-HOLD-014' }, channel: 'sms',
  attempts: [
    { at: '2026-09-22T23:45:00+08:00', ok: false, error: 'gateway_timeout' },
    { at: '2026-09-23T00:30:00+08:00', ok: true },
  ],
  status: 'delivered', resolved_at: '2026-09-23T00:30:00+08:00',
});

// ── 议案 rev2（09-24 中午）：仅方案变更的统计章节受影响 ──
B.publishMaterial(R, {
  material_id: 'MAT-018', motion_id: MO, version_seq: 2, supersedes: 1,
  published_at: '2026-09-24T11:00:00+08:00',
  title: 'M-018 议案材料（v2）',
  summary: '据 SAE 调查更新安全性章节；补充扩展队列样本量重估与 II 期安全性桥接说明。',
  body: '【脱敏正文 v2】新增扩展队列降为 80 例；安全性桥接采用 II 期全部队列数据。',
  attachments: [
    { attachment_id: 'ATT-PRICE', title: '里程碑单价测算（仅限发起方）', visible_to: ['ALPHA'] },
    { attachment_id: 'ATT-IP', title: '知识产权附录', visible_to: ['ALPHA', 'BETA'] },
    { attachment_id: 'ATT-CRO', title: 'CRO 监查报告', visible_to: ['*'] },
  ],
});
B.reviseMotion(R, MO, {
  revision_seq: 2, at: '2026-09-24T12:00:00+08:00',
  changed_topic_ids: [T_PROTO],
  note: '据暂停调查结论重估扩展队列样本量；里程碑与安全议题内容不变。',
});

// 经查 M4 对方案议题的关联关系自始存在（rev1 投票时即应回避）——
// 宣布后的错误进入公开更正程序，不回改原宣布。
B.discloseRecusal(R, {
  recusal_id: 'RCU-M4-PROTO', member_id: 'M4',
  subject: { kind: 'topic', id: T_PROTO },
  reason: 'M4 配偶持有扩展队列 CRO 服务商股权，事后核查确认回避关系自 09-21 起存在。',
  disclosed_at: '2026-09-26T10:00:00+08:00',
  effective_from: '2026-09-21T00:00:00+08:00',
});
B.correctAnnouncement(R, ANN_PROTO_R1, {
  issued_at: '2026-09-26T11:00:00+08:00',
  kind: 'eligibility',
  explanation:
    'M4 在 T-PROTOCOL@r1 表决时依法应当回避而未回避。按原宣布时点重算：有效席位 5、' +
    '计票 3 赞成 2 反对，低于方案变更 2/3 门槛；rev1 批准结论更正为不通过。少数意见原样保留。',
  recount_as_of: '2026-09-23T11:30:00+08:00',
});
B.registerNotification(R, {
  notification_id: 'NTF-COR', about: { kind: 'correction', id: ANN_PROTO_R1 }, channel: 'portal',
  attempts: [{ at: '2026-09-26T11:05:00+08:00', ok: true }], status: 'delivered',
});
// rev2 重投：回避关系持续在册（利益剥离完成前 M4 不得就方案议题投票），
// 且 M6 资格已到期 —— 有效席位 4。M4 的票按资格剔除。

// ── 仅受影响议题（方案变更）重签 rev2；条件性批准 ──
B.addCondition(R, MO, {
  condition_id: 'CND-QUEUE-SAFETY', topic_id: T_PROTO,
  text: '扩展队列启动前须提交 II 期全部队列的桥接安全性分析并获安全委员会签收。',
  deadline: '2026-10-15T18:00:00+08:00',
});
const W_PROTO2 = B.openWindow(R, {
  issue_key: issueKey(T_PROTO, 2),
  opens_at: '2026-09-25T09:00:00+08:00',
  closes_at: '2026-09-25T17:00:00+08:00',
  materials: [{ material_id: 'MAT-018', version_seq: 2 }],
});
const proto2 = [
  ['V-P2-M1', 'M1', null, 'approve', ''],
  ['V-P2-M2', 'M1', 'DLG-M2-M1', 'approve', ''],
  ['V-P2-M3', 'M3', null, 'approve', ''],
  ['V-P2-M4', 'M4', null, 'approve', ''], // 持续回避：该票剔除
  ['V-P2-M5', 'M5', null, 'approve', '赞成附条件：桥接安全性分析必须按期提交并经签收。'],
];
for (const [vid, voter, dlg, position, opinion] of proto2) {
  sealed({
    vote_id: vid, issue_key: issueKey(T_PROTO, 2), window_id: W_PROTO2,
    voter_member_id: voter, delegation_id: dlg, seq: 1,
    received_at: '2026-09-25T10:00:00+08:00',
    envelope: { position, opinion, nonce: `n-${vid.toLowerCase()}` },
  });
  B.revealVote(R, vid, { position, opinion, nonce: `n-${vid.toLowerCase()}` }, '2026-09-25T17:30:00+08:00');
}
B.announce(R, MO, T_PROTO, {
  as_of: '2026-09-25T18:00:00+08:00',
  condition_ids: ['CND-QUEUE-SAFETY'],
});
B.satisfyCondition(R, MO, 'CND-QUEUE-SAFETY', '2026-09-30T14:00:00+08:00');

await writeFile(
  join(here, '..', 'fixtures', 'committee_council.json'),
  `${JSON.stringify(record, null, 2)}\n`,
  'utf8',
);
console.log('已生成 fixtures/committee_council.json');
