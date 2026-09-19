import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

const CODE = 0x1000;

function machine(code) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set(code, CODE);
  const view = new DataView(memory.buffer);
  return new CPU(iced, {
    memory,
    read32: (address) => view.getUint32(address, true),
    write32: (address, value) => view.setUint32(address, value, true),
    executableRanges: [[CODE, CODE + code.length]],
  });
}

test('SAHF loads SF/ZF/AF/PF/CF from AH while preserving OF and EAX', () => {
  const cpu = machine([0x9e]);
  cpu.r[0].value = 0x1234d5aa;
  cpu.f = { cf: 0, zf: 0, sf: 0, of: 1, pf: 0 };
  cpu.af = 0;

  cpu.step(CODE);

  assert.equal(cpu.r[0].value >>> 0, 0x1234d5aa);
  assert.deepEqual(cpu.f, { cf: 1, zf: 1, sf: 1, of: 1, pf: 1 });
  assert.equal(cpu.af, 1);
});

test('LAHF writes the architectural flags byte to AH and changes no flags', () => {
  const cpu = machine([0x9f]);
  cpu.r[0].value = 0xaabbccdd;
  cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
  cpu.af = 1;

  cpu.step(CODE);

  assert.equal(cpu.r[0].value >>> 0, 0xaabb93dd);
  assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
  assert.equal(cpu.af, 1);
});

test('SAHF then LAHF round-trips defined status bits and forces reserved bit 1', () => {
  const cpu = machine([0x9e, 0x9f]);
  cpu.r[0].value = 0xface5501;
  cpu.f.of = 1;

  cpu.step(CODE);

  assert.equal((cpu.r[0].value >>> 8) & 0xff, 0x57);
  assert.equal(cpu.f.of, 1);
  assert.deepEqual(
    { sf: cpu.f.sf, zf: cpu.f.zf, af: cpu.af, pf: cpu.f.pf, cf: cpu.f.cf },
    { sf: 0, zf: 1, af: 1, pf: 1, cf: 1 },
  );
});

test('arithmetic tracks AF from low-nibble carry and borrow for LAHF', () => {
  const add = machine([0xb0, 0x0f, 0x04, 0x01, 0x9f]); // mov al,0fh; add al,1; lahf
  add.step(CODE);
  assert.equal(add.r[0].value & 0xffff, 0x1210);
  assert.equal(add.af, 1);

  const sub = machine([0xb0, 0x10, 0x2c, 0x01, 0x9f]); // mov al,10h; sub al,1; lahf
  sub.step(CODE);
  assert.equal(sub.r[0].value & 0xffff, 0x160f);
  assert.equal(sub.af, 1);

  const noCarry = machine([0xb0, 0x11, 0x04, 0x01, 0x9f]);
  noCarry.step(CODE);
  assert.equal((noCarry.r[0].value >>> 8) & 0x10, 0);
  assert.equal(noCarry.af, 0);
});
