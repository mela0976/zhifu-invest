import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JsonStore } from '../src/store.js';

test('concurrent mutations are serialized without losing either update', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhifu-store-'));
  const filePath = join(directory, 'data.json');
  try {
    const store = await new JsonStore(filePath).init();
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.mutate(async (draft) => {
      if (index % 2 === 0) await new Promise((resolve) => setTimeout(resolve, 2));
      draft.activations.push({ id: `concurrent-${index}` });
    })));

    assert.equal(store.data.activations.length, 20);
    const persisted = JSON.parse(await readFile(filePath, 'utf8'));
    assert.equal(persisted.activations.length, 20);
    assert.equal(new Set(persisted.activations.map((item) => item.id)).size, 20);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy data migration never fabricates historical referral or commission evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhifu-store-migration-'));
  const filePath = join(directory, 'data.json');
  try {
    const seeded = await new JsonStore(filePath).init();
    const legacy = seeded.snapshot();
    legacy.meta.schemaVersion = 1;
    delete legacy.referrers;
    for (const member of legacy.members) delete member.referralAttribution;
    for (const subscription of legacy.subscriptions) {
      for (const field of [
        'referralSnapshot', 'commissionState', 'commissionBasisAmountTwd', 'commissionAccruedAmountTwd',
        'commissionApproval', 'commissionPayment', 'commissionVoidReason',
      ]) delete subscription[field];
    }
    legacy.subscriptions[0].allocatedAmountTwd = 123_456;
    await writeFile(filePath, JSON.stringify(legacy), { mode: 0o600 });

    const migrated = await new JsonStore(filePath).init();
    assert.equal(migrated.data.meta.schemaVersion, 3);
    assert.equal(migrated.data.referrers.length, 4);
    assert.ok(migrated.data.members.every((item) => item.referralAttribution === null));
    assert.ok(migrated.data.subscriptions.every((item) => (
      item.referralSnapshot === null
      && item.commissionState === 'not_applicable'
      && item.commissionBasisAmountTwd === 0
      && item.commissionAccruedAmountTwd === 0
    )));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('legacy Demo referrer identity migrates without changing commission history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhifu-store-referrer-name-'));
  const filePath = join(directory, 'data.json');
  const legacyName = String.fromCodePoint(0x96ea, 0x82ac, 0x59d0);
  const legacyCode = ['XUE', 'FEN'].join('');
  const legacyAdminId = `admin-${['xue', 'fen'].join('')}-demo`;
  try {
    const seeded = await new JsonStore(filePath).init();
    const legacy = seeded.snapshot();
    legacy.meta.schemaVersion = 2;
    legacy.referrers[0].code = legacyCode;
    legacy.referrers[0].displayName = legacyName;
    legacy.members[0].referralAttribution.referralCode = legacyCode;
    legacy.members[0].referralAttribution.verifiedBy = legacyAdminId;
    legacy.subscriptions[0].referralSnapshot.referrerName = legacyName;
    legacy.subscriptions[0].referralSnapshot.referralCode = legacyCode;
    legacy.subscriptions[0].commissionAccruedAmountTwd = 12_345;
    await writeFile(filePath, JSON.stringify(legacy), { mode: 0o600 });

    const migrated = await new JsonStore(filePath).init();
    assert.equal(migrated.data.meta.schemaVersion, 3);
    assert.equal(migrated.data.referrers[0].code, 'REFERRER');
    assert.equal(migrated.data.referrers[0].displayName, '引薦人');
    assert.equal(migrated.data.members[0].referralAttribution.verifiedBy, 'admin-referrer-demo');
    assert.equal(migrated.data.subscriptions[0].referralSnapshot.referrerName, '引薦人');
    assert.equal(migrated.data.subscriptions[0].commissionAccruedAmountTwd, 12_345);
    assert.equal(JSON.stringify(migrated.data).includes(legacyName), false);
    assert.equal(JSON.stringify(migrated.data).toLowerCase().includes(['xue', 'fen'].join('')), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
