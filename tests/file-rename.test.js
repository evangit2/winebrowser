import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
import { fileIdentity } from '../src/file-metadata.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup(t) {
  const r = new Runtime(iced, {
    files: new Map([
      ['console.exe', exe],
      ['out.tmp', new Uint8Array([1, 2, 3])],
      ['out.zip', new Uint8Array([4])],
    ]),
    exe: 'console.exe',
  });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  r.handles.set(100, { path: 'out.tmp', position: 1, access: 0xc0010000, share: 7 });
  const p = r.allocate(1024),
    io = r.allocate(8);
  return {
    r,
    p,
    io,
    rename: (name, replace = false, root = 0) => {
      r.data.fill(0, p, p + 1024);
      r.data[p] = +replace;
      r.write32(p + 4, root);
      r.write32(p + 8, name.length * 2);
      for (let i = 0; i < name.length; i++)
        r.guestMemory.write(p + 12 + 2 * i, name.charCodeAt(i), 2);
      return ntServices.NtSetInformationFile.call(
        r,
        (i) => [100, io, p, 12 + name.length * 2, 10][i],
      );
    },
  };
}
test('NT atomic rename preserves file bytes, handles, identity, locks and metadata; replacement removes old contents', (t) => {
  const { r, rename, io } = setup(t),
    id = fileIdentity(r, 'out.tmp');
  r.fileTimes = new Map([['out.tmp', { creation: 1n, write: 2n }]]);
  r.fileLocks = [{ path: 'out.tmp', handle: 100 }];
  r.handles.set(101, { path: 'out.tmp', position: 2, access: 0x80000000, share: 7 });
  assert.equal(rename('out.zip'), 0xc0000035);
  assert.deepEqual([...r.files.get('out.zip')], [4]);
  assert.equal(rename('\\??\\C:\\winebrowser\\out.zip', true), 0);
  assert.equal(r.read32(io), 0);
  assert.equal(r.read32(io + 4), 0);
  assert.equal(r.files.has('out.tmp'), false);
  assert.deepEqual([...r.files.get('out.zip')], [1, 2, 3]);
  assert.equal(r.handles.get(101).path, 'out.zip');
  assert.equal(r.handles.get(101).position, 2);
  assert.equal(fileIdentity(r, 'out.zip'), id);
  assert.equal(r.fileTimes.get('out.zip').write, 2n);
  assert.equal(r.fileLocks[0].path, 'out.zip');
  assert.ok(r.dirty.has('out.tmp'));
  assert.ok(r.dirty.has('out.zip'));
});
test('NT rename rejects malformed/outside paths, missing delete access, sharing conflicts, live targets and mapped truncation without mutation', (t) => {
  const { r, rename, p, io } = setup(t);
  assert.equal(rename('C:\\outside.bin'), 0xc000003a);
  assert.equal(rename('missing/out.zip'), 0xc000003a);
  r.handles.get(100).access = 0xc0000000;
  assert.equal(rename('new.zip'), 0xc0000022);
  r.handles.get(100).access |= 0x10000;
  r.handles.set(101, { path: 'out.tmp', access: 0x80000000, share: 3 });
  assert.equal(rename('new.zip'), 0xc0000043);
  r.handles.delete(101);
  r.handles.set(102, { path: 'out.zip', share: 7 });
  assert.equal(rename('out.zip', true), 0xc0000043);
  r.handles.delete(102);
  r.fileSections = { canResize: () => false };
  assert.equal(rename('new.zip'), 0xc0000022);
  r.write32(p + 8, 3);
  assert.equal(
    ntServices.NtSetInformationFile.call(r, (i) => [100, io, p, 16, 10][i]),
    0xc000000d,
  );
  assert.deepEqual([...r.files.get('out.tmp')], [1, 2, 3]);
  assert.deepEqual([...r.files.get('out.zip')], [4]);
});
test('NT rename resolves counted names against a real root-directory handle', (t) => {
  const { r, rename } = setup(t);
  r.virtualDirectories = new Set(['dest/']);
  r.handles.set(200, { kind: 'file-directory', path: 'dest' });
  assert.equal(rename('new.zip', false, 199), 0xc0000008);
  assert.equal(rename('new.zip', false, 200), 0);
  assert.ok(r.files.has('dest/new.zip'));
});
