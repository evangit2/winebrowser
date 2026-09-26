import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
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
  assert.throws(
    () => call(r, 'NtReadFile', [0x100, 1, 0, 0, status, buffer, 1, 0, 0]),
    /Unsupported asynchronous NtReadFile/,
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
  assert.throws(() => call(r, 'NtClose', [1]), /Unsupported Wine NT service NtClose/);
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
    for (const options of [0x840, 0x868, 0x1860]) {
      assert.equal(
        call(r, 'NtCreateFile', [out, 0x80100080, attrs, status, 0, 0, 1, 1, options, 0, 0]),
        0xc00000bb,
      );
      assert.equal(r.handles.size, 0);
    }
    assert.deepEqual([...r.files.get('data.bin')], [0x41, 0x42, 0x43, 0x44, 0x45, 0x46]);
    assert.equal(r.dirty.size, 0);
  } finally {
    r.cpu.dispose();
  }
});
