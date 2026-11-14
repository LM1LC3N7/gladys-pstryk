// -----------------------------------------------------------------------------
// /data on a real disk: missing = empty, torn = set aside (never overwritten
// in place), unreadable = an error (never empty), saves in order, mode 0600.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, StoreUnreadable } from '../src/store.js';

async function dir(t) {
  const d = await mkdtemp(join(tmpdir(), 'pstryk-store-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

test('missing file: empty; saves land in order, mode 0600', async (t) => {
  const d = await dir(t);
  const store = new FileStore({ dir: d });
  assert.deepEqual(await store.load(), {});
  await Promise.all([store.save({ n: 1 }), store.save({ n: 2 }), store.save({ n: 3 })]);
  assert.deepEqual(await store.load(), { n: 3 });
  assert.equal((await stat(join(d, 'pstryk.json'))).mode & 0o777, 0o600);
});

test('a torn file is set aside as .bad, never overwritten in place', async (t) => {
  const d = await dir(t);
  await writeFile(join(d, 'pstryk.json'), '{"prices": {"1');
  const store = new FileStore({ dir: d });
  assert.deepEqual(await store.load(), {});
  assert.equal(await readFile(join(d, 'pstryk.json.bad'), 'utf8'), '{"prices": {"1');
  await writeFile(join(d, 'pstryk.json'), '[1,2]');
  assert.deepEqual(await store.load(), {});
});

test('a file that cannot be read is an error, never empty', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads everything');
  const d = await dir(t);
  await writeFile(join(d, 'pstryk.json'), '{"seen": true}');
  await chmod(join(d, 'pstryk.json'), 0o000);
  const store = new FileStore({ dir: d });
  await assert.rejects(store.load(), StoreUnreadable);
  await writeFile(join(d, 'big.json'), `{"x":"${'a'.repeat(1024 * 1024 + 10)}"}`);
  await assert.rejects(new FileStore({ dir: d, name: 'big.json' }).load(), StoreUnreadable);
});
