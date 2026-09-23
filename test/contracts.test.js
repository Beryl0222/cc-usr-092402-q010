import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadRecord, validateRecord, migrateV1, loadSession, canonicalize, digest, sealBallot,
} from '../src/contracts.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => join(here, '..', 'fixtures', name);

test('业务样例符合当前数据合同', async () => {
  const record = await loadRecord(fixture('committee_motion.json'));
  assert.equal(record.domain, 'drug_council');
  assert.ok(record.revision > 0);
});

test('v2 会议样例通过合同校验', async () => {
  const record = await loadRecord(fixture('committee_session.json'));
  assert.equal(record.schema_version, 2);
  assert.equal(record.domain, 'drug_council');
  assert.ok(Array.isArray(record.governance.memberships));
  assert.ok(Array.isArray(record.tallies));
});

test('未知版本被拒绝', () => {
  assert.throws(() => validateRecord({ schema_version: 99, record_id: 'x' }), /不支持的数据合同版本/);
});

test('v1 记录迁移为 v2 骨架并保持标识与时间含义', async () => {
  const v1 = await loadRecord(fixture('committee_motion.json'));
  const migrated = migrateV1(v1);
  assert.equal(migrated.schema_version, 2);
  assert.equal(migrated.record_id, v1.record_id);
  assert.equal(migrated.occurred_at, v1.occurred_at);
  assert.equal(migrated.source, v1.source);
  assert.doesNotThrow(() => validateRecord(migrated));
  const session = loadSession(migrated);
  assert.equal(session.motions.length, 0);
});

test('确定性序列化与摘要：键序无关，内容敏感', () => {
  const a = { x: 1, y: [2, 3], z: { b: 1, a: 2 } };
  const b = { z: { a: 2, b: 1 }, y: [2, 3], x: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(digest(a), digest(b));
  assert.notEqual(digest(a), digest({ ...a, x: 2 }));
});

test('密封承诺：同内容同盐得同承诺，内容或盐不同则不同', () => {
  const base = {
    motion_id: 'M', section_id: 'S', section_revision: 1,
    authorization_id: 'seat:M1', seq: 1, choice: 'approve', conditions: [], salt: 's1',
  };
  assert.equal(sealBallot(base), sealBallot({ ...base }));
  assert.notEqual(sealBallot(base), sealBallot({ ...base, salt: 's2' }));
  assert.notEqual(sealBallot(base), sealBallot({ ...base, choice: 'reject' }));
});
