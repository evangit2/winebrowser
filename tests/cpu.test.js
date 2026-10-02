import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
function cpu(code) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set(code, 0x1000);
  const v = new DataView(memory.buffer);
  return new CPU(iced, {
    memory,
    read32: (a) => v.getUint32(a, true),
    write32: (a, n) => v.setUint32(a, n, true),
    executableRanges: [[0x1000, 0x1000 + code.length]],
    stackTop: 0xf000,
  });
}
test('x86 arithmetic executes through generated Wasm and preserves branch flags', () => {
  const c = cpu([0xb8, 0xff, 0xff, 0xff, 0x7f, 0x83, 0xc0, 1, 0x70, 2, 0x90, 0x90, 0x90]);
  assert.equal(c.step(0x1000), 0x100c);
  assert.equal(c.r[0].value, -2147483648);
  assert.equal(c.f.of, 1);
  assert.ok(c.compiledBytes > 0);
});
test('call and ret preserve guest stack and return address', () => {
  const c = cpu([0xe8, 1, 0, 0, 0, 0x90, 0xb8, 42, 0, 0, 0, 0xc3]);
  const start = c.r[4].value;
  assert.equal(c.step(0x1000), 0x1006);
  assert.equal(c.step(0x1006), 0x1005);
  assert.equal(c.r[0].value, 42);
  assert.equal(c.r[4].value, start);
});
test('unsupported instruction fails before execution', () => {
  const c = cpu([0x0f, 0x0b]); // UD2; CPUID is now part of the supported profile.
  assert.throws(() => c.step(0x1000), /Unsupported instruction/);
});
test('INC preserves carry and changes zero flag', () => {
  const c = cpu([0xb8, 0xff, 0xff, 0xff, 0xff, 0x40, 0xeb, 0]);
  c.f.cf = 1;
  c.step(0x1000);
  assert.equal(c.f.cf, 1);
  assert.equal(c.f.zf, 1);
});
test('parity reflects low byte even parity', () => {
  const c = cpu([0x90]);
  for (let n = 0; n < 256; n++) {
    c.flags(0, n, n, 2);
    assert.equal(c.f.pf, Number([...n.toString(2)].filter((x) => x === '1').length % 2 === 0));
  }
});

test('CBW sign extends every AL value into AX without changing upper EAX, other registers or flags', () => {
  const c = cpu([0x66, 0x98]);
  try {
    for (let byte = 0; byte < 256; byte++) {
      c.r[0].value = 0x12340000 | byte;
      c.r[2].value = 0x76543210;
      c.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
      c.af = 1;
      assert.equal(c.step(0x1000), 0x1002);
      assert.equal(c.r[0].value >>> 0, 0x12340000 | (byte < 128 ? byte : 0xff00 | byte));
      assert.equal(c.r[2].value, 0x76543210);
      assert.deepEqual(c.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
      assert.equal(c.af, 1);
    }
  } finally {
    c.dispose();
  }
});
test('CWD sign extends AX into DX without changing upper EDX or EAX', () => {
  const c = cpu([0x66, 0x99]);
  try {
    for (const ax of [0, 1, 0x7fff, 0x8000, 0xffff]) {
      c.r[0].value = 0x98760000 | ax;
      c.r[2].value = 0x12345678;
      const flags = { ...c.f };
      c.step(0x1000);
      assert.equal(c.r[2].value >>> 0, 0x12340000 | (ax & 0x8000 ? 0xffff : 0));
      assert.equal(c.r[0].value >>> 0, (0x98760000 | ax) >>> 0);
      assert.deepEqual(c.f, flags);
    }
  } finally {
    c.dispose();
  }
});
