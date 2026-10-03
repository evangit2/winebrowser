import test from 'node:test';
import assert from 'node:assert/strict';
import { saveOutputs } from '../src/storage.js';

class Directory {
  directories = new Map();
  files = new Map();
  denied = new Set();
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.directories.has(name)) {
      if (!create) throw Object.assign(Error(name), { name: 'NotFoundError' });
      this.directories.set(name, new Directory());
    }
    return this.directories.get(name);
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.files.has(name) && !create)
      throw Object.assign(Error(name), { name: 'NotFoundError' });
    return {
      createWritable: async () => ({
        write: async (bytes) => {
          this.files.set(name, Uint8Array.from(bytes));
        },
        close: async () => {},
      }),
    };
  }
  async removeEntry(name) {
    if (this.denied.has(name)) throw Object.assign(Error(name), { name: 'NotAllowedError' });
    if (!this.files.delete(name)) throw Object.assign(Error(name), { name: 'NotFoundError' });
  }
}

test('output persistence removes deleted files, preserves siblings and propagates actual storage errors', async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const root = new Directory();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { storage: { getDirectory: async () => root } },
  });
  t.after(() =>
    previous
      ? Object.defineProperty(globalThis, 'navigator', previous)
      : delete globalThis.navigator,
  );
  await saveOutputs('package', [
    { path: 'app/database.db', bytes: Uint8Array.of(1, 2) },
    { path: 'app/database.db-journal', bytes: Uint8Array.of(3) },
    { path: 'keep.txt', bytes: Uint8Array.of(4) },
  ]);
  await saveOutputs(
    'package',
    [{ path: 'app/database.db', bytes: Uint8Array.of(5, 6) }],
    ['app/database.db-journal', 'missing/directory/file.txt', 'app/missing.txt'],
  );
  const packageDir = root.directories.get('winebrowser-output').directories.get('package'),
    app = packageDir.directories.get('app');
  assert.deepEqual([...app.files.get('database.db')], [5, 6]);
  assert.equal(app.files.has('database.db-journal'), false);
  assert.equal(
    packageDir.directories.has('missing'),
    false,
    'deletion does not create phantom directories',
  );
  assert.deepEqual([...packageDir.files.get('keep.txt')], [4]);
  app.denied.add('database.db');
  await assert.rejects(saveOutputs('package', [], ['app/database.db']), {
    name: 'NotAllowedError',
  });
});
