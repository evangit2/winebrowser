import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
import { PROCESS_USER_SID } from '../src/process-identity.js';

const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
function runtime() {
  return new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
}
function query(r, handle, output, size, length = 0, informationClass = 1) {
  const args = [handle, informationClass, output, size, length];
  return ntServices.NtQueryInformationToken.call(r, (i) => args[i]);
}

test('process and effective TokenUser queries return a self-contained PE32 SID', () => {
  const r = runtime();
  const output = r.allocate(64);
  const length = r.allocate(4);
  r.data.fill(0xaa, output, output + 64);
  assert.equal(query(r, 0xfffffffc, output, 35, length), 0xc0000023);
  assert.equal(r.read32(length), 36);
  assert.ok(r.data.slice(output, output + 64).every((byte) => byte === 0xaa));
  for (const handle of [0xfffffffc, 0xfffffffa]) {
    assert.equal(query(r, handle, output, 64, length), 0);
    assert.equal(r.read32(output), output + 8);
    assert.equal(r.read32(output + 4), 0);
    const sid = r.read32(output);
    const values = Array.from({ length: r.data[sid + 1] }, (_, i) => r.read32(sid + 8 + i * 4));
    assert.equal(`S-${r.data[sid]}-${r.data[sid + 7]}-${values.join('-')}`, PROCESS_USER_SID);
    assert.deepEqual([...r.data.slice(sid + 2, sid + 7)], [0, 0, 0, 0, 0]);
    assert.ok(r.data.slice(output + 36, output + 64).every((byte) => byte === 0xaa));
  }
});

test('token queries enforce output bounds and do not invent impersonation or other token classes', () => {
  const r = runtime();
  const output = r.allocate(64);
  const length = r.allocate(4);
  assert.equal(query(r, 0xfffffffc, 0, 0, length), 0xc0000023);
  assert.equal(query(r, 0xfffffffc, 0, 36, length), 0xc0000005);
  assert.equal(query(r, 0xfffffffc, output, 36, 0x4000000), 0xc0000005);
  assert.equal(query(r, 0xfffffffc, output, 36), 0);
  assert.equal(query(r, 0xfffffffb, output, 64), 0xc000007c);
  assert.equal(query(r, 0x1234, output, 64), 0xc0000008);
  assert.throws(
    () => query(r, 0xfffffffc, output, 64, 0, 2),
    /Unsupported Wine token information class 2/,
  );
});
