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
    assert.equal(seeded.data.meta.schemaVersion, 6);
    const legacy = seeded.snapshot();
    legacy.meta.schemaVersion = 1;
    delete legacy.referrers;
    delete legacy.leads;
    delete legacy.contentItems;
    delete legacy.newsletterPreferences;
    delete legacy.dailyDigests;
    for (const member of legacy.members) {
      delete member.referralAttribution;
      delete member.leadOwnerAttribution;
      delete member.investmentPreferences;
    }
    for (const subscription of legacy.subscriptions) {
      for (const field of [
        'referralSnapshot', 'commissionState', 'commissionBasisAmountTwd', 'commissionAccruedAmountTwd',
        'commissionApproval', 'commissionPayment', 'commissionVoidReason',
      ]) delete subscription[field];
    }
    legacy.subscriptions[0].allocatedAmountTwd = 123_456;
    await writeFile(filePath, JSON.stringify(legacy), { mode: 0o600 });

    const migrated = await new JsonStore(filePath).init();
    assert.equal(migrated.data.meta.schemaVersion, 6);
    assert.equal(migrated.data.referrers.length, 4);
    assert.ok(migrated.data.members.every((item) => item.referralAttribution === null));
    assert.ok(migrated.data.subscriptions.every((item) => (
      item.referralSnapshot === null
      && item.acquisitionAttributionSnapshot === null
      && item.commissionState === 'not_applicable'
      && item.commissionBasisAmountTwd === 0
      && item.commissionAccruedAmountTwd === 0
    )));
    assert.deepEqual(migrated.data.leads, []);
    assert.deepEqual(migrated.data.contentItems, []);
    assert.deepEqual(migrated.data.dailyDigests, []);
    assert.ok(migrated.data.members.every((item) => item.leadOwnerAttribution === null));
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
    assert.equal(migrated.data.meta.schemaVersion, 6);
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

test('legacy content records gain deterministic visibility without changing publication evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zhifu-store-content-visibility-'));
  const filePath = join(directory, 'data.json');
  try {
    const seeded = await new JsonStore(filePath).init();
    const legacy = seeded.snapshot();
    legacy.meta.schemaVersion = 5;
    legacy.contentItems = [
      { id: 'public', type: 'article', publicSafe: true, status: 'published', publishedAt: '2026-08-18T00:00:00.000Z', riskDisclosure: 'Risk' },
      { id: 'qualified', type: 'project_update', publicSafe: false, status: 'published', publishedAt: '2026-08-18T00:00:00.000Z', riskDisclosure: 'Risk' },
      { id: 'member', type: 'article', publicSafe: false, status: 'draft', publishedAt: null, riskDisclosure: null },
    ];
    await writeFile(filePath, JSON.stringify(legacy), { mode: 0o600 });

    const migrated = await new JsonStore(filePath).init();
    assert.equal(migrated.data.meta.schemaVersion, 6);
    assert.deepEqual(migrated.data.contentItems.map((item) => item.visibility), ['public', 'qualified', 'member']);
    assert.equal(migrated.data.contentItems[0].publishedAt, '2026-08-18T00:00:00.000Z');
    assert.equal(migrated.data.contentItems[0].riskDisclosure, 'Risk');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
