import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
