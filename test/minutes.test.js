import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRecord, loadSession } from '../src/contracts.js';
import { renderMinutes, verifyMinutes } from '../src/minutes.js';

const here = dirname(fileURLToPath(import.meta.url));

async function sample() {
  const record = await loadRecord(join(here, '..', 'fixtures', 'committee_session.json'));
  return loadSession(record);
}

const NOW = '2026-09-23T12:00:00+08:00';

test('纪要完整列出规则版本、有效成员、材料摘要、条件与少数意见', async () => {
  const s = await sample();
  const minutes = renderMinutes(s, 'DEC-2026-031', { viewer: { party_id: 'P-GAMMA' }, now: NOW });
  const milestone = minutes.sections.find((x) => x.section_id === 'SEC-MILESTONE');

  assert.equal(milestone.rules.quorum_rule, 'QR-GENERAL:v1');
  assert.equal(milestone.rules.threshold, 'TH-MAJORITY:v1');
  assert.deepEqual(milestone.eligible_voters.map((v) => v.holder_id).sort(), ['D-BETA', 'M-GAMMA']);
  assert.ok(milestone.materials.some((m) => m.material_id === 'MAT-MILESTONE'));
  assert.equal(milestone.ballot_accounting.ineligible_seat.length, 1);

  assert.equal(minutes.conditions.length, 1);
  assert.equal(minutes.conditions[0].text, '付款前完成独立财务审计并向委员会报告');
  assert.equal(minutes.minority_opinions.length, 1);
  assert.match(minutes.minority_opinions[0].text, /301 中心/);
});

test('附件按合作方权限隐藏，仅报告被隐藏数量', async () => {
  const s = await sample();
  const forGamma = renderMinutes(s, 'DEC-2026-031', { viewer: { party_id: 'P-GAMMA' }, now: NOW });
  const forAlpha = renderMinutes(s, 'DEC-2026-031', { viewer: { party_id: 'P-ALPHA' }, now: NOW });

  // 收款账户仅阿尔法、贝塔可见；原始 SAE 病例仅贝塔、伽马可见
  assert.ok(!forGamma.attachments.some((a) => a.attachment_id === 'ATT-BANK-1'));
  assert.ok(forGamma.attachments.some((a) => a.attachment_id === 'ATT-SAE-1'));
  assert.ok(forAlpha.attachments.some((a) => a.attachment_id === 'ATT-BANK-1'));
  assert.ok(!forAlpha.attachments.some((a) => a.attachment_id === 'ATT-SAE-1'));
  assert.ok(forGamma.withheld_attachments >= 1);
  assert.ok(forAlpha.withheld_attachments >= 1);
});

test('任何人独立复算得到相同结论：verifyMinutes 全部通过且摘要可重复', async () => {
  const s = await sample();
  const minutes = renderMinutes(s, 'DEC-2026-031', { viewer: { party_id: 'P-GAMMA' }, now: NOW });
  const result = verifyMinutes(s, minutes);
  assert.equal(result.ok, true, JSON.stringify(result.sections.filter((x) => !x.matches), null, 2));

  const again = renderMinutes(s, 'DEC-2026-031', { viewer: { party_id: 'P-GAMMA' }, now: NOW });
  assert.equal(again.conclusion_digest, minutes.conclusion_digest);
});
