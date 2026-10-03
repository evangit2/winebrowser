import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
import { syncObjects } from '../src/sync-objects.js';
import { resolveGuestPath } from '../src/guest-paths.js';

const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
function fixture() {
  const output = [];
  const r = new Runtime(iced, {
    files: new Map([
      ['console.exe', exe],
      ['data.bin', Uint8Array.from([0x41, 0x42, 0x43, 0x44, 0x45, 0x46])],
    ]),
    exe: 'console.exe',
    emit: (event) => output.push(event),
  });
  r.handles.set(0x100, { path: 'data.bin', position: 0, access: 0xc0000000 });
  r.handles.set(0x101, { path: 'data.bin', position: 0, access: 0x40000000 });
  r.handles.set(0x102, { path: 'data.bin', position: 0, access: 0x80000000 });
  r.nextHandle = 0x103;
  return { r, output };
}
const call = (r, name, args) => ntServices[name].call(r, (index) => args[index] ?? 0);
const io = (r) => {
  const pointer = r.allocate(8);
  r.data.fill(0xaa, pointer, pointer + 8);
  return pointer;
};

function fileAttributes(r, path) {
  const name = r.allocString(path, true),
    unicode = r.allocate(8),
    attrs = r.allocate(24);
  r.view.setUint16(unicode, path.length * 2, true);
  r.view.setUint16(unicode + 2, (path.length + 1) * 2, true);
  r.write32(unicode + 4, name);
  [24, 0, unicode, 0x40, 0, 0].forEach((value, index) => r.write32(attrs + index * 4, value));
  return attrs;
}

test('NT create/open, seek, metadata and truncate operate on the shared package files', () => {
  const { r } = fixture();
  const status = io(r),
    out = r.allocate(4),
    info = r.allocate(32);
  const attrs = fileAttributes(r, '\\??\\C:\\winebrowser\\New.BIN');
  const args = [out, 0xc0100080, attrs, status, 0, 0x80, 3, 2, 0x60, 0, 0];
  assert.equal(call(r, 'NtCreateFile', args), 0);
  assert.equal(r.read32(status + 4), 2); // FILE_CREATED
  const handle = r.read32(out);
  assert.ok(r.files.has('new.bin'));
  assert.ok(r.dirty.has('new.bin'));
  r.data.set([1, 2, 3], info);
  assert.equal(call(r, 'NtWriteFile', [handle, 0, 0, 0, status, info, 3, 0, 0]), 0);
  assert.equal(call(r, 'NtQueryInformationFile', [handle, status, info, 24, 5]), 0);
  assert.equal(r.view.getBigInt64(info, true), 4096n);
  assert.equal(r.view.getBigInt64(info + 8, true), 3n);
  assert.equal(r.read32(info + 16), 1);
  assert.equal(r.read32(info + 20), 0);
  assert.equal(r.read32(status + 4), 24);
  r.view.setBigInt64(info, 1n, true);
  assert.equal(call(r, 'NtSetInformationFile', [handle, status, info, 8, 14]), 0);
  assert.equal(call(r, 'NtReadFile', [handle, 0, 0, 0, status, info, 5, 0, 0]), 0);
  assert.deepEqual([...r.data.slice(info, info + 2)], [2, 3]);
  assert.equal(r.read32(status + 4), 2);
  r.view.setBigInt64(info, 5n, true);
  assert.equal(call(r, 'NtSetInformationFile', [handle, status, info, 8, 20]), 0);
  assert.deepEqual([...r.files.get('new.bin')], [1, 2, 3, 0, 0]);
  assert.equal(call(r, 'NtClose', [handle]), 0);
  assert.equal(call(r, 'NtOpenFile', [out, 0x80100000, attrs, status, 3, 0x60]), 0);
  assert.equal(r.read32(status + 4), 1); // FILE_OPENED
  const readOnly = r.read32(out);
  assert.equal(call(r, 'NtSetInformationFile', [readOnly, status, info, 8, 20]), 0xc0000022);
  assert.equal(call(r, 'NtClose', [readOnly]), 0);
  args[7] = 5;
  assert.equal(call(r, 'NtCreateFile', args), 0);
  assert.equal(r.read32(status + 4), 3); // FILE_OVERWRITTEN
  assert.equal(r.files.get('new.bin').length, 0);
});

test('NT file errors preserve handles/files and do not escape the package volume', () => {
  const { r } = fixture();
  const status = io(r),
    out = r.allocate(4);
  r.write32(out, 0xaabbccdd);
  const attrs = fileAttributes(r, '\\??\\C:\\winebrowser\\data.bin');
  const args = [out, 0xc0100080, attrs, status, 0, 0x80, 3, 2, 0x60, 0, 0];
  const original = [...r.files.get('data.bin')];
  assert.equal(call(r, 'NtCreateFile', args), 0xc0000035);
  assert.equal(r.read32(out), 0xaabbccdd);
  args[7] = 5;
  args[0] = 0;
  assert.equal(call(r, 'NtCreateFile', args), 0xc0000005);
  assert.deepEqual([...r.files.get('data.bin')], original);
  args[0] = out;
  for (const name of [
    '\\??\\C:\\other\\data.bin',
    '\\??\\C:\\winebrowser\\..\\data.bin',
    '\\Device\\disk\\data.bin',
  ]) {
    args[2] = fileAttributes(r, name);
    assert.equal(call(r, 'NtCreateFile', args), 0xc000003a);
  }
  args[2] = fileAttributes(r, '\\??\\C:\\winebrowser\\missing.bin');
  args[7] = 1;
  assert.equal(call(r, 'NtCreateFile', args), 0xc0000034);
  args[7] = 2;
  args[8] = 0x40; // async unsupported
  assert.equal(call(r, 'NtCreateFile', args), 0xc00000bb);
  assert.equal(r.handles.size, 3);
  assert.equal(r.files.size, 2);
  assert.equal(r.dirty.size, 0);
});

test('NT sharing and append-only access are enforced across file handles', () => {
  const { r } = fixture();
  const status = io(r),
    out = r.allocate(4),
    buffer = r.allocate(8);
  const attrs = fileAttributes(r, '\\??\\C:\\winebrowser\\data.bin');
  assert.equal(call(r, 'NtOpenFile', [out, 0x80100000, attrs, status, 1, 0x60]), 0xc0000043);
  r.handles.clear();
  assert.equal(call(r, 'NtOpenFile', [out, 0x80100000, attrs, status, 1, 0x60]), 0);
  const reader = r.read32(out);
  assert.equal(call(r, 'NtOpenFile', [out, 0x40100000, attrs, status, 3, 0x60]), 0xc0000043);
  assert.equal(call(r, 'NtClose', [reader]), 0);
  assert.equal(call(r, 'NtOpenFile', [out, 0x100004, attrs, status, 3, 0x60]), 0);
  const append = r.read32(out);
  r.data[buffer] = 0xff;
  assert.equal(call(r, 'NtWriteFile', [append, 0, 0, 0, status, buffer, 1, 0, 0]), 0);
  assert.deepEqual([...r.files.get('data.bin')], [0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0xff]);
  assert.equal(r.handles.get(append).position, 7);
  r.view.setBigInt64(buffer, 0n, true);
  assert.equal(call(r, 'NtSetInformationFile', [append, status, buffer, 8, 20]), 0xc0000022);
});

test('Win32 and NT paths and share modes refer to the same isolated package files', () => {
  const { r } = fixture();
  r.handles.clear();
  r.cwd = 'folder/bin/';
  assert.equal(resolveGuestPath('../../data.bin', r.cwd), 'data.bin');
  assert.equal(resolveGuestPath('C:\\WineBrowser\\Data.BIN', r.cwd), 'data.bin');
  assert.throws(() => resolveGuestPath('../../../escape.bin', r.cwd), /escapes/);
  const name = r.allocString('..\\..\\data.bin');
  const create = (access, share, mode = 3) =>
    r.apiProvider.get('kernel32.dll!CreateFileA')(
      r,
      (index) => [name, access, share, 0, mode, 0x80, 0][index],
    );
  const opened = create(0x80000000, 1);
  assert.notEqual(opened.result, 0xffffffff);
  const status = io(r),
    out = r.allocate(4);
  const attrs = fileAttributes(r, '\\??\\C:\\winebrowser\\DATA.BIN');
  assert.equal(call(r, 'NtOpenFile', [out, 0x40100000, attrs, status, 3, 0x60]), 0xc0000043);
  assert.equal(call(r, 'NtClose', [opened.result]), 0);
  assert.equal(call(r, 'NtOpenFile', [out, 0x80100000, attrs, status, 1, 0x60]), 0);
  assert.equal(create(0x40000000, 3, 2).result, 0xffffffff);
  assert.equal(r.lastError, 32);
  assert.equal(r.files.get('data.bin').length, 6, 'failed truncate preserves the file');
});

test('NT information checks lengths, pointers and positions before changing state', () => {
  const { r } = fixture();
  const status = io(r),
    buffer = r.allocate(32);
  r.data.fill(0xab, buffer, buffer + 32);
  assert.equal(call(r, 'NtQueryInformationFile', [0x100, status, buffer, 23, 5]), 0xc0000004);
  assert.ok(r.data.slice(buffer, buffer + 32).every((v) => v === 0xab));
  assert.equal(call(r, 'NtQueryInformationFile', [0x100, status, 0, 24, 5]), 0xc0000005);
  assert.equal(call(r, 'NtQueryInformationFile', [0x999, status, buffer, 24, 5]), 0xc0000008);
  assert.equal(call(r, 'NtQueryInformationFile', [0x100, status, buffer, 32, 18]), 0xc00000bb);
  for (const position of [-1n, 0x100000000n]) {
    r.view.setBigInt64(buffer, position, true);
    assert.equal(call(r, 'NtSetInformationFile', [0x100, status, buffer, 8, 14]), 0xc000000d);
    assert.equal(r.handles.get(0x100).position, 0);
  }
});

test('FileFsDeviceInformation distinguishes output pipes and virtual disk files', () => {
  const { r } = fixture();
  const status = io(r),
    info = r.allocate(12);
  for (const [handle, device] of [
    [1, 0x11],
    [2, 0x11],
    [0x100, 7],
  ]) {
    r.data.fill(0xaa, info, info + 12);
    assert.equal(call(r, 'NtQueryVolumeInformationFile', [handle, status, info, 8, 4]), 0);
    assert.equal(r.read32(status), 0);
    assert.equal(r.read32(status + 4), 8);
    assert.equal(r.read32(info), device);
    assert.equal(r.read32(info + 4), 0);
    assert.ok(r.data.slice(info + 8, info + 12).every((byte) => byte === 0xaa));
  }
  for (const handle of [0, 0x9999]) {
    assert.equal(call(r, 'NtQueryVolumeInformationFile', [handle, status, info, 8, 4]), 0xc0000008);
    assert.equal(r.read32(status), 0xc0000008);
    assert.equal(r.read32(status + 4), 0);
  }
  assert.equal(call(r, 'NtQueryVolumeInformationFile', [1, status, info, 7, 4]), 0xc0000023);
  assert.equal(r.read32(status), 0xc0000023);
  assert.equal(call(r, 'NtQueryVolumeInformationFile', [1, status, 0, 8, 4]), 0xc0000005);
  assert.equal(call(r, 'NtQueryVolumeInformationFile', [1, 0, info, 8, 4]), 0xc0000005);
  assert.throws(
    () => call(r, 'NtQueryVolumeInformationFile', [1, status, info, 8, 5]),
    /Unsupported Wine volume information class 5/,
  );
});

test('NtReadFile supports partial and positioned synchronous reads with truthful IOSB results', () => {
  const { r } = fixture();
  const status = io(r),
    buffer = r.allocate(16),
    position = r.allocate(8);
  r.view.setBigInt64(position, 2n, true);
  r.data.fill(0xaa, buffer, buffer + 16);
  assert.equal(call(r, 'NtReadFile', [0x100, 0, 0, 0, status, buffer, 10, position, 0]), 0);
  assert.equal(r.read32(status + 4), 4);
  assert.deepEqual([...r.data.slice(buffer, buffer + 4)], [0x43, 0x44, 0x45, 0x46]);
  assert.ok(r.data.slice(buffer + 4, buffer + 16).every((byte) => byte === 0xaa));
  assert.equal(r.handles.get(0x100).position, 6);
  assert.equal(call(r, 'NtReadFile', [0x100, 0, 0, 0, status, buffer, 1, 0, 0]), 0xc0000011);
  assert.equal(r.read32(status), 0xc0000011);
  assert.equal(r.read32(status + 4), 0);
  assert.equal(call(r, 'NtReadFile', [0x100, 0, 0, 0, status, 0, 0, 0, 0]), 0);
  assert.equal(r.read32(status + 4), 0);
});

test('NtReadFile validates access, handles, offsets, buffers, and synchronous-only arguments', () => {
  const { r } = fixture();
  const status = io(r),
    buffer = r.allocate(4),
    position = r.allocate(8);
  assert.equal(call(r, 'NtReadFile', [0x101, 0, 0, 0, status, buffer, 1, 0, 0]), 0xc0000022);
  assert.equal(call(r, 'NtReadFile', [1, 0, 0, 0, status, buffer, 1, 0, 0]), 0xc0000008);
  assert.equal(call(r, 'NtReadFile', [0x999, 0, 0, 0, status, buffer, 1, 0, 0]), 0xc0000008);
  assert.equal(call(r, 'NtReadFile', [0x100, 0, 0, 0, status, 0, 1, 0, 0]), 0xc0000005);
  r.view.setBigInt64(position, -1n, true);
  assert.equal(call(r, 'NtReadFile', [0x100, 0, 0, 0, status, buffer, 1, position, 0]), 0xc000000d);
  assert.equal(call(r, 'NtReadFile', [0x100, 0, 0, 0, 0, buffer, 1, 0, 0]), 0xc0000005);
  assert.equal(
    call(r, 'NtReadFile', [0x100, 0xdeadbeec, 0, 0, status, buffer, 1, 0, 0]),
    0xc0000008,
  );
});

test('NtWriteFile writes virtual files and actual byte-output pipes with offsets and limits', () => {
  const { r, output } = fixture();
  const status = io(r),
    source = r.allocate(8),
    position = r.allocate(8);
  r.data.set(new TextEncoder().encode('xy!'), source);
  r.view.setBigInt64(position, 1n, true);
  assert.equal(call(r, 'NtWriteFile', [0x100, 0, 0, 0, status, source, 2, position, 0]), 0);
  assert.equal(r.read32(status + 4), 2);
  assert.equal(new TextDecoder().decode(r.files.get('data.bin')), 'AxyDEF');
  assert.equal(r.handles.get(0x100).position, 3);
  r.view.setBigInt64(position, -1n, true);
  assert.equal(call(r, 'NtWriteFile', [0x100, 0, 0, 0, status, source + 2, 1, position, 0]), 0);
  assert.equal(new TextDecoder().decode(r.files.get('data.bin')), 'AxyDEF!');
  assert.ok(r.dirty.has('data.bin'));

  assert.equal(call(r, 'NtWriteFile', [1, 0, 0, 0, status, source, 3, 0, 0]), 0);
  assert.equal(call(r, 'NtWriteFile', [2, 0, 0, 0, status, source + 2, 1, 0, 0]), 0);
  assert.equal(
    output
      .filter((event) => event.type === 'stdout')
      .map((event) => event.text)
      .join(''),
    'xy!!',
  );
  assert.equal(r.read32(status + 4), 1);
  assert.equal(call(r, 'NtWriteFile', [1, 0, 0, 0, status, source, 1, position, 0]), 0xc000000d);
});

test('NtWriteFile enforces permissions and NtClose closes only regular file handles', () => {
  const { r } = fixture();
  const status = io(r),
    source = r.allocate(4);
  r.data.set([1, 2, 3, 4], source);
  assert.equal(call(r, 'NtWriteFile', [0x102, 0, 0, 0, status, source, 4, 0, 0]), 0xc0000022);
  assert.equal(call(r, 'NtWriteFile', [0x999, 0, 0, 0, status, source, 4, 0, 0]), 0xc0000008);
  assert.equal(call(r, 'NtWriteFile', [0x100, 0, 0, 0, status, 0, 4, 0, 0]), 0xc0000005);
  assert.equal(call(r, 'NtClose', [0x100]), 0);
  assert.ok(!r.handles.has(0x100));
  assert.equal(call(r, 'NtClose', [1]), 0);
  assert.equal(call(r, 'NtClose', [1]), 0xc0000008);
  assert.equal(call(r, 'NtWriteFile', [1, 0, 0, 0, status, source, 4, 0, 0]), 0xc0000008);
  assert.equal(call(r, 'NtWriteFile', [2, 0, 0, 0, status, source, 4, 0, 0]), 0);
});

test('NT random/sequential cache hints retain real synchronous file reads and arbitrary seeks', () => {
  const { r } = fixture();
  r.handles.clear();
  try {
    const status = io(r),
      out = r.allocate(4),
      buffer = r.allocate(8),
      offset = r.allocate(8),
      attrs = fileAttributes(r, '\\??\\C:\\winebrowser\\data.bin');
    for (const hint of [0x4, 0x800, 0x804])
      for (const open of [false, true]) {
        const options = 0x60 | hint;
        assert.equal(
          open
            ? call(r, 'NtOpenFile', [out, 0x80100080, attrs, status, 1, options])
            : call(r, 'NtCreateFile', [out, 0x80100080, attrs, status, 0, 0, 1, 1, options, 0, 0]),
          0,
        );
        const h = r.read32(out);
        assert.equal(r.read32(status + 4), 1);
        r.view.setBigInt64(offset, 4n, true);
        assert.equal(call(r, 'NtReadFile', [h, 0, 0, 0, status, buffer, 4, offset, 0]), 0);
        assert.deepEqual([...r.data.slice(buffer, buffer + 2)], [0x45, 0x46]);
        assert.equal(r.read32(status + 4), 2);
        assert.equal(call(r, 'NtReadFile', [h, 0, 0, 0, status, buffer, 1, 0, 0]), 0xc0000011);
        r.view.setBigInt64(offset, 1n, true);
        assert.equal(call(r, 'NtSetInformationFile', [h, status, offset, 8, 14]), 0);
        assert.equal(call(r, 'NtReadFile', [h, 0, 0, 0, status, buffer, 2, 0, 0]), 0);
        assert.deepEqual([...r.data.slice(buffer, buffer + 2)], [0x42, 0x43]);
        assert.equal(call(r, 'NtWriteFile', [h, 0, 0, 0, status, buffer, 1, 0, 0]), 0xc0000022);
        assert.equal(call(r, 'NtClose', [h]), 0);
      }
    for (const options of [0x840, 0x868]) {
      assert.equal(
        call(r, 'NtCreateFile', [out, 0x80100080, attrs, status, 0, 0, 1, 1, options, 0, 0]),
        0xc00000bb,
      );
      assert.equal(r.handles.size, 0);
    }
    assert.equal(
      call(r, 'NtCreateFile', [out, 0x80100080, attrs, status, 0, 0, 1, 1, 0x1860, 0, 0]),
      0xc0000022,
      'delete-on-close needs DELETE access',
    );
    assert.deepEqual([...r.files.get('data.bin')], [0x41, 0x42, 0x43, 0x44, 0x45, 0x46]);
    assert.equal(r.dirty.size, 0);
  } finally {
    r.cpu.dispose();
  }
});

test('synchronous positioned I/O accepts opaque OVERLAPPED contexts without an APC routine', () => {
  const { r } = fixture(),
    status = io(r),
    buffer = r.allocate(8),
    offset = r.allocate(8);
  r.view.setBigInt64(offset, 2n, true);
  assert.equal(call(r, 'NtReadFile', [0x100, 0, 0, 0xdeadbeef, status, buffer, 2, offset, 0]), 0);
  assert.equal(r.read32(status), 0);
  assert.equal(r.read32(status + 4), 2);
  assert.deepEqual([...r.data.slice(buffer, buffer + 2)], [0x43, 0x44]);
  r.view.setBigInt64(offset, 1n, true);
  r.data.set([0x58, 0x59], buffer);
  assert.equal(call(r, 'NtWriteFile', [0x100, 0, 0, status, status, buffer, 2, offset, 0]), 0);
  assert.deepEqual([...r.files.get('data.bin')], [0x41, 0x58, 0x59, 0x44, 0x45, 0x46]);
  assert.throws(
    () => call(r, 'NtReadFile', [0x100, 0, 1, status, status, buffer, 2, offset, 0]),
    /Unsupported asynchronous NtReadFile/,
  );
});

function lockRange(r, start, count) {
  const offset = r.allocate(8),
    length = r.allocate(8);
  r.view.setBigInt64(offset, start, true);
  r.view.setBigInt64(length, count, true);
  return { offset, length };
}
const lock = (r, handle, range, exclusive = false, wait = false) =>
  call(r, 'NtLockFile', [
    handle,
    0,
    0,
    0,
    0,
    range.offset,
    range.length,
    0,
    Number(!wait),
    Number(exclusive),
  ]);
const unlock = (r, handle, range, status) =>
  call(r, 'NtUnlockFile', [handle, status, range.offset, range.length, 0]);

test('NT byte locks preserve 64-bit ranges, shared readers, conflicts and exact unlock ownership', () => {
  const { r } = fixture(),
    status = io(r),
    range = lockRange(r, 0x100000000n, 512n);
  assert.equal(lock(r, 0x100, range), 0);
  assert.equal(lock(r, 0x102, range), 0);
  assert.equal(lock(r, 0x101, range, true), 0xc0000055);
  assert.equal(unlock(r, 0x101, range, status), 0xc000007e);
  assert.equal(r.read32(status), 0xc000007e);
  const wrong = lockRange(r, 0x100000001n, 511n);
  assert.equal(unlock(r, 0x100, wrong, status), 0xc000007e);
  assert.equal(unlock(r, 0x100, range, status), 0);
  assert.equal(r.read32(status + 4), 0);
  assert.equal(unlock(r, 0x102, range, status), 0);
  assert.equal(lock(r, 0x101, range, true), 0);
  assert.equal(lock(r, 0x100, range), 0xc0000055);
  assert.equal(call(r, 'NtClose', [0x101]), 0);
  assert.equal(lock(r, 0x100, range, true), 0, 'closing the owner releases locks');
});

test('NT file locks enforce positioned I/O and host API access to the same bytes', () => {
  const { r } = fixture(),
    status = io(r),
    range = lockRange(r, 1n, 2n),
    buffer = r.allocate(8);
  assert.equal(lock(r, 0x100, range, true), 0);
  assert.equal(
    call(r, 'NtReadFile', [0x102, 0, 0, 0, status, buffer, 2, range.offset, 0]),
    0xc0000054,
  );
  assert.equal(
    call(r, 'NtWriteFile', [0x101, 0, 0, 0, status, buffer, 2, range.offset, 0]),
    0xc0000054,
  );
  assert.equal(call(r, 'NtReadFile', [0x100, 0, 0, 0, status, buffer, 2, range.offset, 0]), 0);
  r.handles.get(0x102).position = 1;
  const hostRead = r.apiProvider.get('kernel32.dll!ReadFile')(
    r,
    (i) => [0x102, buffer, 2, status, 0][i],
  );
  assert.equal(hostRead.result, 0);
  assert.equal(r.lastError, 33);
  assert.equal(lock(r, 0x100, range), 0, 'owner may add a shared lock over its exclusive lock');
  assert.equal(
    call(r, 'NtWriteFile', [0x100, 0, 0, 0, status, buffer, 2, range.offset, 0]),
    0xc0000054,
  );
  assert.equal(unlock(r, 0x100, range, status), 0, 'exclusive match unlocks first');
  assert.equal(call(r, 'NtReadFile', [0x102, 0, 0, 0, status, buffer, 2, range.offset, 0]), 0);
  assert.equal(
    call(r, 'NtWriteFile', [0x100, 0, 0, 0, status, buffer, 2, range.offset, 0]),
    0xc0000054,
  );
  assert.equal(unlock(r, 0x100, range, status), 0);
  assert.equal(call(r, 'NtWriteFile', [0x100, 0, 0, 0, status, buffer, 2, range.offset, 0]), 0);
});

test('byte lock failures validate pointers, ranges and access without acquiring locks', () => {
  const { r } = fixture(),
    status = io(r),
    range = lockRange(r, 0n, 0n);
  assert.equal(lock(r, 0x999, range, true), 0xc0000008);
  assert.equal(lock(r, 0x100, range, true), 0xc000000d);
  r.view.setBigInt64(range.offset, -1n, true);
  r.view.setBigInt64(range.length, 1n, true);
  assert.equal(lock(r, 0x100, range, true), 0xc000000d);
  r.view.setBigInt64(range.offset, 0x7fffffffffffffffn, true);
  assert.equal(lock(r, 0x100, range, true), 0xc000000d);
  assert.equal(
    call(r, 'NtLockFile', [0x100, 0, 0, 0, status, 0, range.length, 0, 1, 1]),
    0xc0000005,
  );
  assert.deepEqual(r.fileLocks ?? [], []);
  assert.equal(call(r, 'NtFlushBuffersFile', [0x100, status]), 0);
  assert.equal(r.read32(status + 4), 0);
  assert.equal(call(r, 'NtFlushBuffersFile', [0x102, status]), 0xc0000022);
  assert.equal(call(r, 'NtFlushBuffersFile', [0x999, status]), 0xc0000008);
  assert.equal(call(r, 'NtFlushBuffersFile', [0x100, 0]), 0xc0000005);
});

test('native deletion obeys delete sharing and delays removal until the final handle closes', () => {
  const { r } = fixture(),
    status = io(r),
    out = r.allocate(4),
    info = r.allocate(24);
  r.handles.clear();
  const attrs = fileAttributes(r, '\\??\\C:\\winebrowser\\data.bin');
  assert.equal(call(r, 'NtOpenFile', [out, 0x80100080, attrs, status, 3, 0x60]), 0);
  const reader = r.read32(out);
  const remove = [out, 0x110000, attrs, status, 0, 0, 7, 1, 0x201040, 0, 0];
  assert.equal(call(r, 'NtCreateFile', remove), 0xc0000043, 'reader did not share deletion');
  assert.equal(call(r, 'NtClose', [reader]), 0);
  assert.equal(call(r, 'NtOpenFile', [out, 0x80100080, attrs, status, 7, 0x60]), 0);
  const shared = r.read32(out);
  assert.equal(call(r, 'NtCreateFile', remove), 0);
  const deletion = r.read32(out);
  assert.equal(call(r, 'NtQueryInformationFile', [shared, status, info, 24, 5]), 0);
  assert.equal(r.data[info + 20], 1);
  assert.equal(call(r, 'NtOpenFile', [out, 0x80100080, attrs, status, 7, 0x60]), 0xc0000056);
  assert.equal(call(r, 'NtClose', [deletion]), 0);
  assert.equal(r.files.has('data.bin'), true);
  assert.equal(call(r, 'NtReadFile', [shared, 0, 0, 0, status, info, 2, 0, 0]), 0);
  assert.deepEqual([...r.data.slice(info, info + 2)], [0x41, 0x42]);
  const hostClose = r.apiProvider.get('kernel32.dll!CloseHandle')(r, () => shared);
  assert.equal(hostClose.result, 1);
  assert.equal(r.files.has('data.bin'), false);
  assert.ok(r.dirty.has('data.bin'));
  assert.equal(r.pendingFileDeletes.size, 0);
});

test('FileDispositionInformation can cancel a pending deletion with checked delete rights', () => {
  const { r } = fixture(),
    status = io(r),
    out = r.allocate(4),
    info = r.allocate(24);
  r.handles.clear();
  const attrs = fileAttributes(r, '\\??\\C:\\winebrowser\\data.bin');
  assert.equal(call(r, 'NtOpenFile', [out, 0xc0110080, attrs, status, 7, 0x60]), 0);
  const handle = r.read32(out);
  r.data[info] = 1;
  assert.equal(call(r, 'NtSetInformationFile', [handle, status, info, 1, 13]), 0);
  assert.equal(r.pendingFileDeletes.has('data.bin'), true);
  r.data[info] = 0;
  assert.equal(call(r, 'NtSetInformationFile', [handle, status, info, 1, 13]), 0);
  assert.equal(call(r, 'NtClose', [handle]), 0);
  assert.equal(r.files.has('data.bin'), true);
  assert.equal(call(r, 'NtOpenFile', [out, 0x80100080, attrs, status, 7, 0x60]), 0);
  r.data[info] = 1;
  assert.equal(call(r, 'NtSetInformationFile', [r.read32(out), status, info, 1, 13]), 0xc0000022);
});

test('waiting byte locks resume on unlock or owner close and fail when their own handle closes', async () => {
  const { r } = fixture(),
    status = io(r),
    range = lockRange(r, 2n, 3n);
  assert.equal(lock(r, 0x100, range, true), 0);
  let completed = false;
  const waiting = lock(r, 0x101, range, true, true).then((s) => {
    completed = true;
    return s;
  });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(r.fileLockWaiters.size, 1);
  assert.equal(unlock(r, 0x100, range, status), 0);
  assert.equal(await waiting, 0);
  assert.equal(r.fileLockWaiters.size, 0);
  assert.equal(r.fileLocks[0].handle, 0x101);
  const next = lock(r, 0x100, range, true, true);
  assert.equal(call(r, 'NtClose', [0x101]), 0);
  assert.equal(await next, 0);
  const closed = lock(r, 0x102, range, true, true);
  assert.equal(call(r, 'NtClose', [0x102]), 0);
  assert.equal(await closed, 0xc0000008);
  assert.equal(r.fileLockWaiters.size, 0);
});

test('NT file reads, writes and lock acquisition signal real completion events', async () => {
  const { r } = fixture(),
    status = io(r),
    range = lockRange(r, 1n, 2n),
    buffer = r.allocate(8);
  const objects = syncObjects(r),
    event = objects.event({ manual: true }).handle;
  assert.equal(
    call(r, 'NtReadFile', [0x100, event | 1, 0, status, status, buffer, 2, range.offset, 0]),
    0,
  );
  assert.equal(objects.lookup(event, 'sync-event').object.signaled, true);
  objects.change(event, 'reset');
  r.data.set([0x31, 0x32], buffer);
  assert.equal(
    call(r, 'NtWriteFile', [0x100, event, 0, status, status, buffer, 2, range.offset, 0]),
    0,
  );
  assert.equal(objects.lookup(event, 'sync-event').object.signaled, true);
  objects.change(event, 'reset');
  assert.equal(lock(r, 0x100, range, true), 0);
  const waiting = call(r, 'NtLockFile', [
    0x101,
    event | 1,
    0,
    status,
    status,
    range.offset,
    range.length,
    0,
    0,
    1,
  ]);
  assert.equal(objects.lookup(event, 'sync-event').object.signaled, false);
  assert.equal(unlock(r, 0x100, range, status), 0);
  assert.equal(await waiting, 0);
  assert.equal(objects.lookup(event, 'sync-event').object.signaled, true);
  assert.equal(r.read32(status), 0);
  assert.equal(r.read32(status + 4), 0);
});

test('thread cancellation removes waiting locks without acquiring a later orphaned region', async () => {
  const { r } = fixture(),
    range = lockRange(r, 1n, 1n),
    status = io(r);
  assert.equal(lock(r, 0x100, range, true), 0);
  // Inject the scheduler's cancellation result without constructing a fake
  // guest stack; the real threaded browser fixture covers park/resume.
  r.threads.block = () => Promise.reject(Error('cancelled thread'));
  await assert.rejects(lock(r, 0x101, range, true, true), /cancelled thread/);
  assert.equal(r.fileLockWaiters.size, 0);
  assert.equal(unlock(r, 0x100, range, status), 0);
  assert.equal(r.fileLocks.length, 0);
});

test('native directory handles enumerate exact/wildcard names and close without becoming data files', () => {
  const { r } = fixture(),
    out = r.allocate(4),
    status = io(r),
    root = fileAttributes(r, '\\??\\C:\\winebrowser\\');
  assert.equal(call(r, 'NtOpenFile', [out, 0x100001, root, status, 3, 0x4021]), 0);
  const handle = r.read32(out),
    buf = r.allocate(512),
    name = r.allocString('data.bin', true),
    mask = r.allocate(8);
  r.view.setUint16(mask, 16, true);
  r.view.setUint16(mask + 2, 18, true);
  r.write32(mask + 4, name);
  assert.equal(
    call(r, 'NtQueryDirectoryFile', [handle, 0, 0, 0, status, buf, 512, 63, 0, mask, 1]),
    0,
  );
  assert.equal(r.read32(buf), 0);
  assert.equal(r.read32(buf + 60), 16);
  assert.equal(r.view.getBigUint64(buf + 40, true), 6n);
  let found = '';
  for (let i = 0; i < 8; i++)
    found += String.fromCharCode(r.view.getUint16(buf + 114 + i * 2, true));
  assert.equal(found, 'data.bin');
  assert.equal(
    call(r, 'NtQueryDirectoryFile', [handle, 0, 0, 0, status, buf, 512, 63, 0, 0, 0]),
    0x80000006,
  );
  assert.equal(call(r, 'NtReadFile', [handle, 0, 0, 0, status, buf, 1, 0, 0]), 0xc0000008);
  assert.equal(
    call(r, 'NtQueryDirectoryFile', [handle, 0, 0, 0, status, buf, 8, 63, 0, mask, 1]),
    0xc0000023,
  );
  assert.equal(
    call(r, 'NtQueryDirectoryFile', [handle, 0, 0, 0, status, buf, 512, 63, 0, 0, 0]),
    0,
  );
  assert.equal(call(r, 'NtClose', [handle]), 0);
  assert.equal(call(r, 'NtClose', [handle]), 0xc0000008);
  const dir = fileAttributes(r, '\\??\\C:\\winebrowser\\newdir');
  assert.equal(
    call(r, 'NtCreateFile', [out, 0x100001, dir, status, 0, 0x10, 3, 2, 0x4021, 0, 0]),
    0,
  );
  assert.ok(r.virtualDirectories.has('newdir/'));
  assert.equal(r.files.has('newdir'), false);
  assert.equal(call(r, 'NtClose', [r.read32(out)]), 0);
  assert.equal(
    call(r, 'NtCreateFile', [out, 0x100001, dir, status, 0, 0x10, 3, 2, 0x4021, 0, 0]),
    0xc0000035,
  );
  r.cpu.dispose();
});

test('native output opens respect empty created directories and timestamp updates retain unspecified fields', () => {
  const { r } = fixture(),
    out = r.allocate(4),
    status = io(r),
    dir = fileAttributes(r, '\\??\\C:\\winebrowser\\output');
  assert.equal(
    call(r, 'NtCreateFile', [out, 0x100001, dir, status, 0, 0x10, 3, 2, 0x4021, 0, 0]),
    0,
  );
  assert.equal(call(r, 'NtClose', [r.read32(out)]), 0);
  const file = fileAttributes(r, '\\??\\C:\\winebrowser\\output\\result.bin');
  assert.equal(
    call(r, 'NtCreateFile', [out, 0x40100100, file, status, 0, 0x80, 3, 2, 0x60, 0, 0]),
    0,
  );
  const handle = r.read32(out),
    basic = r.allocate(40),
    creation = r.fileTimes.get('output/result.bin').creation;
  r.view.setBigInt64(basic + 16, creation + 12345n, true);
  assert.equal(call(r, 'NtSetInformationFile', [handle, status, basic, 40, 4]), 0);
  assert.equal(r.fileTimes.get('output/result.bin').creation, creation);
  assert.equal(r.fileTimes.get('output/result.bin').write, creation + 12345n);
  r.view.setBigInt64(basic, -1n, true);
  assert.equal(call(r, 'NtSetInformationFile', [handle, status, basic, 40, 4]), 0xc00000bb);
  assert.equal(r.fileTimes.get('output/result.bin').write, creation + 12345n);
  assert.equal(call(r, 'NtClose', [handle]), 0);
  r.cpu.dispose();
});
