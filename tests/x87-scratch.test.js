import test from 'node:test';
import assert from 'node:assert/strict';
import { X87State, X87Op } from '../src/x87.js';

async function state() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const x87 = new X87State({
    memory,
    check: (a, n) => {
      assert.ok(a + n <= memory.buffer.byteLength);
      return a;
    },
  });
  await x87.initialize();
  return { x87, view: new DataView(memory.buffer) };
}

function roundedInteger(x87, view, value, control, truncate = false) {
  x87.reset();
  x87.control = control;
  x87.pushDouble(value);
  x87.execute(X87Op.storeInt, 0, 0, 0x100, 4, truncate ? 65 : 1);
  return view.getInt32(0x100, true);
}

test('cached SoftFloat modes remain independent across instances, truncation and reset', async () => {
  const a = await state(),
    b = await state();
  try {
    assert.equal(a.x87.sf, b.x87.sf);
    for (let repeat = 0; repeat < 3; repeat++) {
      assert.equal(roundedInteger(a.x87, a.view, 1.75, 0x077f), 1); // round down
      assert.equal(roundedInteger(b.x87, b.view, 1.25, 0x0b7f), 2); // round up
      assert.equal(roundedInteger(a.x87, a.view, -1.25, 0x077f), -2);
      assert.equal(roundedInteger(b.x87, b.view, -1.75, 0x0b7f), -1);
      assert.equal(roundedInteger(b.x87, b.view, 1.75, 0x0b7f, true), 1);
      assert.equal(roundedInteger(b.x87, b.view, 1.25, 0x0b7f), 2);
    }
    a.x87.reset();
    a.x87.pushDouble(2.5);
    a.x87.execute(X87Op.storeInt, 0, 0, 0x100, 4, 1);
    assert.equal(a.view.getInt32(0x100, true), 2); // default ties to even
  } finally {
    a.x87.dispose();
    b.x87.dispose();
  }
});

test('SoftFloat scratch views refresh after shared heap growth and reinitialization', async () => {
  const { x87 } = await state();
  try {
    x87.pushDouble(1.25);
    assert.equal(x87.doubleOperand(0), 1.25);
    const original = x87.sf.HEAPU8;
    const allocation = x87.sf._malloc(original.byteLength + 65536);
    assert.ok(allocation);
    try {
      assert.notEqual(x87.sf.HEAPU8, original);
      x87.pushDouble(-7.5);
      assert.equal(x87.popDouble(), -7.5);
      assert.equal(x87.popDouble(), 1.25);
    } finally {
      x87.sf._free(allocation);
    }
    x87.dispose();
    await x87.initialize();
    x87.reset();
    x87.pushDouble(0.125);
    assert.equal(x87.popDouble(), 0.125);
  } finally {
    x87.dispose();
  }
});
