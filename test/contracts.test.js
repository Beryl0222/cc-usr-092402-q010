import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { loadRecord, migrateV1, digest } from '../src/contracts.js';
import { createCouncil, submitSealed, sealEnvelope } from '../src/builder.js';
import {
  tallyIssue,
  eligibleSeats,
  renderMinutes,
  announcementView,
  approvalContinuity,
  emergencyStatus,
  secretaryTodos,
  commitmentFor,
  issueKey,
} from '../src/engine.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => join(here, '..', 'fixtures', name);

const MO = 'MO-018';
const MILE = 'T-MILESTONE';
const PROTO = 'T-PROTOCOL';
const ENROLL = 'T-ENROLL';
const SAFE = 'T-SAFETY';
const RAT = 'T-RATIFY';

async function loadCouncil() {
  return loadRecord(fx('committee_council.json'));
}

test('v1 样例自动迁移且保留既有标识与时间含义', async () => {
  const v1 = JSON.parse(await readFile(fx('committee_motion.json'), 'utf8'));
  const v2 = migrateV1(v1);
  assert.equal(v2.record_id, 'sample-018');
  assert.equal(v2.occurred_at, '2026-09-20T09:00:00+08:00');
  assert.equal(v2.revision, 1);
  assert.equal(v2.domain, 'drug_council');
  assert.equal(v2.source, '业务样例');
  assert.equal(v2.migrated_from, 1);
  assert.equal(v2.council.committee_id, 'sample-018');
  // 直接读 v1 文件也应通过 loadRecord 得到可用 v2 记录。
  const loaded = await loadRecord(fx('committee_motion.json'));
  assert.equal(loaded.schema_version, 2);
});

test('v2 样例通过结构校验', async () => {
  const r = await loadCouncil();
  assert.equal(r.schema_version, 2);
  assert.ok(r.council.announcements.length >= 4);
});

test('临时回避在计票时点重算法定人数：M3 披露后有效席位 6→5', async () => {
  const r = await loadCouncil();
  const before = eligibleSeats(r, MO, MILE, '2026-09-21T09:20:00+08:00');
  const after = eligibleSeats(r, MO, MILE, '2026-09-21T10:00:00+08:00');
  assert.equal(before.length, 6);
  assert.equal(after.length, 5);
  assert.ok(!after.some((s) => s.seat_member_id === 'M3'));
});

test('里程碑宣布冻结：2 赞成 1 反对 1 弃权，达到扣回避后过半', async () => {
  const r = await loadCouncil();
  const t = tallyIssue(r, MO, MILE, '2026-09-23T10:00:00+08:00');
  assert.equal(t.outcome, 'approved');
  assert.equal(t.counts.eligible, 5);
  assert.equal(t.counts.present, 4);
  assert.equal(t.counts.quorum_required, 3);
  assert.deepEqual(t.counts, {
    eligible: 5, seated: 6, present: 4, quorum_required: 3,
    threshold_num: 1, threshold_den: 2, threshold_basis: 'voting', threshold_mode: 'strict',
    approve: 2, disapprove: 1, abstain: 1,
  });
  assert.deepEqual(t.included_votes, ['V-MILE-M1', 'V-MILE-M2-S2', 'V-MILE-M4', 'V-MILE-M5']);
  const reasons = new Map(t.excluded_votes.map((x) => [x.vote_id, x.reason]));
  assert.equal(reasons.get('V-MILE-M2-S1'), 'superseded_within_seat');
  assert.equal(reasons.get('V-MILE-M2-OWN'), 'authorization_mismatch');
  assert.equal(reasons.get('V-MILE-M3'), 'seat_ineligible');
  // M6 尚未揭示：只能确认收讫，不参与统计。
  assert.deepEqual(t.received_only.map((x) => x.vote_id), ['V-MILE-M6']);
  // 少数意见保留两张（反对 + 弃权且附理由）。
  assert.equal(t.minority_opinions.length, 2);
});

test('开票前密封意见只产生收讫确认，不泄露内容', async () => {
  const r = await loadCouncil();
  const raw = JSON.parse(await readFile(fx('committee_council.json'), 'utf8'));
  // M6 迟到揭示：揭示时点晚于宣布，无法进入已冻结结果。
  const m6 = raw.council.votes.find((v) => v.vote_id === 'V-MILE-M6');
  assert.ok(m6.commitment);
  assert.ok(m6.opened_at > '2026-09-23T10:00:00+08:00');
  // 提交时系统返回的回执不含任何立场或意见内容。
  const scratch = createCouncil({ record_id: 'tmp', occurred_at: '2026-09-21T00:00:00+08:00' });
  const { receipt } = submitSealed(scratch, {
    vote_id: 'V-TMP', issue_key: 'X@r1', window_id: 'W-TMP',
    voter_member_id: 'M1', seq: 1, received_at: '2026-09-21T09:00:00+08:00',
    commitment: sealEnvelope({ position: 'approve', nonce: 'n' }).commitment,
  });
  assert.deepEqual(Object.keys(receipt).sort(), ['commitment', 'issue_key', 'received_at', 'seq', 'status', 'vote_id']);
  assert.equal(receipt.status, 'received_sealed');
  // 开票前任一时点复算：8 张票全部只计收讫，出席为 0。
  const early = tallyIssue(r, MO, MILE, '2026-09-22T12:00:00+08:00');
  assert.equal(early.counts.present, 0);
  assert.equal(early.outcome, 'failed_quorum');
  assert.equal(early.received_only.length, 8);
});

test('迟到揭示不能改变已经宣布冻结的结果', async () => {
  const r = await loadCouncil();
  const ann = r.council.announcements.find((a) => a.topic_id === MILE);
  assert.equal(ann.outcome, 'approved');
  assert.equal(ann.counts.present, 4);
  assert.equal(ann.tally_snapshot.received_only.length, 1);
});

test('方案变更 rev1：宣布当时冻结为 4:2 恰好达到 2/3；事后记录复算反映更正', async () => {
  const r = await loadCouncil();
  // 宣布快照：当时认定的有效集合与结论（证明决定在宣布时成立）。
  const ann = r.council.announcements.find((a) => a.topic_id === PROTO && a.revision_seq === 1);
  assert.equal(ann.outcome, 'approved');
  assert.equal(ann.rules.threshold.rule_id, 'TR-002');
  assert.equal(ann.counts.approve, 4);
  assert.equal(ann.counts.disapprove, 2);
  assert.equal(ann.eligible_seats.length, 6);
  assert.equal(ann.materials[0].version_seq, 1);
  assert.equal(digest(ann.tally_snapshot), ann.tally_digest);
  // 事后记录含回溯回避 RCU-M4-PROTO（09-21 起生效）：同点复算得 3:2 rejected。
  const retally = tallyIssue(r, MO, PROTO, '2026-09-23T11:30:00+08:00', { revision_seq: 1 });
  assert.equal(retally.counts.approve, 3);
  assert.equal(retally.outcome, 'rejected');
});

test('宣布后的回避错误走公开更正：原宣布保留，有效结论翻转为 rejected', async () => {
  const r = await loadCouncil();
  const ann = r.council.announcements.find(
    (a) => a.topic_id === PROTO && a.revision_seq === 1,
  );
  assert.equal(ann.outcome, 'approved'); // 原结论原样保留
  const view = announcementView(r, ann.announcement_id);
  assert.equal(view.original_outcome, 'approved');
  assert.equal(view.effective_outcome, 'rejected');
  assert.equal(view.corrections.length, 1);
  assert.equal(view.corrections[0].kind, 'eligibility');
  // 更正计票包：M4 剔除后 3:2，不足 2/3。
  const retally = tallyIssue(r, MO, PROTO, '2026-09-23T11:30:00+08:00', { revision_seq: 1 });
  assert.equal(retally.counts.eligible, 5);
  assert.equal(retally.counts.approve, 3);
  assert.equal(retally.outcome, 'rejected');
  assert.equal(digest(strip(retally)), view.effective_tally_digest);
});

function strip(t) {
  const { tally_digest, ...rest } = t;
  return rest;
}

test('入组议题 2:2 为僵局而非否决，并触发升级', async () => {
  const r = await loadCouncil();
  const t = tallyIssue(r, MO, ENROLL, '2026-09-23T14:00:00+08:00');
  assert.equal(t.outcome, 'deadlock');
  assert.equal(t.deadlock, true);
  assert.equal(t.counts.approve, 2);
  assert.equal(t.counts.disapprove, 2);
  const esc = r.council.escalations[0];
  assert.equal(esc.tier, 1);
  assert.equal(esc.authority, '联合指导委员会（JSC）');
  assert.equal(esc.status, 'resolved');
});

test('安全紧急动作先落账后追认，追认有独立期限且在期内通过', async () => {
  const r = await loadCouncil();
  const emr = r.council.emergency_actions[0];
  // 紧急动作在追认投票前即已生效。
  const atInvocation = emergencyStatus(r, emr, '2026-09-23T07:00:00+08:00');
  assert.equal(atInvocation.effective, true);
  assert.equal(atInvocation.ratification, 'pending');
  const after = emergencyStatus(r, emr, '2026-09-24T20:00:00+08:00');
  assert.equal(after.ratification, 'ratified');
  const rat = r.council.emergency_ratifications[0];
  assert.equal(rat.within_deadline, true);
  assert.equal(rat.outcome, 'approved');
});

test('资格到期在宣布前重算：M6 在追认时点有效、在其后失效，但宣布快照不变', async () => {
  const r = await loadCouncil();
  const at19 = tallyIssue(r, MO, RAT, '2026-09-24T19:00:00+08:00');
  const at21 = tallyIssue(r, MO, RAT, '2026-09-24T21:00:00+08:00');
  assert.equal(at19.counts.eligible, 6);
  assert.equal(at21.counts.eligible, 5);
  assert.ok(at21.excluded_votes.some((x) => x.vote_id === 'V-RAT-M6' && x.reason === 'seat_ineligible'));
  const ann = r.council.announcements.find((a) => a.topic_id === RAT);
  assert.equal(ann.counts.eligible, 6); // 冻结于 19:00
});

test('议案修订只令受影响议题重签：里程碑批准继续有效，方案议题需重签后恢复', async () => {
  const r = await loadCouncil();
  const cont = new Map(
    approvalContinuity(r, MO, '2026-09-24T13:00:00+08:00').map((x) => [x.topic_id, x.status]),
  );
  assert.equal(cont.get(MILE), 'operative');
  assert.equal(cont.get(PROTO), 'needs_resignature');
  const cont2 = new Map(
    approvalContinuity(r, MO, '2026-09-25T19:00:00+08:00').map((x) => [x.topic_id, x.status]),
  );
  assert.equal(cont2.get(MILE), 'operative');
  assert.equal(cont2.get(PROTO), 'operative');
});

test('rev2 方案变更在 4 席（M6 到期、M4 持续回避）下附条件通过', async () => {
  const r = await loadCouncil();
  const t = tallyIssue(r, MO, PROTO, '2026-09-25T18:00:00+08:00');
  assert.equal(t.revision_seq, 2);
  assert.equal(t.counts.eligible, 4);
  assert.equal(t.counts.approve, 4);
  assert.equal(t.outcome, 'approved');
  assert.ok(t.excluded_votes.some((x) => x.vote_id === 'V-P2-M4' && x.reason === 'seat_ineligible'));
  const ann = r.council.announcements.find((a) => a.topic_id === PROTO && a.revision_seq === 2);
  assert.deepEqual(ann.condition_ids, ['CND-QUEUE-SAFETY']);
});

test('规则版本与材料版本写入计票包与宣布快照', async () => {
  const r = await loadCouncil();
  const ann = r.council.announcements.find((a) => a.topic_id === MILE);
  assert.equal(ann.rules.quorum.rule_id, 'QR-001');
  assert.equal(ann.rules.threshold.rule_id, 'TR-001');
  assert.equal(ann.materials[0].version_seq, 1);
  const proto2 = r.council.announcements.find((a) => a.topic_id === PROTO && a.revision_seq === 2);
  assert.equal(proto2.materials[0].version_seq, 2);
  assert.equal(proto2.rules.threshold.rule_id, 'TR-002');
});

test('同一时点复算确定一致（计票与冻结快照哈希吻合）', async () => {
  const r1 = await loadCouncil();
  const r2 = await loadRecord(fx('committee_council.json'));
  for (const [topic, at, rev] of [
    [MILE, '2026-09-23T10:00:00+08:00', 1],
    [PROTO, '2026-09-23T11:30:00+08:00', 1],
    [ENROLL, '2026-09-23T14:00:00+08:00', 1],
    [RAT, '2026-09-24T19:00:00+08:00', 1],
    [PROTO, '2026-09-25T18:00:00+08:00', 2],
  ]) {
    const a = tallyIssue(r1, MO, topic, at, { revision_seq: rev });
    const b = tallyIssue(r2, MO, topic, at, { revision_seq: rev });
    assert.equal(a.tally_digest, b.tally_digest, `${topic}@r${rev}`);
    const ann = r1.council.announcements.find(
      (x) => x.topic_id === topic && x.revision_seq === rev,
    );
    if (ann && !r1.council.corrections.some((c) => c.announcement_id === ann.announcement_id)) {
      assert.equal(digest(ann.tally_snapshot), ann.tally_digest);
    }
  }
});

test('纪要：完整列出规则版本、有效成员集合、材料摘要、条件与少数意见', async () => {
  const r = await loadCouncil();
  const min = renderMinutes(r, { as_of: '2026-10-01T12:00:00+08:00' });
  const mileIssue = min.issues.find((i) => i.topic_id === MILE);
  assert.equal(mileIssue.rules.quorum.rule_id, 'QR-001');
  assert.equal(mileIssue.eligible_seats.length, 5);
  const mat = min.materials.find((m) => m.version_seq === 1);
  assert.ok(mat.summary.includes('SAE-2026-014'));
  const protoR2 = min.issues.find((i) => i.topic_id === PROTO && i.revision_seq === 2);
  assert.equal(protoR2.conditions[0].status, 'satisfied');
  const protoR1 = min.issues.find((i) => i.topic_id === PROTO && i.revision_seq === 1);
  // 已形成的少数意见在纪要中完整保留，不被更正或修订覆盖。
  assert.equal(protoR1.minority_opinions.length, 2);
  assert.ok(protoR1.minority_opinions.some((o) => o.opinion.includes('样本量论证不成立')));
  assert.equal(protoR1.effective_outcome, 'rejected');
});

test('纪要按合作方隐藏附件：摘要与意见仍完整，full_digest 跨视角恒定', async () => {
  const r = await loadCouncil();
  const asOf = '2026-10-01T12:00:00+08:00';
  const full = renderMinutes(r, { as_of: asOf });
  const alpha = renderMinutes(r, { as_of: asOf, viewer_party: 'ALPHA' });
  const gamma = renderMinutes(r, { as_of: asOf, viewer_party: 'GAMMA' });
  assert.equal(full.full_digest, alpha.full_digest);
  assert.equal(full.full_digest, gamma.full_digest);
  assert.notEqual(alpha.view_digest, gamma.view_digest);
  // GAMMA 看不到发起方价格测算与 IP 附录。
  assert.ok(gamma.redaction.hidden_attachments.includes('ATT-PRICE'));
  assert.ok(gamma.redaction.hidden_attachments.includes('ATT-IP'));
  assert.ok(!gamma.redaction.hidden_attachments.includes('ATT-CRO'));
  // ALPHA 看不到 GAMMA 专属少数意见原件。
  assert.ok(alpha.redaction.hidden_attachments.includes('ATT-DISSENT-PROTO'));
  assert.ok(!gamma.redaction.hidden_attachments.includes('ATT-DISSENT-PROTO'));
  // 但材料摘要与少数意见正文对所有合作方完整。
  const gammaMat = gamma.materials.find((m) => m.version_seq === 1);
  assert.ok(gammaMat.summary.includes('里程碑付款测算'));
  const gammaR1 = gamma.issues.find((i) => i.topic_id === PROTO && i.revision_seq === 1);
  assert.ok(gammaR1.minority_opinions.some((o) => o.opinion.includes('样本量论证不成立')));
});

test('通知投递失败不阻断决定落账，但持续挂在秘书处待办', async () => {
  const r = await loadCouncil();
  const ann = r.council.announcements.find((a) => a.topic_id === MILE);
  assert.equal(ann.outcome, 'approved'); // 落账不受影响
  const todos = secretaryTodos(r, '2026-10-01T12:00:00+08:00');
  const retry = todos.find((t) => t.kind === 'notification_retry' && t.ref === r.council.notifications[0].notification_id);
  assert.ok(retry);
  assert.equal(retry.about.id, ann.announcement_id);
});

test('密封承诺与揭示逐字节绑定', async () => {
  const r = await loadCouncil();
  const raw = JSON.parse(await readFile(fx('committee_council.json'), 'utf8'));
  const v = raw.council.votes.find((x) => x.vote_id === 'V-MILE-M1');
  assert.equal(commitmentFor(v.reveal), v.commitment);
  assert.notEqual(
    commitmentFor({ ...v.reveal, opinion: '被篡改' }),
    v.commitment,
  );
});

test('安全议题本身（紧急暂停）不设委员会前置批准：无宣布但有紧急动作', async () => {
  const r = await loadCouncil();
  assert.ok(!r.council.announcements.some((a) => a.topic_id === SAFE));
  const emr = r.council.emergency_actions.find((e) => e.topic_id === SAFE);
  assert.equal(emr.action, 'safety_hold');
  assert.equal(emr.authority, 'DSMB（数据与安全监察委员会）当值安全监察官');
});
