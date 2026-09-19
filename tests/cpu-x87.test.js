import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';

const CODE = 0x1000,
  DATA = 0x2000;
const moduleUrl = pathToFileURL(
  new URL('../public/runtime/softfloat/softfloat.js', import.meta.url).pathname,
).href;
const wasmUrl = pathToFileURL(
  new URL('../public/runtime/softfloat/softfloat.wasm', import.meta.url).pathname,
).href;

async function machine(code, check) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  new Uint8Array(memory.buffer).set(code, CODE);
  const view = new DataView(memory.buffer);
  const cpu = new CPU(iced, {
    memory,
    read32: (a) => view.getUint32(a, true),
    write32: (a, v) => view.setUint32(a, v, true),
    read: (a, w) =>
      w === 1 ? view.getUint8(a) : w === 2 ? view.getUint16(a, true) : view.getUint32(a, true),
    write: (a, v, w) =>
      w === 1
        ? view.setUint8(a, v)
        : w === 2
          ? view.setUint16(a, v, true)
          : view.setUint32(a, v, true),
    check:
      check ??
      ((a, n) => {
        if ((a >>> 0) + n > memory.buffer.byteLength) throw Error('range violation');
        return a >>> 0;
      }),
    executableRanges: [[CODE, CODE + code.length]],
    x87ModuleUrl: moduleUrl,
    x87WasmUrl: wasmUrl,
  });
  await cpu.initialize();
  return { cpu, memory, view, bytes: new Uint8Array(memory.buffer) };
}

test('x87 loads mixed binary formats, performs ext80 arithmetic, and stores rounded f64', async () => {
  const { cpu, view } = await machine([
    0xd9,
    0x00, // fld dword ptr [eax]
    0xdd,
    0x01, // fld qword ptr [ecx]
    0xde,
    0xc1, // faddp st(1),st(0)
    0xdd,
    0x1a, // fstp qword ptr [edx]
  ]);
  cpu.r[0].value = DATA;
  cpu.r[1].value = DATA + 8;
  cpu.r[2].value = DATA + 16;
  view.setFloat32(DATA, 1.5, true);
  view.setFloat64(DATA + 8, 2.25, true);
  cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };

  cpu.step(CODE);

  assert.equal(view.getFloat64(DATA + 16, true), 3.75);
  assert.equal(cpu.x87.top, 0);
  assert.ok(cpu.x87.tags.every((tag) => tag === 3));
  assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
});

test('80-bit FLD/FSTP preserves payload bits without narrowing', async () => {
  const { cpu, bytes } = await machine([0xdb, 0x28, 0xdb, 0x3a]); // fld tbyte [eax]; fstp tbyte [edx]
  const value = Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x34, 0x40]);
  bytes.set(value, DATA);
  cpu.r[0].value = DATA;
  cpu.r[2].value = DATA + 16;

  cpu.step(CODE);

  assert.deepEqual(bytes.slice(DATA + 16, DATA + 26), value);
});

test('x87 precision-control modes round arithmetic at 24 or 64 significand bits', async () => {
  const run = async (control) => {
    const { cpu, view } = await machine([
      0xdd,
      0x00, // fld qword ptr [eax]
      0xdd,
      0x01, // fld qword ptr [ecx]
      0xde,
      0xc1, // faddp st(1),st(0)
      0xdd,
      0x1a, // fstp qword ptr [edx]
    ]);
    cpu.r[0].value = DATA;
    cpu.r[1].value = DATA + 8;
    cpu.r[2].value = DATA + 16;
    cpu.x87.control = control;
    view.setFloat64(DATA, 1, true);
    view.setFloat64(DATA + 8, 2 ** -30, true);
    cpu.step(CODE);
    return view.getFloat64(DATA + 16, true);
  };

  assert.equal(await run(0x007f), 1); // PC=00, 24-bit significand
  assert.equal(await run(0x037f), 1 + 2 ** -30); // PC=11, 64-bit significand
});

test('integer conversion, constants, FXCH and reverse arithmetic use the x87 stack', async () => {
  const { cpu, view } = await machine([
    0xdb,
    0x00, // fild dword ptr [eax] => 7
    0xd9,
    0xe8, // fld1
    0xd9,
    0xc9, // fxch st(1) => 7,1
    0xd8,
    0xe9, // fsubr st(0),st(1) => 1-7
    0xdb,
    0x1a, // fistp dword ptr [edx]
    0xdd,
    0xd8, // fstp st(0), empty stack
  ]);
  cpu.r[0].value = DATA;
  cpu.r[2].value = DATA + 8;
  view.setInt32(DATA, 7, true);

  cpu.step(CODE);

  assert.equal(view.getInt32(DATA + 8, true), -6);
  assert.ok(cpu.x87.tags.every((tag) => tag === 3));
});

test('comparisons update x87 condition codes or integer flags and pop as encoded', async () => {
  const { cpu, view } = await machine([
    0xd9,
    0x00, // fld 2
    0xd9,
    0xe8, // fld1
    0xde,
    0xd9, // fcompp (1 < 2)
    0xd9,
    0x00, // fld 2
    0xd9,
    0xe8, // fld1
    0xdf,
    0xf1, // fcomip st(0),st(1)
    0xdd,
    0xd8, // fstp st(0)
  ]);
  cpu.r[0].value = DATA;
  view.setFloat32(DATA, 2, true);
  cpu.af = 1;

  cpu.step(CODE);

  assert.equal(cpu.x87.status & 0x4500, 0x0100);
  assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 0, of: 0, pf: 0 });
  assert.equal(cpu.af, 0);
  assert.ok(cpu.x87.tags.every((tag) => tag === 3));
});

test('control/status transfers and FSQRT honor checked memory and control state', async () => {
  const writes = [];
  const { cpu, view } = await machine(
    [
      0xd9,
      0x28, // fldcw [eax]
      0xd9,
      0x01, // fld dword ptr [ecx]
      0xd9,
      0xfa, // fsqrt
      0xd9,
      0x3a, // fnstcw [edx]
      0xdf,
      0xe0, // fnstsw ax
      0xdd,
      0x5f,
      0x08, // fstp qword ptr [edi+8]
    ],
    (a, n, write) => {
      if (write) writes.push([a >>> 0, n]);
      if ((a >>> 0) + n > 65536) throw Error('range violation');
      return a >>> 0;
    },
  );
  cpu.r[0].value = DATA;
  cpu.r[1].value = DATA + 4;
  cpu.r[2].value = DATA + 8;
  cpu.r[7].value = DATA + 16;
  view.setUint16(DATA, 0x027f, true); // 53-bit precision, all exceptions masked
  view.setFloat32(DATA + 4, 9, true);

  cpu.step(CODE);

  assert.equal(view.getUint16(DATA + 8, true), 0x027f);
  assert.equal(view.getFloat64(DATA + 24, true), 3);
  assert.ok(writes.some(([a, n]) => a === DATA + 24 && n === 8));
});

test('faulting x87 stores preflight memory before popping or mutating output', async () => {
  const { cpu, view } = await machine([0xd9, 0xe8, 0xdd, 0x18], (a, n, write) => {
    if (write && a === DATA) throw Error('read-only x87 target');
    return a >>> 0;
  });
  cpu.r[0].value = DATA;
  view.setUint32(DATA, 0xdeadbeef, true);

  assert.throws(() => cpu.step(CODE), /read-only x87 target/);
  assert.equal(view.getUint32(DATA, true), 0xdeadbeef);
  assert.notEqual(cpu.x87.tags[cpu.x87.top], 3);
});

test('unmasked FCOM NaN leaves flags and stack intact before raising', async () => {
  const { cpu, bytes } = await machine([
    0xdb,
    0x28, // fld tbyte ptr [eax] (quiet NaN)
    0xd9,
    0xe8, // fld1
    0xdf,
    0xf1, // fcomip st(0),st(1)
  ]);
  bytes.set(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0xc0, 0xff, 0x7f]), DATA);
  cpu.r[0].value = DATA;
  cpu.x87.control &= ~1;
  const initialFlags = { cf: 0, zf: 1, sf: 1, of: 1, pf: 0 };
  cpu.f = { ...initialFlags };

  assert.throws(() => cpu.step(CODE), /Unmasked x87 exception/);
  assert.deepEqual(cpu.f, initialFlags);
  assert.equal(cpu.x87.top, 6);
  assert.notEqual(cpu.x87.tags[cpu.x87.top], 3);
});

test('masked FCOM rejects quiet NaN while FUCOM reports unordered without invalid', async () => {
  const run = async (opcode) => {
    const { cpu, bytes } = await machine([
      0xdb,
      0x28, // fld quiet NaN
      0xd9,
      0xe8, // fld1
      0xdf,
      opcode, // fcomip/fucomip st(0),st(1)
    ]);
    bytes.set(Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0xc0, 0xff, 0x7f]), DATA);
    cpu.r[0].value = DATA;
    cpu.step(CODE);
    return cpu;
  };

  const fcom = await run(0xf1);
  assert.equal(fcom.x87.status & 1, 1);
  assert.deepEqual(fcom.f, { cf: 1, zf: 1, sf: 0, of: 0, pf: 1 });
  const fucom = await run(0xe9);
  assert.equal(fucom.x87.status & 1, 0);
  assert.deepEqual(fucom.f, { cf: 1, zf: 1, sf: 0, of: 0, pf: 1 });
});

const ext80 = (significand, signExponent) => {
  const bytes = new Uint8Array(10);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, significand, true);
  view.setUint16(8, signExponent, true);
  return bytes;
};

async function roundExt80(value, control = 0x037f) {
  const { cpu, bytes } = await machine([
    0xdb,
    0x28, // fld tbyte ptr [eax]
    0xd9,
    0xfc, // frndint
    0xdb,
    0x3a, // fstp tbyte ptr [edx]
  ]);
  cpu.r[0].value = DATA;
  cpu.r[2].value = DATA + 16;
  cpu.x87.control = control;
  bytes.set(value, DATA);
  cpu.step(CODE);
  return { cpu, value: bytes.slice(DATA + 16, DATA + 26) };
}

test('FRNDINT rounds ext80 directly in all x87 RC modes and reports inexact', async () => {
  const one = ext80(0x8000000000000000n, 0x3fff);
  const two = ext80(0x8000000000000000n, 0x4000);
  const onePointFive = ext80(0xc000000000000000n, 0x3fff);
  const cases = [
    [0x037f, two], // nearest even
    [0x077f, one], // toward -infinity
    [0x0b7f, two], // toward +infinity
    [0x0f7f, one], // toward zero
  ];
  for (const [control, expected] of cases) {
    const rounded = await roundExt80(onePointFive, control);
    assert.deepEqual(rounded.value, expected);
    assert.equal(rounded.cpu.x87.status & 0x20, 0x20);
  }
});

test('FRNDINT preserves large integral ext80, signed zero, infinity and quiet NaN', async () => {
  const values = [
    ext80(0x8000000000000001n, 0x403f), // integral and beyond signed int64
    ext80(0n, 0x8000), // negative zero
    ext80(0x8000000000000000n, 0x7fff), // positive infinity
    ext80(0xc000000000001234n, 0xffff), // negative quiet NaN payload
  ];
  for (const value of values) {
    const rounded = await roundExt80(value);
    assert.deepEqual(rounded.value, value);
    assert.equal(rounded.cpu.x87.status & 0x21, 0);
  }
});

test('FRNDINT quiets signaling NaN and handles masked or unmasked invalid', async () => {
  const signaling = ext80(0x8000000000001234n, 0x7fff);
  const masked = await roundExt80(signaling);
  assert.equal(masked.cpu.x87.status & 1, 1);
  assert.equal(masked.value[9] & 0x7f, 0x7f);
  assert.notEqual(masked.value[7] & 0x40, 0, 'result is a quiet NaN');

  const { cpu, bytes } = await machine([0xdb, 0x28, 0xd9, 0xfc]);
  bytes.set(signaling, DATA);
  cpu.r[0].value = DATA;
  cpu.x87.control &= ~1;
  assert.throws(() => cpu.step(CODE), /Unmasked x87 exception 0x1/);
  assert.deepEqual(cpu.x87.values[cpu.x87.top], signaling, 'ST(0) is unchanged');
  assert.equal(cpu.x87.status & 0x81, 0x81);
});

test('FCHS and FABS manipulate only the ext80 sign bit, including signed zero', async () => {
  const { cpu, bytes } = await machine([
    0xdb,
    0x28, // fld -0
    0xd9,
    0xe0, // fchs => +0
    0xd9,
    0xe0, // fchs => -0
    0xd9,
    0xe1, // fabs => +0
    0xdb,
    0x3a, // fstp tbyte [edx]
  ]);
  bytes.set(ext80(0n, 0x8000), DATA);
  cpu.r[0].value = DATA;
  cpu.r[2].value = DATA + 16;
  cpu.step(CODE);
  assert.deepEqual(bytes.slice(DATA + 16, DATA + 26), ext80(0n, 0));
  assert.equal(cpu.x87.status & 0x3f, 0);
});

test('FTST compares ST(0) with positive zero and applies FCOM NaN behavior', async () => {
  const run = async (value) => {
    const { cpu, bytes } = await machine([0xdb, 0x28, 0xd9, 0xe4]);
    bytes.set(value, DATA);
    cpu.r[0].value = DATA;
    cpu.step(CODE);
    return cpu.x87.status;
  };
  assert.equal((await run(ext80(0x8000000000000000n, 0x3fff))) & 0x4500, 0);
  assert.equal((await run(ext80(0x8000000000000000n, 0xbfff))) & 0x4500, 0x0100);
  assert.equal((await run(ext80(0n, 0x8000))) & 0x4500, 0x4000);
  const qnanStatus = await run(ext80(0xc000000000000001n, 0x7fff));
  assert.equal(qnanStatus & 0x4501, 0x4501);
});

test('WAIT continues with masked or absent x87 exceptions and preserves state', async () => {
  const { cpu } = await machine([0x9b]);
  cpu.x87.status = 0x21;
  cpu.x87.control = 0x037f;
  cpu.r[0].value = 0x12345678;
  cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };

  cpu.step(CODE);

  assert.equal(cpu.x87.status, 0x21);
  assert.equal(cpu.x87.control, 0x037f);
  assert.equal(cpu.r[0].value >>> 0, 0x12345678);
  assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
});

test('WAIT detects pending exception bits unmasked by the x87 control word', async () => {
  const { cpu } = await machine([0x9b]);
  cpu.x87.status = 0x21;
  cpu.x87.control = 0x037e; // invalid unmasked; precision remains masked
  const snapshot = cpu.x87.snapshot();

  assert.throws(() => cpu.step(CODE), /Pending unmasked x87 exception 0x1 delivery unsupported/);
  assert.equal(cpu.x87.status, snapshot.status | 0x80);
  assert.equal(cpu.x87.control, snapshot.control);
  assert.equal(cpu.x87.top, snapshot.top);
  assert.deepEqual(cpu.x87.tags, snapshot.tags);
  assert.deepEqual(cpu.x87.values, snapshot.values);
});

test('FNCLEX clears pending exception state before a following WAIT', async () => {
  const { cpu } = await machine([0xdb, 0xe2, 0x9b]); // fnclex; wait
  cpu.x87.status = 0xe1;
  cpu.x87.control = 0x037e;

  cpu.step(CODE);

  assert.equal(cpu.x87.status & 0xff, 0);
  assert.equal(cpu.x87.control, 0x037e);
});
