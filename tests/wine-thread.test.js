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
const teb = PROCESS_LAYOUT.teb;
const CURRENT_THREAD = 0xfffffffe;

function runtime() {
  return new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
}
function clear(
  r,
  indexPointer,
  { handle = CURRENT_THREAD, informationClass = 10, length = 4 } = {},
) {
  const args = [handle, informationClass, indexPointer, length];
  return ntServices.NtSetInformationThread.call(r, (i) => args[i]);
}

test('ThreadZeroTlsCell clears only the selected inline PE32 TEB slot', () => {
  const r = runtime();
  const input = r.allocate(4);
  for (const index of [0, 37, 63]) {
    const cell = teb + 0xe10 + index * 4;
    r.write32(cell, 0x12345678);
    r.write32(input, index);
    assert.equal(clear(r, input), 0);
    assert.equal(r.read32(cell), 0);
  }
  r.write32(teb + 0xe10 + 36 * 4, 0xabcdef01);
  r.write32(input, 37);
  assert.equal(clear(r, input), 0);
  assert.equal(r.read32(teb + 0xe10 + 36 * 4), 0xabcdef01);
});

test('ThreadZeroTlsCell clears allocated expansion slots without allocating missing storage', () => {
  const r = runtime();
  const input = r.allocate(4);
  const expansionPointer = teb + 0xf94;
  r.write32(expansionPointer, 0);
  r.write32(input, 64);
  assert.equal(clear(r, input), 0);
  assert.equal(r.read32(expansionPointer), 0);

  const expansion = r.allocate(1024 * 4);
  r.write32(expansionPointer, expansion);
  for (const index of [64, 79, 1087]) {
    const cell = expansion + (index - 64) * 4;
    r.write32(cell, 0x12345678);
    r.write32(input, index);
    assert.equal(clear(r, input), 0);
    assert.equal(r.read32(cell), 0);
  }
  r.write32(expansion + 4, 0xabcdef01);
  r.write32(input, 64);
  assert.equal(clear(r, input), 0);
  assert.equal(r.read32(expansion + 4), 0xabcdef01);
});

test('ThreadZeroTlsCell validates handle, length, index, and guest pointers', () => {
  const r = runtime();
  const input = r.allocate(4);
  r.write32(input, 1088);
  assert.equal(clear(r, input), 0xc000000d);
  assert.equal(clear(r, input, { length: 0 }), 0xc000000d);
  assert.equal(clear(r, input, { handle: 0xffffffff }), 0xc0000008);
  assert.equal(clear(r, input, { handle: 0x1234 }), 0xc0000008);
  assert.equal(clear(r, 0), 0xc0000005);
  assert.equal(clear(r, 0x4000000), 0xc0000005);
  assert.throws(
    () => clear(r, input, { informationClass: 11 }),
    /Unsupported Wine thread information class 11/,
  );
  r.write32(input, 64);
  r.write32(teb + 0xf94, 0x4000000);
  assert.equal(clear(r, input), 0xc0000005);
  r.write32(input, 1087);
  r.write32(teb + 0xf94, 0xfffffff0);
  assert.equal(clear(r, input), 0xc0000005);
});
