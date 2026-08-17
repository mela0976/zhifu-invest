import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSeedData } from './seeds.js';

function clone(value) {
  return structuredClone(value);
}

function migrateReferralSchema(data) {
  if ((data.meta?.schemaVersion || 1) >= 2 && Array.isArray(data.referrers)) return false;
  const seed = createSeedData();
  data.referrers = Array.isArray(data.referrers) ? data.referrers : clone(seed.referrers);
  for (const member of data.members || []) {
    if (member.referralAttribution !== undefined) continue;
    member.referralAttribution = null;
  }
  for (const subscription of data.subscriptions || []) {
    if (subscription.referralSnapshot !== undefined) continue;
    // Historical records predate captured attribution evidence. Never infer or backfill a commission snapshot.
    const source = {
      referralSnapshot: null,
      commissionState: 'not_applicable',
      commissionBasisAmountTwd: 0,
      commissionAccruedAmountTwd: 0,
      commissionApproval: null,
      commissionPayment: null,
      commissionVoidReason: null,
    };
    for (const field of [
      'referralSnapshot', 'commissionState', 'commissionBasisAmountTwd', 'commissionAccruedAmountTwd',
      'commissionApproval', 'commissionPayment', 'commissionVoidReason',
    ]) subscription[field] = clone(source[field]);
  }
  data.meta ||= {};
  data.meta.schemaVersion = 2;
  return true;
}

export class JsonStore {
  constructor(filePath = process.env.DATA_FILE || './runtime/data.json') {
    this.filePath = resolve(filePath);
    this.data = null;
    this.writeChain = Promise.resolve();
    this.mutationChain = Promise.resolve();
  }

  async init() {
    if (this.data) return this;
    try {
      this.data = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (migrateReferralSchema(this.data)) await this.persist();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.data = createSeedData();
      await this.persist();
    }
    return this;
  }

  snapshot() {
    if (!this.data) throw new Error('Store is not initialized');
    return clone(this.data);
  }

  async reset() {
    this.data = createSeedData();
    await this.persist();
    return this.snapshot();
  }

  async persist() {
    const serialized = JSON.stringify(this.data, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    await this.writeChain;
  }

  async mutate(action) {
    const operation = this.mutationChain.catch(() => {}).then(async () => {
      const draft = clone(this.data);
      const result = await action(draft);
      draft.meta.updatedAt = new Date().toISOString();
      this.data = draft;
      await this.persist();
      return clone(result);
    });
    this.mutationChain = operation.catch(() => {});
    return operation;
  }

  async appendAudit(draft, event) {
    const record = {
      id: `audit-${randomUUID()}`,
      ...clone(event),
      createdAt: event.createdAt || new Date().toISOString(),
    };
    draft.audits.push(record);
    return record;
  }
}

export class MemoryStore extends JsonStore {
  constructor(seed = createSeedData()) {
    super('/dev/null');
    this.data = clone(seed);
    migrateReferralSchema(this.data);
  }

  async init() { return this; }
  async persist() {}
}
