import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
import { PROCESS_LAYOUT } from '../src/process-layout.js';

const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
const runtime = () =>
  new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
const query = (r, informationClass, output, capacity, returnLength = 0) => {
  const args = [informationClass, output, capacity, returnLength];
  return ntServices.NtQuerySystemInformation.call(r, (i) => args[i]);
};
const name = (view, address, count) => {
  let result = '';
  for (let i = 0; i < count; i++) {
    const code = view.getUint16(address + i * 2, true);
    if (!code) break;
    result += String.fromCharCode(code);
  }
  return result;
};

test('class 0 describes the PE32 guest address space and one guest processor', () => {
  const r = runtime();
  const output = r.allocate(48);
  const length = r.allocate(4);
  r.data.fill(0xaa, output, output + 48);

  assert.equal(query(r, 0, output, 44, length), 0);
  assert.equal(r.read32(length), 44);
  assert.equal(r.read32(output), 0); // Unknown.
  assert.equal(r.read32(output + 4), 0); // No NT timer increment control.
  assert.equal(r.read32(output + 8), 4096); // PageSize.
  const pages = r.memory.buffer.byteLength / 4096;
  assert.equal(r.read32(output + 12), pages); // MmNumberOfPhysicalPages.
  assert.equal(r.read32(output + 16), 0); // MmLowestPhysicalPage.
  assert.equal(r.read32(output + 20), pages - 1); // MmHighestPhysicalPage.
  assert.equal(r.read32(output + 24), 65536); // AllocationGranularity.
  assert.equal(r.read32(output + 28), 65536); // LowestUserAddress.
  assert.equal(r.read32(output + 32), r.memory.buffer.byteLength - 1); // HighestUserAddress.
  assert.equal(r.read32(output + 36), 1); // ActiveProcessorsAffinityMask.
  assert.equal(r.data[output + 40], r.read32(PROCESS_LAYOUT.peb + 0x64));
  assert.deepEqual([...r.data.slice(output + 41, output + 44)], [0, 0, 0]);
  assert.ok(r.data.slice(output + 44, output + 48).every((byte) => byte === 0xaa));
});

test('class 0 requires the exact structure length and leaves invalid outputs untouched', () => {
  const r = runtime();
  const output = r.allocate(48);
  const length = r.allocate(4);
  r.data.fill(0xaa, output, output + 48);
  for (const capacity of [0, 43, 45]) {
    assert.equal(query(r, 0, output, capacity, length), 0xc0000004);
    assert.equal(r.read32(length), 44);
    assert.ok(r.data.slice(output, output + 48).every((byte) => byte === 0xaa));
  }
  assert.equal(query(r, 0, 0, 44, length), 0xc0000005);
  assert.equal(r.read32(length), 44);
  assert.equal(query(r, 0, output, 44, 0x40000000), 0xc0000005);
  assert.ok(r.data.slice(output, output + 48).every((byte) => byte === 0xaa));
});

test('class 102 returns a complete, stable UTC dynamic timezone with no DST', () => {
  const r = runtime();
  const output = r.allocate(440);
  const length = r.allocate(4);
  r.data.fill(0xaa, output, output + 440);

  assert.equal(query(r, 102, output, 432, length), 0);
  assert.equal(r.read32(length), 432);
  assert.equal(r.read32(output), 0); // Bias in minutes.
  assert.equal(name(r.view, output + 4, 32), 'UTC');
  assert.equal(name(r.view, output + 88, 32), 'UTC');
  assert.equal(name(r.view, output + 172, 128), 'UTC');
  assert.equal(r.read32(output + 84), 0); // StandardBias.
  assert.equal(r.read32(output + 168), 0); // DaylightBias.
  assert.equal(r.data[output + 428], 1); // DynamicDaylightTimeDisabled.
  for (const [start, end] of [
    [68, 84],
    [152, 168],
    [429, 432],
  ])
    assert.ok(r.data.slice(output + start, output + end).every((byte) => byte === 0));
  assert.ok(r.data.slice(output + 432, output + 440).every((byte) => byte === 0xaa));
});

test('class 44 returns the basic timezone prefix used by RtlQueryTimeZoneInformation', () => {
  const r = runtime();
  const output = r.allocate(180);
  const length = r.allocate(4);
  r.data.fill(0xaa, output, output + 180);

  assert.equal(query(r, 44, output, 172, length), 0);
  assert.equal(r.read32(length), 172);
  assert.equal(name(r.view, output + 4, 32), 'UTC');
  assert.equal(name(r.view, output + 88, 32), 'UTC');
  assert.ok(r.data.slice(output + 172, output + 180).every((byte) => byte === 0xaa));
});

test('timezone queries report exact sizes without writing short or invalid outputs', () => {
  const r = runtime();
  const output = r.allocate(432);
  const length = r.allocate(4);
  for (const [informationClass, size] of [
    [44, 172],
    [102, 432],
  ]) {
    r.data.fill(0xaa, output, output + 432);
    assert.equal(query(r, informationClass, output, size - 1, length), 0xc0000004);
    assert.equal(r.read32(length), size);
    assert.ok(r.data.slice(output, output + 432).every((byte) => byte === 0xaa));
    assert.equal(query(r, informationClass, 0, 0, length), 0xc0000004);
    assert.equal(r.read32(length), size);
    assert.equal(query(r, informationClass, 0, size, length), 0xc0000005);
    assert.equal(r.read32(length), size);
    assert.ok(r.data.slice(output, output + 432).every((byte) => byte === 0xaa));
  }
  assert.equal(query(r, 102, output, 432, 0x40000000), 0xc0000005);
  assert.ok(r.data.slice(output, output + 432).every((byte) => byte === 0xaa));
});

test('other system information classes remain explicitly unsupported', () => {
  const r = runtime();
  assert.throws(() => query(r, 93, 0, 0), /Unsupported Wine system information class 93/);
});

test('Wine Unix host metadata is explicitly unavailable without touching the output', () => {
  const r = runtime();
  const output = r.allocate(256);
  const length = r.allocate(4);
  r.data.fill(0xaa, output, output + 256);
  r.write32(length, 999);
  assert.equal(query(r, 1000, output, 256, length), 0xc0000003);
  assert.equal(r.read32(length), 0);
  assert.ok(r.data.slice(output, output + 256).every((byte) => byte === 0xaa));
  assert.equal(query(r, 1000, 0, 0), 0xc0000003);
  assert.equal(query(r, 1000, output, 256, 0x40000000), 0xc0000005);
});
