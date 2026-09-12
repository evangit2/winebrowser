import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

const CODE = 0x1000;

function machine(code) {
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
    executableRanges: [[CODE, CODE + code.length]],
  });
  return { cpu, view };
}

test('BT masks a register index to the operand width and changes only CF', () => {
  const { cpu } = machine([0x0f, 0xa3, 0xc8]); // bt eax, ecx
  cpu.r[0].value = 1;
  cpu.r[1].value = 32;
  cpu.f = { cf: 0, zf: 1, sf: 1, of: 1, pf: 1 };

  cpu.step(CODE);

  assert.equal(cpu.r[0].value >>> 0, 1);
  assert.equal(cpu.f.cf, 1);
  assert.deepEqual(cpu.f, { cf: 1, zf: 1, sf: 1, of: 1, pf: 1 });
});

test('16-bit BT with imm8 masks the bit number and preserves the register high half', () => {
  const { cpu } = machine([0x66, 0x0f, 0xba, 0xe0, 0x1f]); // bt ax, 1fh => bit 15
  cpu.r[0].value = 0x12348000;
  cpu.f = { cf: 0, zf: 0, sf: 1, of: 0, pf: 1 };

  cpu.step(CODE);

  assert.equal(cpu.r[0].value >>> 0, 0x12348000);
  assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 0, pf: 1 });
});

test('BTS, BTR, and BTC update a register bit while reporting its previous value in CF', () => {
  const { cpu } = machine([
    0x0f,
    0xab,
    0xc8, // bts eax, ecx
    0x0f,
    0xb3,
    0xc8, // btr eax, ecx
    0x0f,
    0xbb,
    0xc8, // btc eax, ecx
  ]);
  cpu.r[0].value = 0;
  cpu.r[1].value = 33; // register-form index is masked to bit 1

  cpu.step(CODE);

  assert.equal(cpu.r[0].value >>> 0, 2);
  assert.equal(cpu.f.cf, 0); // BTS saw zero, BTR saw one, and BTC saw zero.
});

test('16-bit BTS preserves upper register bits and masks its register index', () => {
  const { cpu } = machine([0x66, 0x0f, 0xab, 0xc8]); // bts ax, cx
  cpu.r[0].value = 0x12340000;
  cpu.r[1].value = 17; // bit 1

  cpu.step(CODE);

  assert.equal(cpu.r[0].value >>> 0, 0x12340002);
  assert.equal(cpu.f.cf, 0);
});

test('memory bit-string forms stay explicitly unsupported', () => {
  const { cpu } = machine([0x0f, 0xa3, 0x08]); // bt dword ptr [eax], ecx
  assert.throws(() => cpu.step(CODE), /Memory bitstring operations unsupported/);
});
