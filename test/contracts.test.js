import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRecord } from '../src/contracts.js';

const here = dirname(fileURLToPath(import.meta.url));

test('业务样例符合当前数据合同', async () => {
  const record = await loadRecord(join(here, '..', 'fixtures', 'committee_motion.json'));
  assert.equal(record.domain, 'drug_council');
  assert.ok(record.revision > 0);
});
