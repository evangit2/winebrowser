import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';

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
  return { r, output };
}
const call = (r, name, args) => ntServices[name].call(r, (index) => args[index] ?? 0);
const io = (r) => {
  const pointer = r.allocate(8);
  r.data.fill(0xaa, pointer, pointer + 8);
  return pointer;
};

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
