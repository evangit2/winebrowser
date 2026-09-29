import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
import { systemFileTime } from '../src/shared-user-data.js';
import { resolveGuestPath } from '../src/guest-paths.js';

const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup(t) {
  let now = 1000000;
  const r = new Runtime(iced, {
    files: new Map([
      ['app/console.exe', exe],
      ['app/data/payload.bin', new Uint8Array(5001)],
      ['app/empty.bin', new Uint8Array()],
    ]),
    exe: 'app/console.exe',
    systemNow: () => now,
  });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const nt = (name, ...args) => ntServices[name].call(r, (i) => args[i] >>> 0);
  const api = (name, ...args) => r.apiProvider.get(`kernel32.dll!${name}`)(r, (i) => args[i] >>> 0);
  const p = r.allocate(64),
    io = r.allocate(8);
  const attributes = (name) => {
    const attr = r.allocate(24),
      unicode = r.allocate(8),
      text = r.allocString(name, true);
    r.view.setUint16(unicode, name.length * 2, true);
    r.view.setUint16(unicode + 2, name.length * 2 + 2, true);
    r.write32(unicode + 4, text);
    [24, 0, unicode, 0x40, 0, 0].forEach((v, i) => r.write32(attr + i * 4, v));
    return attr;
  };
  const name = (value, wide = false) => r.allocString(value, wide);
  return { r, p, io, nt, api, attributes, name, time: (v) => (now = v) };
}

test('NT basic/full metadata and Win32 A/W queries share directories, bounded layouts and exact sizes', (t) => {
  const { r, p, nt, api, attributes, name } = setup(t);
  for (const path of ['.', 'data', 'data\\', '..', 'C:\\winebrowser', 'C:\\winebrowser\\'])
    assert.equal(api('GetFileAttributesW', name(path, true)).result, 0x10, path);
  r.data.fill(0xcc, p, p + 64);
  const attr = attributes('\\??\\C:\\winebrowser\\APP\\data\\payload.bin');
  assert.equal(nt('NtQueryAttributesFile', attr, p), 0);
  assert.equal(r.read32(p + 32), 0x20);
  assert.equal(r.read32(p + 40), 0xcccccccc);
  assert.equal(r.view.getBigInt64(p, true), systemFileTime(1000000));
  assert.equal(nt('NtQueryFullAttributesFile', attr, p), 0);
  assert.equal(r.view.getBigInt64(p + 32, true), 8192n);
  assert.equal(r.view.getBigInt64(p + 40, true), 5001n);
  assert.equal(r.read32(p + 48), 0x20);
  assert.equal(r.read32(p + 56), 0xcccccccc);
  r.data.fill(0xcc, p, p + 64);
  assert.equal(api('GetFileAttributesExA', name('DATA/payload.bin'), 0, p).result, 1);
  assert.equal(r.read32(p), 0x20);
  assert.equal(r.read32(p + 28), 0);
  assert.equal(r.read32(p + 32), 5001);
  assert.equal(r.read32(p + 36), 0xcccccccc);
  assert.equal(
    nt('NtQueryFullAttributesFile', attributes('\\??\\C:\\winebrowser\\app\\data'), p),
    0,
  );
  assert.equal(r.read32(p + 48), 0x10);
  assert.equal(r.view.getBigInt64(p + 40, true), 0n);
  assert.equal(api('GetFileAttributesA', name('empty.bin')).result, 0x20);
  assert.equal(
    api('GetFileAttributesW', name('\\\\?\\C:\\winebrowser\\APP\\empty.bin', true)).result,
    0x20,
  );
});

test('missing leaves and parents differ, malformed paths/pointers preserve outputs, and queries create no files', (t) => {
  const { r, p, nt, api, attributes, name } = setup(t),
    count = r.files.size;
  r.data.fill(0xcc, p, p + 64);
  for (const [path, status] of [
    ['app/data/none', 0xc0000034],
    ['app/no/data', 0xc000003a],
    ['app/empty.bin/child', 0xc000003a],
  ]) {
    assert.equal(
      nt('NtQueryAttributesFile', attributes('\\??\\C:\\winebrowser\\' + path), p),
      status,
    );
    assert.equal(r.read32(p), 0xcccccccc);
  }
  assert.equal(api('GetFileAttributesA', name('data/missing')).result, 0xffffffff);
  assert.equal(r.lastError, 2);
  assert.equal(api('GetFileAttributesExA', name('absent/file'), 0, p).result, 0);
  assert.equal(r.lastError, 3);
  assert.equal(
    nt('NtQueryFullAttributesFile', attributes('\\??\\C:\\outside\\file'), p),
    0xc000003a,
  );
  assert.equal(
    nt('NtQueryAttributesFile', attributes('\\??\\C:\\winebrowser\\..\\outside'), p),
    0xc000003a,
  );
  assert.equal(nt('NtQueryAttributesFile', 0, p), 0xc0000005);
  assert.equal(
    nt('NtQueryAttributesFile', attributes('\\??\\C:\\winebrowser\\app'), 0),
    0xc0000005,
  );
  assert.equal(api('GetFileAttributesExW', name('data', true), 1, p).result, 0);
  assert.equal(r.lastError, 87);
  assert.equal(api('GetFileAttributesExA', name('data'), 0, 0).result, 0);
  assert.equal(r.lastError, 998);
  assert.equal(r.files.size, count);
  assert.equal(r.read32(p), 0xcccccccc);
  assert.throws(() => resolveGuestPath('C:\\winebrowser\\'), /invalid file path/);
  assert.equal(resolveGuestPath('C:\\winebrowser\\', '', { allowRoot: true }), '');
});

test('the Win32 namespace prefixes resolve to the same package path', () => {
  // A program that exceeds MAX_PATH switches to the verbatim spellings. Both
  // `\\?\C:\...` (long-path semantics) and `\??\C:\...` (the NT
  // object-manager form) name the same file inside the package volume, so they
  // must not be rejected as outside it.
  for (const prefix of ['\\\\?\\', '\\??\\']) {
    assert.equal(
      resolveGuestPath(prefix + 'C:\\winebrowser\\app\\data\\payload.bin'),
      'app/data/payload.bin',
    );
    assert.equal(
      resolveGuestPath(prefix + 'C:\\winebrowser\\app\\data\\payload.bin', 'other/'),
      'app/data/payload.bin',
    );
  }
  // A verbatim UNC path names a network share this process does not have, so it
  // stays an error rather than silently resolving inside the package.
  assert.throws(() => resolveGuestPath('\\\\?\\UNC\\server\\share\\x'), /UNC paths/);
  assert.throws(() => resolveGuestPath('\\??\\UNC\\server\\share\\x'), /UNC paths/);
});

test('guest writes/reads/truncation update shared metadata without changing imported creation time', (t) => {
  const { r, p, io, nt, api, attributes, name, time } = setup(t),
    attr = attributes('\\??\\C:\\winebrowser\\app\\data\\payload.bin');
  time(2000000);
  const handle = api('CreateFileA', name('data/payload.bin'), 0xc0000000, 3, 0, 3, 0x80, 0).result;
  r.data.set([1, 2, 3], p);
  assert.equal(api('WriteFile', handle, p, 3, io, 0).result, 1);
  assert.equal(nt('NtQueryInformationFile', handle, io, p, 40, 4), 0);
  assert.equal(r.view.getBigInt64(p, true), systemFileTime(1000000));
  assert.equal(r.view.getBigInt64(p + 16, true), systemFileTime(2000000));
  time(3000000);
  assert.equal(nt('NtReadFile', handle, 0, 0, 0, io, p, 5, 0, 0), 0);
  assert.equal(nt('NtQueryFullAttributesFile', attr, p), 0);
  assert.equal(r.view.getBigInt64(p + 8, true), systemFileTime(3000000));
  assert.equal(r.view.getBigInt64(p + 16, true), systemFileTime(2000000));
  time(4000000);
  r.view.setBigInt64(p, 9n, true);
  assert.equal(nt('NtSetInformationFile', handle, io, p, 8, 20), 0);
  assert.equal(nt('NtQueryInformationFile', handle, io, p, 56, 34), 0);
  assert.equal(r.view.getBigInt64(p + 40, true), 9n);
  assert.equal(r.view.getBigInt64(p + 16, true), systemFileTime(4000000));
  assert.equal(nt('NtQueryInformationFile', handle, io, p, 39, 4), 0xc0000004);
});

test('new files have current creation times, metadata-only handles can query and directory replacement is rejected', (t) => {
  const { r, p, io, nt, api, attributes, name, time } = setup(t);
  time(5000000);
  const h = api('CreateFileA', name('new.bin'), 0x40000000, 3, 0, 2, 0x80, 0).result;
  assert.notEqual(h, 0xffffffff);
  assert.equal(api('GetFileAttributesExA', name('new.bin'), 0, p).result, 1);
  assert.equal(r.view.getBigInt64(p + 4, true), systemFileTime(5000000));
  assert.equal(api('CreateFileA', name('data'), 0x40000000, 3, 0, 2, 0x80, 0).result, 0xffffffff);
  assert.equal(r.lastError, 5);
  assert.equal(
    api('CreateFileA', name('absent/new'), 0x40000000, 3, 0, 2, 0x80, 0).result,
    0xffffffff,
  );
  assert.equal(r.lastError, 3);
  const out = r.allocate(4),
    attr = attributes('\\??\\C:\\winebrowser\\app\\new.bin');
  assert.equal(nt('NtOpenFile', out, 0x100080, attr, io, 3, 0x60), 0);
  const query = r.read32(out);
  assert.equal(nt('NtQueryInformationFile', query, io, p, 40, 4), 0);
  assert.equal(nt('NtReadFile', query, 0, 0, 0, io, p, 1, 0, 0), 0xc0000022);
  for (const access of [0x100000, 0x100001, 0x40100000]) {
    assert.equal(nt('NtOpenFile', out, access, attr, io, 3, 0x60), 0);
    assert.equal(nt('NtQueryInformationFile', r.read32(out), io, p, 40, 4), 0xc0000022);
    assert.equal(nt('NtQueryInformationFile', r.read32(out), io, p, 56, 34), 0xc0000022);
  }
  assert.equal(nt('NtOpenFile', out, 0x80100000, attr, io, 3, 0x60), 0);
  assert.equal(nt('NtQueryInformationFile', r.read32(out), io, p, 40, 4), 0);
});
