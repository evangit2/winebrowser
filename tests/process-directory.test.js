import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { PROCESS_LAYOUT } from '../src/process-layout.js';
import { setProcessDirectory } from '../src/process-directory.js';

const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup(t) {
  const r = new Runtime(iced, {
    files: new Map([
      ['app/client.exe', exe],
      ['a/asset.bin', new Uint8Array([7])],
    ]),
    exe: 'app/client.exe',
  });
  r.virtualDirectories.add('b/');
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  return r;
}
function descriptor(r) {
  return r.read32(PROCESS_LAYOUT.peb + 0x10) + 0x24;
}
function writeDirectory(r, value, capacity = 520) {
  const p = descriptor(r),
    buffer = r.allocate(capacity);
  r.guestMemory.write(p, value.length * 2, 2);
  r.guestMemory.write(p + 2, capacity, 2);
  r.write32(p + 4, buffer);
  for (let i = 0; i <= value.length; i++)
    r.guestMemory.write(buffer + i * 2, value.charCodeAt(i) || 0, 2);
}
function native(r) {
  r.wineProcess = {
    parameters: r.bootstrapProcessParameters,
    module: {
      base: 0x10000000,
      pe: {
        exports: [
          { name: 'RtlSetCurrentDirectory_U', rva: 16 },
          { name: 'RtlNtStatusToDosError', rva: 32 },
        ],
      },
    },
  };
  writeDirectory(r, 'C:\\winebrowser\\app\\');
}

test('host directory changes update normalized process parameters inspected by ordinary native CRT code', async (t) => {
  const r = setup(t),
    old = r.hostCurrentDirectoryBuffer;
  assert.equal(await setProcessDirectory(r, 'a'), 0);
  assert.equal(r.cwd, 'a/');
  const p = descriptor(r),
    buffer = r.read32(p + 4);
  assert.equal(r.wideString(buffer), 'C:\\winebrowser\\a\\');
  assert.equal(r.guestMemory.read(p, 2), 'C:\\winebrowser\\a\\'.length * 2);
  assert.equal(r.guestMemory.read(p + 2, 2), 'C:\\winebrowser\\a\\'.length * 2 + 2);
  assert.equal(r.read32(p + 8), 0);
  assert.equal(r.allocations.has(old), false);
  assert.equal(await setProcessDirectory(r, ''), 0);
  assert.equal(r.cwd, '');
  assert.equal(r.wideString(r.read32(p + 4)), 'C:\\winebrowser\\');
});

test('native directory updates are visible to every host path consumer even with unchanged descriptor length', (t) => {
  const r = setup(t);
  native(r);
  writeDirectory(r, 'C:\\winebrowser\\a\\');
  assert.equal(r.cwd, 'a/');
  const buffer = r.allocate(64),
    name = r.allocString('asset.bin');
  const opened = r.apiProvider.get('kernel32.dll!CreateFileA')(
    r,
    (i) => [name, 0x80000000, 7, 0, 3, 0, 0][i],
  );
  assert.notEqual(opened.result >>> 0, 0xffffffff);
  assert.equal(r.handles.get(opened.result).path, 'a/asset.bin');
  const p = descriptor(r),
    path = r.read32(p + 4);
  const position = 'C:\\winebrowser\\'.length;
  r.guestMemory.write(path + position * 2, 'b'.charCodeAt(0), 2);
  assert.equal(r.cwd, 'b/');
  assert.equal(
    r.apiProvider.get('kernel32.dll!GetCurrentDirectoryW')(r, (i) => [32, buffer][i]).result,
    16,
  );
  assert.equal(r.wideString(buffer), 'C:\\winebrowser\\b');
});

test('host changes delegate counted Unicode to Wine and retain its status conversion and current-directory ownership', async (t) => {
  const r = setup(t);
  native(r);
  const calls = [];
  r.callGuest = async (address, args) => {
    calls.push({ address, args });
    assert.equal(address, 0x10000010);
    const p = args[0];
    assert.equal(r.wideString(r.read32(p + 4)), 'C:\\winebrowser\\b\\');
    assert.equal(r.guestMemory.read(p, 2), 'C:\\winebrowser\\b\\'.length * 2);
    writeDirectory(r, 'C:\\winebrowser\\b\\');
    r.write32(descriptor(r) + 8, 77);
    return 0;
  };
  assert.equal(await setProcessDirectory(r, 'b'), 0);
  assert.equal(r.cwd, 'b/');
  assert.equal(r.read32(descriptor(r) + 8), 77);
  assert.equal(calls.length, 1);
  assert.equal(r.allocations.has(calls[0].args[0]), false);
  r.callGuest = async (address, args) =>
    address === 0x10000010 ? 0xc0000043 : (assert.equal(args[0], 0xc0000043), 32);
  assert.equal(await setProcessDirectory(r, 'a'), 32);
  assert.equal(r.cwd, 'b/');
  assert.equal(r.read32(descriptor(r) + 8), 77);
});

test('invalid directories and native capacity failures leave directory state and handles untouched', async (t) => {
  const r = setup(t);
  native(r);
  let calls = 0;
  r.callGuest = async () => {
    calls++;
    return 0;
  };
  const p = descriptor(r);
  r.write32(p + 8, 77);
  assert.equal(await setProcessDirectory(r, 'missing'), 3);
  assert.equal(await setProcessDirectory(r, 'a/asset.bin'), 267);
  r.guestMemory.write(p + 2, 10, 2);
  assert.equal(await setProcessDirectory(r, 'b'), 206);
  assert.equal(calls, 0);
  assert.equal(r.read32(p + 8), 77);
  r.guestMemory.write(p + 2, 520, 2);
  assert.equal(r.cwd, 'app/');
  r.guestMemory.write(p, 3, 2);
  assert.throws(() => r.cwd, /Invalid process current directory/);
});

test('a published native directory handle identifies the new directory during the protected DOS-text copy', (t) => {
  const r = setup(t);
  native(r);
  const p = descriptor(r),
    buffer = r.read32(p + 4);
  r.handles.set(99, { kind: 'file-directory', path: 'b' });
  r.write32(p + 8, 99);
  r.guestMemory.write(buffer, 'X'.charCodeAt(0), 2);
  assert.equal(r.cwd, 'b/');
  r.handles.get(99).path = '';
  assert.equal(r.cwd, '');
});
