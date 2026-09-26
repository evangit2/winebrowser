import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
import { fileSections, SECTION as S } from '../src/file-sections.js';
import { VirtualMemoryConstants as VM } from '../src/virtual-memory.js';
const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
const nt = (r, name, args) => ntServices[name].call(r, (i) => args[i] ?? 0);
const win = (r, name, args) =>
  r.apiProvider.get('kernel32.dll!' + name)(r, (i) => args[i] ?? 0).result;
function fixture() {
  const bytes = Uint8Array.from({ length: 65573 }, (_, i) => (i * 7 + 31) & 255);
  const r = new Runtime(iced, {
    files: new Map([
      ['console.exe', exe],
      ['data.bin', bytes],
    ]),
    exe: 'console.exe',
  });
  r.handles.set(256, { path: 'data.bin', access: 0x80000000, position: 0, share: 3 });
  r.handles.set(257, { path: 'data.bin', access: 0xc0000000, position: 0, share: 3 });
  r.nextHandle = 258;
  return { r, sections: fileSections(r), bytes };
}
function mapping(r, section, offset = 0n, size = 0, base = 0) {
  const out = r.allocate(16);
  r.write32(out, base);
  r.write32(out + 4, size);
  r.view.setBigInt64(out + 8, offset, true);
  const args = [section, 0xffffffff, out, 0, 0, out + 8, out + 4, 1, 0, 2];
  return { out, args, call: () => nt(r, 'NtMapViewOfSection', args) };
}

test('NT file sections retain read-only views after closing both handles and unmap interior addresses', () => {
  const { r, sections, bytes } = fixture(),
    out = r.allocate(16),
    attr = r.allocate(24);
  [24, 0, 0, 0xc2, 0, 0].forEach((v, i) => r.write32(attr + 4 * i, v));
  assert.equal(nt(r, 'NtCreateSection', [out, 0xf0005, attr, 0, 2, S.COMMIT, 256]), 0);
  const section = r.read32(out);
  assert.equal(r.handles.get(section).inherit, true);
  assert.equal(nt(r, 'NtClose', [256]), 0);
  const view = mapping(r, section);
  view.args[4] = 0xffffffff; // CommitSize is ignored for file-backed sections.
  assert.equal(view.call(), 0);
  const base = r.read32(view.out),
    size = r.read32(view.out + 4);
  assert.equal(size, 69632);
  assert.deepEqual(r.data.slice(base, base + bytes.length), bytes);
  assert.ok(r.data.slice(base + bytes.length, base + size).every((v) => v === 0));
  assert.throws(() => r.write32(base, 1), /write violation/);
  assert.equal(nt(r, 'NtClose', [section]), 0);
  assert.equal(nt(r, 'NtClose', [section]), S.HANDLE);
  assert.equal(r.read32(base), 0x342d261f);
  assert.equal(sections.objects.size, 1);
  assert.equal(nt(r, 'NtUnmapViewOfSection', [1, base]), S.HANDLE);
  assert.equal(nt(r, 'NtUnmapViewOfSection', [0xffffffff, base + size - 1]), 0);
  assert.equal(sections.objects.size, 0);
  assert.ok(r.data.slice(base, base + size).every((v) => v === 0));
  assert.throws(() => r.read32(base), /read violation/);
  assert.equal(nt(r, 'NtUnmapViewOfSection', [0xffffffff, base]), 0xc0000019);
});

test('offset views enforce 64K alignment, exact section bounds, arena reservations and whole-page content', () => {
  const { r, sections, bytes } = fixture(),
    section = sections.create({ file: 256 }).handle;
  const reserved = r.virtualMemory.allocate(0, 4096, VM.MEM_RESERVE, 1).base;
  const view = mapping(r, section, 65536n, 1);
  assert.equal(view.call(), 0);
  const base = r.read32(view.out);
  assert.notEqual(base, reserved);
  assert.equal(r.read32(view.out + 4), 4096);
  assert.deepEqual(r.data.slice(base, base + 37), bytes.slice(65536));
  assert.equal(r.data[base + 37], 0);
  assert.equal(sections.map(section, { base: reserved }).status, 0xc0000018);
  assert.equal(sections.map(section, { base }).status, 0xc0000018);
  assert.equal(sections.map(section, { base: VM.arenaEnd }).status, 0xc0000018);
  for (const options of [
    { base: base + 1 },
    { base: base + 4096 },
    { offset: 1n },
    { offset: 4096n },
  ])
    assert.equal(sections.map(section, options).status, S.ALIGNMENT);
  for (const options of [
    { offset: 131072n },
    { size: bytes.length + 1 },
    { offset: 65536n, size: 38 },
  ])
    assert.equal(sections.map(section, options).status, S.VIEW_SIZE);
  assert.equal(r.virtualMemory.free(base, 0, VM.MEM_RELEASE).status, 0xc00000a0);
  const tiny = sections.create({ file: 256, size: 36n }).handle;
  const tinyView = sections.map(tiny);
  assert.equal(tinyView.size, 4096);
  assert.deepEqual(r.data.slice(tinyView.base, tinyView.base + 4096), bytes.slice(0, 4096));
  assert.equal(sections.map(tiny, { size: 37 }).status, S.VIEW_SIZE);
  assert.equal(nt(r, 'NtUnmapViewOfSection', [0xffffffff, base]), 0);
  assert.equal(sections.map(section, { base, offset: 65536n }).base, base);
});

test('NT section query returns exact file size and SEC_FILE; handle rights and types are enforced', () => {
  const { r, sections, bytes } = fixture(),
    out = r.allocate(24);
  const queryOnly = sections.create({ file: 256, access: S.QUERY }).handle;
  r.data.fill(0xcc, out, out + 24);
  assert.equal(nt(r, 'NtQuerySection', [queryOnly, 0, out, 20, out + 20]), 0);
  assert.equal(r.read32(out), 0);
  assert.equal(r.read32(out + 4), S.FILE);
  assert.equal(r.view.getBigInt64(out + 8, true), BigInt(bytes.length));
  assert.equal(r.read32(out + 16), 0xcccccccc);
  assert.equal(r.read32(out + 20), 16);
  assert.equal(sections.map(queryOnly).status, S.ACCESS);
  const readOnly = sections.create({ file: 256, access: S.READ }).handle;
  assert.equal(nt(r, 'NtQuerySection', [readOnly, 0, out, 16, 0]), S.ACCESS);
  assert.equal(nt(r, 'NtQuerySection', [queryOnly, 0, out, 15, 0]), 0xc0000004);
  assert.equal(nt(r, 'NtQuerySection', [queryOnly, 0, out, 16, 0xffffffff]), S.FAULT);
  assert.equal(nt(r, 'NtQuerySection', [queryOnly, 1, out, 48, 0]), S.UNSUPPORTED);
  assert.equal(sections.map(readOnly, { protection: 4 }).status, S.PROTECTION);
  assert.equal(sections.map(256).status, S.HANDLE);
  assert.equal(sections.create({ file: readOnly }).status, S.HANDLE);
  const all = sections.create({ file: 256, access: 0x10000000 }).handle;
  assert.equal(r.handles.get(all).access, S.ALL);
});

test('create/map validation preserves outputs, mappings, bytes and handle counts on failure', () => {
  const { r, sections } = fixture(),
    out = r.allocate(16),
    attr = r.allocate(24);
  r.write32(out, 0xaabbccdd);
  const args = [out, S.ALL, 0, 0, 2, S.COMMIT, 256];
  for (const [index, value, status] of [
    [0, 0, S.FAULT],
    [2, 1, S.FAULT],
    [3, 1, S.FAULT],
    [4, 4, S.UNSUPPORTED],
    [5, 0x1000000, S.UNSUPPORTED],
    [6, 999, S.HANDLE],
    [6, 0, S.UNSUPPORTED],
  ]) {
    const bad = [...args];
    bad[index] = value;
    assert.equal(nt(r, 'NtCreateSection', bad), status);
    assert.equal(r.read32(out), 0xaabbccdd);
    assert.equal(sections.objects.size, 0);
    assert.equal(r.handles.size, 2);
  }
  r.view.setBigInt64(out + 8, 65574n, true);
  assert.equal(nt(r, 'NtCreateSection', [out, S.ALL, 0, out + 8, 2, S.COMMIT, 256]), S.TOO_BIG);
  r.view.setBigInt64(out + 8, -1n, true);
  assert.equal(nt(r, 'NtCreateSection', [out, S.ALL, 0, out + 8, 2, S.COMMIT, 256]), S.INVALID);
  r.files.set('empty', new Uint8Array());
  r.handles.set(259, { path: 'empty', access: 0x80000000 });
  assert.equal(sections.create({ file: 259 }).status, S.EMPTY);
  r.handles.set(260, { path: 'data.bin', access: 0x40000000 });
  assert.equal(sections.create({ file: 260 }).status, S.ACCESS);
  [24, 0, 1, 0, 0, 0].forEach((v, i) => r.write32(attr + 4 * i, v));
  assert.equal(nt(r, 'NtCreateSection', [out, S.ALL, attr, 0, 2, S.COMMIT, 256]), S.UNSUPPORTED);
  const section = sections.create({ file: 256 }).handle,
    view = mapping(r, section);
  const memoryBefore = r.data.slice(VM.arenaStart, VM.arenaStart + 4096);
  for (const [index, value, status] of [
    [1, 1, S.HANDLE],
    [2, 0, S.FAULT],
    [3, 1, S.UNSUPPORTED],
    [6, 0, S.FAULT],
    [5, 1, S.FAULT],
    [7, 3, S.INVALID],
    [8, 0x2000, S.UNSUPPORTED],
    [9, 4, S.PROTECTION],
  ]) {
    const bad = [...view.args];
    bad[index] = value;
    assert.equal(nt(r, 'NtMapViewOfSection', bad), status);
    assert.equal(r.read32(view.out), 0);
    assert.equal(r.sectionViews.views.size, 0);
    assert.deepEqual(r.data.slice(VM.arenaStart, VM.arenaStart + 4096), memoryBefore);
  }
});

test('NT and Win32 writes update read-only aliases; truncation is blocked until the last section/view release', () => {
  const { r, sections } = fixture(),
    a = sections.create({ file: 256 }).handle;
  const b = win(r, 'CreateFileMappingW', [256, 0, 2, 0, 0, 0]);
  const first = sections.map(a),
    second = sections.map(b),
    tail = sections.map(b, { offset: 65536n });
  const buffer = r.allocate(16),
    io = r.allocate(8),
    offset = r.allocate(8);
  r.data.set([9, 8, 7, 6], buffer);
  r.view.setBigInt64(offset, 0n, true);
  assert.equal(nt(r, 'NtWriteFile', [257, 0, 0, 0, io, buffer, 4, offset, 0]), 0);
  for (const view of [first, second]) assert.equal(r.read32(view.base), 0x06070809);
  r.handles.get(257).position = 65536;
  assert.equal(win(r, 'WriteFile', [257, buffer, 4, io, 0]), 1);
  assert.equal(r.read32(tail.base), 0x06070809);
  assert.equal(r.read32(first.base + 65536), 0x06070809);
  r.view.setBigInt64(buffer, 0n, true);
  const truncate = () => nt(r, 'NtSetInformationFile', [257, io, buffer, 8, 20]);
  assert.equal(truncate(), S.USER_MAPPED_FILE);
  const name = r.allocString('data.bin');
  assert.equal(win(r, 'CreateFileA', [name, 0xc0000000, 3, 0, 2, 0x80, 0]), 0xffffffff);
  assert.equal(r.lastError, 1224);
  assert.equal(win(r, 'CloseHandle', [a]), 1);
  assert.equal(nt(r, 'NtClose', [b]), 0);
  assert.equal(truncate(), S.USER_MAPPED_FILE);
  for (const view of [first, second]) assert.equal(win(r, 'UnmapViewOfFile', [view.base + 2]), 1);
  assert.equal(truncate(), S.USER_MAPPED_FILE);
  assert.equal(nt(r, 'NtUnmapViewOfSection', [0xffffffff, tail.base]), 0);
  assert.equal(truncate(), 0);
  assert.equal(r.files.get('data.bin').length, 0);
  assert.equal(sections.objects.size, 0);
});

test('Win32 mappings share NT objects, report failures and reject unsupported mapping modes', () => {
  const { r, sections } = fixture(),
    section = win(r, 'CreateFileMappingA', [256, 0, 2, 0, 0, 0]);
  assert.ok(section);
  assert.equal(r.lastError, 0);
  assert.equal(win(r, 'CloseHandle', [256]), 1);
  assert.equal(win(r, 'MapViewOfFile', [section, 4, 0, 1, 0]), 0);
  assert.equal(r.lastError, 1132);
  assert.equal(win(r, 'MapViewOfFile', [section, 4, 1, 0, 0]), 0);
  assert.equal(r.lastError, 87);
  assert.equal(win(r, 'MapViewOfFile', [section, 2, 0, 0, 0]), 0);
  const base = win(r, 'MapViewOfFileEx', [section, 4, 0, 65536, 0, VM.arenaStart]);
  assert.equal(base, VM.arenaStart);
  assert.equal(win(r, 'CloseHandle', [section]), 1);
  assert.equal(win(r, 'CloseHandle', [section]), 0);
  assert.equal(r.lastError, 6);
  assert.equal(win(r, 'UnmapViewOfFile', [base + 4095]), 1);
  assert.equal(win(r, 'UnmapViewOfFile', [base]), 0);
  assert.equal(r.lastError, 487);
  assert.equal(sections.objects.size, 0);
});

test('section and view resource exhaustion fails without leaking handles or mappings', () => {
  const { r, sections } = fixture();
  for (let i = 0; i < 256; i++) assert.equal(sections.create({ file: 256 }).status, 0);
  assert.equal(sections.create({ file: 256 }).status, S.MEMORY);
  const section = [...r.handles].find(([, v]) => v.kind === 'file-section')[0];
  r.virtualMemory.allocate(0, VM.arenaEnd - VM.arenaStart, VM.MEM_RESERVE, 1);
  assert.equal(sections.map(section).status, S.MEMORY);
  assert.equal(r.sectionViews.views.size, 0);
  for (const [handle, value] of [...r.handles])
    if (value.kind === 'file-section') sections.close(handle);
  assert.equal(sections.objects.size, 0);
  assert.equal(r.handles.size, 2);
});

test('file growth refreshes page tails but preserves section maximum sizes and map boundaries', () => {
  const { r, sections } = fixture(),
    section = sections.create({ file: 256 }).handle;
  const tail = sections.map(section, { offset: 65536n }),
    buffer = r.allocate(16),
    io = r.allocate(8);
  r.data.set([99, 88, 77, 66], buffer);
  r.handles.get(257).position = 65573;
  assert.equal(win(r, 'WriteFile', [257, buffer, 4, io, 0]), 1);
  assert.equal(r.read32(tail.base + 37), 0x424d5863);
  assert.equal(sections.map(section, { offset: 65536n, size: 41 }).status, S.VIEW_SIZE);
  r.view.setBigInt64(buffer, 69632n, true);
  assert.equal(nt(r, 'NtSetInformationFile', [257, io, buffer, 8, 20]), 0);
  assert.equal(r.read32(tail.base + 37), 0x424d5863);
  assert.equal(r.read32(tail.base + 4092), 0);
  assert.equal(nt(r, 'NtQuerySection', [section, 0, buffer, 16, 0]), 0);
  assert.equal(r.view.getBigInt64(buffer + 8, true), 65573n);
});

test('NT overwrite dispositions preserve mapped backing files and release the restriction after unmap', () => {
  const { r, sections, bytes } = fixture(),
    section = sections.create({ file: 256 }).handle;
  const view = sections.map(section),
    out = r.allocate(4),
    io = r.allocate(8),
    name = '\\??\\C:\\winebrowser\\data.bin';
  const string = r.allocString(name, true),
    unicode = r.allocate(8),
    attr = r.allocate(24);
  r.view.setUint16(unicode, name.length * 2, true);
  r.view.setUint16(unicode + 2, (name.length + 1) * 2, true);
  r.write32(unicode + 4, string);
  [24, 0, unicode, 0x40, 0, 0].forEach((v, i) => r.write32(attr + 4 * i, v));
  const args = [out, 0xc0100080, attr, io, 0, 0x80, 3, 4, 0x60, 0, 0];
  r.write32(out, 0xaabbccdd);
  for (const disposition of [4, 5]) {
    args[7] = disposition;
    assert.equal(nt(r, 'NtCreateFile', args), S.USER_MAPPED_FILE);
    assert.equal(r.read32(out), 0xaabbccdd);
    assert.deepEqual(r.files.get('data.bin'), bytes);
  }
  assert.equal(nt(r, 'NtClose', [section]), 0);
  assert.equal(nt(r, 'NtCreateFile', args), S.USER_MAPPED_FILE);
  assert.equal(nt(r, 'NtUnmapViewOfSection', [0xffffffff, view.base]), 0);
  assert.equal(nt(r, 'NtCreateFile', args), 0);
  assert.equal(r.files.get('data.bin').length, 0);
});
