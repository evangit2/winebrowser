import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

const CODE = 0x1000;

function machine(code, { fsBase = 0 } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set(code, CODE);
  const view = new DataView(memory.buffer);
  const read = (address, width) =>
    width === 1
      ? view.getUint8(address)
      : width === 2
        ? view.getUint16(address, true)
        : view.getUint32(address, true);
  const write = (address, value, width) => {
    if (width === 1) view.setUint8(address, value);
    else if (width === 2) view.setUint16(address, value, true);
    else view.setUint32(address, value, true);
  };
  const cpu = new CPU(iced, {
    memory,
    read32: (address) => view.getUint32(address, true),
    write32: (address, value) => view.setUint32(address, value, true),
    read,
    write,
    fsBase,
    executableRanges: [[CODE, CODE + code.length]],
  });
  return { cpu, view };
}

test('REP MOVSB copies the requested bytes, advances indices, and preserves flags', () => {
  const { cpu, view } = machine([0xf3, 0xa4]); // rep movsb
  view.setUint8(0x2000, 0x10);
  view.setUint8(0x2001, 0x20);
  view.setUint8(0x2002, 0x30);
  cpu.r[6].value = 0x2000;
  cpu.r[7].value = 0x3000;
  cpu.r[1].value = 3;
  cpu.f = { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 };

  assert.equal(cpu.step(CODE), CODE + 2);
  assert.deepEqual([...new Uint8Array(cpu.memory.buffer, 0x3000, 3)], [0x10, 0x20, 0x30]);
  assert.deepEqual(
    [cpu.r[6].value >>> 0, cpu.r[7].value >>> 0, cpu.r[1].value >>> 0],
    [0x2003, 0x3003, 0],
  );
  assert.deepEqual(cpu.f, { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 });
  assert.equal(cpu.df, 0);
  assert.equal(cpu.instructions, 3, 'instruction accounting includes each completed REP iteration');
});

test('zero-count REP touches no memory and wide MOVS transfers words', () => {
  const { cpu, view } = machine([0xf3, 0xa5]); // rep movsd
  cpu.r[6].value = 0xfffffff0;
  cpu.r[7].value = 0xfffffff0;
  cpu.r[1].value = 0;
  assert.equal(cpu.step(CODE), CODE + 2);
  assert.deepEqual(
    [cpu.r[6].value >>> 0, cpu.r[7].value >>> 0, cpu.r[1].value >>> 0],
    [0xfffffff0, 0xfffffff0, 0],
  );
  assert.equal(cpu.instructions, 1, 'zero-count REP still executes one instruction');

  const word = machine([0xf3, 0x66, 0xa5]); // rep movsw
  word.view.setUint16(0x2200, 0xabcd, true);
  word.cpu.r[6].value = 0x2200;
  word.cpu.r[7].value = 0x3200;
  word.cpu.r[1].value = 1;
  assert.equal(word.cpu.step(CODE), CODE + 3);
  assert.equal(word.view.getUint16(0x3200, true), 0xabcd);
});

test('REP STOS uses accumulator width; STD walks backward and CLD restores forward direction', () => {
  const { cpu, view } = machine([0xfd, 0xf3, 0xaa, 0xfc]); // std; rep stosb; cld
  cpu.r[0].value = 0x123456a7;
  cpu.r[7].value = 0x4002;
  cpu.r[1].value = 3;
  cpu.f = { cf: 1, zf: 0, sf: 1, of: 0, pf: 1 };

  assert.equal(cpu.step(CODE), CODE + 3, 'STD and the following REP STOS stay in one basic block');
  assert.equal(cpu.df, 1);
  assert.deepEqual([...new Uint8Array(cpu.memory.buffer, 0x4000, 3)], [0xa7, 0xa7, 0xa7]);
  assert.deepEqual([cpu.r[7].value >>> 0, cpu.r[1].value >>> 0], [0x3fff, 0]);
  assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 0, pf: 1 });
  assert.equal(cpu.step(CODE + 3), CODE + 4);
  assert.equal(cpu.df, 0);
});

test('REP chunks at 1024 iterations and resumes at the string instruction', () => {
  const { cpu, view } = machine([0xf3, 0xa4]);
  cpu.r[6].value = 0x5000;
  cpu.r[7].value = 0x6000;
  cpu.r[1].value = 2050;
  for (let i = 0; i < 2050; i++) view.setUint8(0x5000 + i, i & 0xff);

  assert.equal(cpu.step(CODE), CODE);
  assert.deepEqual(
    [cpu.r[6].value >>> 0, cpu.r[7].value >>> 0, cpu.r[1].value >>> 0],
    [0x5400, 0x6400, 1026],
  );
  assert.equal(cpu.instructions, 1024);
  assert.equal(cpu.step(CODE), CODE);
  assert.equal(cpu.step(CODE), CODE + 2);
  assert.deepEqual(
    [cpu.r[6].value >>> 0, cpu.r[7].value >>> 0, cpu.r[1].value >>> 0],
    [0x5802, 0x6802, 0],
  );
  assert.equal(cpu.instructions, 2050);
  assert.deepEqual(
    [...new Uint8Array(cpu.memory.buffer, 0x6000, 2050)],
    [...new Uint8Array(cpu.memory.buffer, 0x5000, 2050)],
  );
});

test('a faulting iteration leaves completed REP progress intact', () => {
  const { cpu, view } = machine([0xf3, 0xa4]);
  view.setUint8(0x7000, 0x51);
  view.setUint8(0x7001, 0x52);
  cpu.r[6].value = 0x7000;
  cpu.r[7].value = 0xfffe;
  cpu.r[1].value = 3;

  assert.throws(() => cpu.step(CODE), /range violation/);
  assert.deepEqual(
    [cpu.r[6].value >>> 0, cpu.r[7].value >>> 0, cpu.r[1].value >>> 0],
    [0x7002, 0x10000, 1],
  );
  assert.deepEqual([...new Uint8Array(cpu.memory.buffer, 0xfffe, 2)], [0x51, 0x52]);
});

test('FS source override reads from the configured TEB segment base', () => {
  const fsBase = 0x8000;
  const { cpu, view } = machine([0x64, 0xa4], { fsBase }); // movsb fs:[esi] -> es:[edi]
  view.setUint8(fsBase + 0x24, 0x9c);
  cpu.r[6].value = 0x24;
  cpu.r[7].value = 0x9000;

  assert.equal(cpu.step(CODE), CODE + 2);
  assert.equal(view.getUint8(0x9000), 0x9c);
  assert.deepEqual([cpu.r[6].value >>> 0, cpu.r[7].value >>> 0], [0x25, 0x9001]);
});

test('REP rejects address-size overrides and unsupported repeat prefixes', () => {
  const address16 = machine([0x67, 0xf3, 0xa4]);
  address16.cpu.r[1].value = 1;
  assert.throws(() => address16.cpu.step(CODE), /16-bit string address mode unsupported/);

  const repe = machine([0xf2, 0xa4]);
  assert.throws(() => repe.cpu.step(CODE), /REPNE string operations are unsupported/);
});

for (const [name, width, code] of [
  ['word', 2, [0xf3, 0x66, 0xab]],
  ['dword', 4, [0xf3, 0xab]],
]) {
  test(`REP STOS ${name} writes the full accumulator field`, () => {
    const { cpu, view } = machine(code);
    cpu.r[0].value = 0x1234abcd;
    cpu.r[7].value = 0x2000;
    cpu.r[1].value = 2;
    assert.equal(cpu.step(CODE), CODE + code.length);
    for (let i = 0; i < 2; i++)
      assert.equal(
        width === 2
          ? view.getUint16(0x2000 + i * width, true)
          : view.getUint32(0x2000 + i * width, true),
        width === 2 ? 0xabcd : 0x1234abcd,
      );
    assert.equal(cpu.r[7].value, 0x2000 + 2 * width);
  });
}

test('overlapping MOVS follows direction rather than memmove snapshot semantics', () => {
  const forward = machine([0xf3, 0xa4]);
  new Uint8Array(forward.cpu.memory.buffer).set([1, 2, 3, 4], 0x2000);
  forward.cpu.r[6].value = 0x2000;
  forward.cpu.r[7].value = 0x2001;
  forward.cpu.r[1].value = 3;
  forward.cpu.step(CODE);
  assert.deepEqual([...new Uint8Array(forward.cpu.memory.buffer, 0x2000, 4)], [1, 1, 1, 1]);
  const backward = machine([0xfd, 0xf3, 0xa4]);
  new Uint8Array(backward.cpu.memory.buffer).set([1, 2, 3, 4], 0x2000);
  backward.cpu.r[6].value = 0x2002;
  backward.cpu.r[7].value = 0x2003;
  backward.cpu.r[1].value = 3;
  backward.cpu.step(CODE);
  assert.deepEqual([...new Uint8Array(backward.cpu.memory.buffer, 0x2000, 4)], [1, 1, 2, 3]);
});
