import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const oracle = JSON.parse(
  await readFile('tests/fixtures/standard-output/wine-oracle.json', 'utf8'),
);
const deviceOracle = JSON.parse(
  await readFile('tests/fixtures/standard-output/wine-device-oracle.json', 'utf8'),
);
function setup(t) {
  const output = [];
  const r = new Runtime(iced, {
    files: new Map([['console.exe', exe]]),
    exe: 'console.exe',
    emit: (m) => {
      if (m.type === 'stdout') output.push(m.text);
    },
  });
  t.after(() => {
    r.syncObjects?.dispose();
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) => r.apiProvider.get('kernel32.dll!' + name)(r, (i) => args[i] >>> 0);
  const nt = (name, ...args) => ntServices[name].call(r, (i) => args[i] >>> 0);
  const out = r.allocate(8),
    buffer = r.allocString('ABX'),
    count = r.allocate(4);
  const duplicate = (source, options = 2, attrs = 0, pointer = out) =>
    nt('NtDuplicateObject', 0xffffffff, source, 0xffffffff, pointer, 0, attrs, options);
  const write = (handle, offset = 0) => {
    r.write32(count, 99);
    return api('WriteFile', handle, buffer + offset, 1, count, 0).result;
  };
  return { r, output, api, nt, out, buffer, count, duplicate, write };
}
test('native output alias reference: cascading duplicates preserve flags, independent closes and reduced rights', (t) => {
  const { r, output, api, out, count, duplicate, write } = setup(t);
  const observed = {};
  observed.duplicateStatus = duplicate(1, 2, 2);
  const first = r.read32(out);
  observed.info = api('GetHandleInformation', first, out + 4).result;
  observed.inherit = r.read32(out + 4);
  observed.writeFirst = write(first);
  observed.countFirst = r.read32(count);
  observed.cascadeStatus = duplicate(first, 6);
  const second = r.read32(out);
  api('GetHandleInformation', second, out + 4);
  observed.cascadeFlags = r.read32(out + 4);
  observed.limitedStatus = duplicate(1, 0);
  const limited = r.read32(out);
  observed.limitedWrite = write(limited, 2);
  observed.limitedError = r.lastError;
  observed.limitedCount = r.read32(count);
  api('CloseHandle', limited);
  api('CloseHandle', 1);
  api('CloseHandle', first);
  observed.writeAfterOriginalClose = write(second, 1);
  observed.countAfterOriginalClose = r.read32(count);
  api('CloseHandle', second);
  observed.closedWrite = write(second, 2);
  observed.closedError = r.lastError;
  observed.closedCount = r.read32(count);
  assert.deepEqual(observed, oracle);
  assert.equal(output.join(''), 'AB');
  assert.equal(duplicate(1), 0xc0000008);
});
test('native NT byte writes and console-mode probes use surviving stdout/stderr aliases', (t) => {
  const { r, output, api, nt, out, buffer, duplicate } = setup(t);
  for (const original of [1, 2]) {
    assert.equal(duplicate(original), 0);
    const handle = r.read32(out),
      io = r.allocate(16);
    r.write32(io, 0x12345678);
    r.write32(io + 4, 0x12345678);
    r.write32(io + 8, 0x12345678);
    const status = nt('NtDeviceIoControlFile', handle, 0, 0, 0, io, 0x504000, 0, 0, io + 8, 4);
    assert.deepEqual(
      { status, iosb: r.read32(io), information: r.read32(io + 4), mode: r.read32(io + 8) },
      deviceOracle,
    );
    assert.equal(nt('NtQueryVolumeInformationFile', handle, io, io + 8, 8, 4), 0);
    assert.equal(r.read32(io + 8), 0x11);
    assert.equal(api('CloseHandle', original).result, 1);
    assert.equal(nt('NtWriteFile', handle, 0, 0, 0, io, buffer, 2, 0, 0), 0);
    assert.equal(r.read32(io + 4), 2);
    assert.equal(nt('NtFsControlFile', handle, 0, 0, 0, io, 0x11400c, 0, 0, 0, 0), 0xc0000022);
    assert.equal(api('CloseHandle', handle).result, 1);
    assert.equal(
      nt('NtDeviceIoControlFile', handle, 0, 0, 0, io, 0x504000, 0, 0, 0, 0),
      0xc0000008,
    );
    assert.equal(nt('NtWriteFile', handle, 0, 0, 0, io, buffer, 1, 0, 0), 0xc0000008);
  }
  assert.equal(output.join(''), 'ABAB');
});
test('close-source failures and close-only work for output aliases without revoking sibling rights', (t) => {
  const { r, api, out, duplicate, write } = setup(t);
  assert.equal(duplicate(1), 0);
  const sibling = r.read32(out);
  assert.equal(duplicate(1, 1, 0, r.data.length - 2), 0xc0000005);
  assert.equal(duplicate(1), 0xc0000008);
  assert.equal(write(sibling), 1);
  assert.equal(api('SetHandleInformation', sibling, 1, 1).result, 1);
  assert.equal(duplicate(sibling, 6), 0);
  const second = r.read32(out);
  assert.equal(r.handles.get(second).inherit, true);
  assert.equal(
    ntServices.NtDuplicateObject.call(r, (i) => [0xffffffff, sibling, 0, 0, 0, 0, 1][i]),
    0,
  );
  assert.equal(write(sibling), 0);
  assert.equal(write(second), 1);
});
