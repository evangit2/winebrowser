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

test('memory BT reads the addressed bit of a dword without modifying it', () => {
  const { cpu, view } = machine([0x0f, 0xa3, 0x08]); // bt dword ptr [eax], ecx
  const base = 0x2000;
  cpu.r[0].value = base;
  view.setUint32(base, 0b1_0000, true);
  cpu.r[1].value = 4;
  cpu.f = { cf: 0, zf: 1, sf: 1, of: 1, pf: 1 };

  cpu.step(CODE);

  assert.equal(cpu.f.cf, 1);
  assert.deepEqual(cpu.f, { cf: 1, zf: 1, sf: 1, of: 1, pf: 1 });
  assert.equal(view.getUint32(base, true), 0b1_0000, 'BT leaves memory unchanged');
});

test('a memory BT register index is a signed bit offset into the bit string', () => {
  const { cpu, view } = machine([0x0f, 0xa3, 0x08]); // bt dword ptr [eax], ecx
  const base = 0x2000;
  cpu.r[0].value = base;
  view.setUint32(base, 0, true);
  view.setUint32(base + 4, 1, true); // bit 0 of the following dword
  cpu.r[1].value = 32; // advances one dword, unlike the register form
  cpu.f = { cf: 0, zf: 0, sf: 0, of: 0, pf: 0 };

  cpu.step(CODE);

  assert.equal(cpu.f.cf, 1);
  assert.equal(view.getUint32(base, true), 0, 'the first dword is not the source');
});

test('memory BTS/BTR/BTC update the bit and report its previous value in CF', () => {
  const { cpu, view } = machine([
    0x0f,
    0xab,
    0x08, // bts dword ptr [eax], ecx
    0x0f,
    0xab,
    0x08, // bts again: the bit is already set
    0x0f,
    0xb3,
    0x08, // btr clears it, reporting one
    0x0f,
    0xbb,
    0x08, // btc toggles it back on, reporting zero
  ]);
  const base = 0x2000;
  cpu.r[0].value = base;
  view.setUint32(base, 0, true);
  cpu.r[1].value = 7;

  cpu.step(CODE);

  assert.equal(view.getUint32(base, true), 0b1000_0000, 'the bit ends set');
  assert.equal(cpu.f.cf, 0, 'BTC saw the bit clear before setting it');
});

test('a negative memory bit index reaches backwards across the bit string', () => {
  const { cpu, view } = machine([0x0f, 0xab, 0x08]); // bts dword ptr [eax], ecx
  const base = 0x2000;
  cpu.r[0].value = base + 4;
  cpu.r[1].value = -1; // bit 31 of the preceding dword
  view.setUint32(base, 0, true);
  view.setUint32(base + 4, 0, true);

  cpu.step(CODE);

  assert.equal(view.getUint32(base, true), 0x80000000);
  assert.equal(view.getUint32(base + 4, true), 0, 'the following dword is untouched');
  assert.equal(cpu.f.cf, 0);
});

test('16-bit memory BT masks the bit number to its own width and preserves neighbours', () => {
  const { cpu, view } = machine([0x66, 0x0f, 0xa3, 0x08]); // bt word ptr [eax], cx
  const base = 0x2000;
  cpu.r[0].value = base;
  view.setUint16(base, 0x8000, true);
  cpu.r[1].value = 15;
  cpu.f = { cf: 0, zf: 0, sf: 0, of: 0, pf: 0 };

  cpu.step(CODE);

  assert.equal(cpu.f.cf, 1);
  assert.equal(view.getUint16(base, true), 0x8000);
});

test('LOCK accepts a memory BTS/BTR/BTC but rejects a read-only BT', () => {
  const btc = machine([0xf0, 0x0f, 0xbb, 0x08]); // lock btc dword ptr [eax], ecx
  btc.cpu.r[0].value = 0x2000;
  btc.cpu.r[1].value = 0;
  btc.view.setUint32(0x2000, 0, true);
  btc.cpu.step(CODE);
  assert.equal(btc.view.getUint32(0x2000, true), 1);

  // LOCK on the read-only BT is architecturally invalid, so the decoder
  // rejects the whole block before it can execute.
  const bt = machine([0xf0, 0x0f, 0xa3, 0x08]); // lock bt dword ptr [eax], ecx
  bt.cpu.r[0].value = 0x2000;
  bt.cpu.r[1].value = 0;
  assert.throws(() => bt.cpu.step(CODE), /Invalid or truncated/);
});

test('memory BTS with an imm8 index writes only the addressed bit', () => {
  const { cpu, view } = machine([0x0f, 0xba, 0x28, 0x11]); // bts dword ptr [eax], 0x11
  const base = 0x2000;
  cpu.r[0].value = base;
  view.setUint32(base, 0, true);
  cpu.f = { cf: 1, zf: 0, sf: 0, of: 0, pf: 0 };

  cpu.step(CODE);

  assert.equal(view.getUint32(base, true), 0x20000, 'imm8 0x11 addresses bit 17');
  assert.equal(cpu.f.cf, 0, 'the previous bit value is reported');
});
