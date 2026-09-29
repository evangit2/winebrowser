import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { readFile } from 'node:fs/promises';

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

test('FFREE addresses ST0..ST7 relative to every TOP without popping or touching stored bits', async () => {
  for (let st = 0; st < 8; st++) {
    const { cpu } = await machine([0xdd, 0xc0 + st]);
    try {
      for (let top = 0; top < 8; top++) {
        cpu.x87.reset();
        cpu.x87.top = top;
        cpu.x87.control = 0x0300; // All exceptions unmasked; freeing generates none.
        cpu.x87.tags.set([0, 1, 2, 3, 0, 1, 2, 3]);
        cpu.x87.values.forEach((v, i) => v.fill(0xa0 + i));
        const before = cpu.x87.snapshot();
        cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
        cpu.step(CODE);
        assert.equal(cpu.x87.top, top);
        assert.deepEqual(cpu.x87.values, before.values);
        for (let physical = 0; physical < 8; physical++)
          assert.equal(
            cpu.x87.tags[physical],
            physical === (top + st) % 8 ? 3 : before.tags[physical],
          );
        assert.equal(cpu.x87.status & 0xff, 0);
        assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
      }
    } finally {
      cpu.dispose();
    }
  }
});

test('FFREE frees a full-stack push slot, and reading a freed register raises masked stack underflow', async () => {
  const { cpu } = await machine([0xdd, 0xc7, 0xd9, 0xe8]); // FFREE ST7; FLD1.
  try {
    cpu.x87.tags.fill(0);
    cpu.x87.values.forEach((v) => v.set(Buffer.from('0000000000000080ff3f', 'hex')));
    cpu.step(CODE);
    assert.equal(cpu.x87.top, 7);
    assert.equal(cpu.x87.tags[7], 0);
    assert.equal(cpu.x87.status & 0x241, 0);
  } finally {
    cpu.dispose();
  }
  const other = await machine([0xdd, 0xc0, 0xd9, 0xc0, 0xdb, 0x38]); // FFREE ST0; FLD ST0; FSTP [EAX].
  try {
    other.cpu.r[0].value = DATA;
    other.cpu.x87.tags[0] = 0;
    other.cpu.x87.values[0].set(Buffer.from('0000000000000080ff3f', 'hex'));
    other.cpu.step(CODE);
    assert.equal(other.cpu.x87.top, 0);
    assert.equal(other.cpu.x87.tags[0], 3);
    assert.equal(other.cpu.x87.status & 0x241, 0x41);
    assert.equal(
      Buffer.from(other.bytes.slice(DATA, DATA + 10)).toString('hex'),
      '00000000000000c0ffff',
    );
  } finally {
    other.cpu.dispose();
  }
});

test('FFREE checks pending unmasked exceptions before changing tags and rejects LOCK', async () => {
  const { cpu } = await machine([0xdd, 0xc3]);
  try {
    cpu.x87.top = 6;
    cpu.x87.tags.fill(0);
    cpu.x87.control &= ~1;
    cpu.x87.status = 1;
    assert.throws(() => cpu.step(CODE), /Pending unmasked x87 exception/);
    assert.ok(cpu.x87.tags.every((t) => t === 0));
    assert.equal(cpu.x87.top, 6);
    cpu.x87.control |= 1;
    cpu.step(CODE);
    assert.equal(cpu.x87.tags[1], 3);
  } finally {
    cpu.dispose();
  }
  const locked = await machine([0xf0, 0xdd, 0xc0]);
  try {
    assert.throws(() => locked.cpu.step(CODE), /Unsupported|Invalid/);
  } finally {
    locked.cpu.dispose();
  }
});

test('FYL2X preserves ext80 low bits regardless of precision control and leaves integer flags unchanged', async () => {
  const { vectors } = JSON.parse(
    await readFile(new URL('./fixtures/x87-log-vectors.json', import.meta.url)),
  );
  const { cpu, bytes } = await machine([0xdb, 0x28, 0xdb, 0x29, 0xd9, 0xf1, 0xdb, 0x3a]);
  cpu.r[0].value = DATA;
  cpu.r[1].value = DATA + 16;
  cpu.r[2].value = DATA + 32;
  for (const pc of [0, 2, 3])
    for (const v of vectors.filter((v) => v.name === 'above-one')) {
      cpu.x87.reset();
      cpu.x87.control = 0x7f | (pc << 8) | (v.mode << 10);
      cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
      bytes.set(Buffer.from(v.y, 'hex'), DATA);
      bytes.set(Buffer.from(v.x, 'hex'), DATA + 16);
      cpu.step(CODE);
      assert.equal(Buffer.from(bytes.slice(DATA + 32, DATA + 42)).toString('hex'), v.output);
      assert.equal(cpu.x87.status & 0x3f, v.flags);
      assert.equal(cpu.x87.top, 0);
      assert.ok(cpu.x87.tags.every((tag) => tag === 3));
      assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
    }
});

test('FYL2X unmasked exceptions stop before modifying operands or popping; masked stack faults return indefinite', async () => {
  const { cpu, view, bytes } = await machine([0xdd, 0x00, 0xdd, 0x01, 0xd9, 0xf1, 0xdb, 0x3a]);
  cpu.r[0].value = DATA;
  cpu.r[1].value = DATA + 8;
  cpu.r[2].value = DATA + 32;
  view.setFloat64(DATA, 1, true);
  view.setFloat64(DATA + 8, 0, true);
  bytes.fill(0xa5, DATA + 32, DATA + 42);
  cpu.x87.control = 0x037b; // Divide-by-zero unmasked.
  assert.throws(() => cpu.step(CODE), /Unmasked x87 exception 0x4/);
  assert.equal(cpu.x87.top, 6);
  assert.equal(cpu.x87.tags[6], 1); // ST0 is still zero.
  assert.equal(cpu.x87.tags[7], 0); // ST1 is still one.
  assert.equal(cpu.x87.status & 0x84, 0x84);
  assert.deepEqual([...bytes.slice(DATA + 32, DATA + 42)], Array(10).fill(0xa5));
  cpu.x87.reset();
  cpu.step(CODE + 4); // Empty-stack FYL2X followed by FSTP.
  assert.equal(cpu.x87.status & 0x241, 0x41);
  assert.equal(
    Buffer.from(bytes.slice(DATA + 32, DATA + 42)).toString('hex'),
    '00000000000000c0ffff',
  );
});

test('trig range rejection preserves both operands and stack even for FSINCOS, and valid operations clear C2', async () => {
  for (const opcode of [0xfe, 0xff, 0xfb]) {
    const { cpu, bytes } = await machine([0xdb, 0x28, 0xd9, opcode]);
    cpu.r[0].value = DATA;
    bytes.set(Buffer.from('00000000000000803e40', 'hex'), DATA); // +2^63
    cpu.step(CODE);
    assert.equal(cpu.x87.top, 7);
    assert.equal(cpu.x87.status & 0x400, 0x400);
    assert.equal(Buffer.from(cpu.x87.values[7]).toString('hex'), '00000000000000803e40');
    cpu.x87.values[7].set(Buffer.from('00000000000000000080', 'hex')); // -0
    cpu.x87.tags[7] = 1;
    cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
    cpu.step(CODE + 2);
    assert.equal(cpu.x87.status & 0x400, 0);
    assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
    assert.equal(cpu.x87.top, opcode === 0xfb ? 6 : 7);
    assert.equal(
      Buffer.from(cpu.x87.values[cpu.x87.top]).toString('hex'),
      opcode === 0xfe ? '00000000000000000080' : '0000000000000080ff3f',
    );
    if (opcode === 0xfb)
      assert.equal(Buffer.from(cpu.x87.values[7]).toString('hex'), '00000000000000000080');
  }
});

test('FSINCOS checks stack capacity and unmasked exceptions before replacing the original value', async () => {
  const { cpu } = await machine([0xd9, 0xfb]);
  const one = Buffer.from('0000000000000080ff3f', 'hex');
  cpu.x87.values.forEach((value) => value.set(one));
  cpu.x87.tags.fill(0);
  cpu.x87.control &= ~1;
  assert.throws(() => cpu.step(CODE), /Unmasked x87 exception 0x1/);
  assert.equal(cpu.x87.top, 0);
  assert.equal(cpu.x87.status & 0x241, 0x241);
  assert.equal(Buffer.from(cpu.x87.values[0]).toString('hex'), one.toString('hex'));
  cpu.x87.control |= 1;
  cpu.step(CODE);
  assert.equal(cpu.x87.top, 7);
  for (const index of [0, 7])
    assert.equal(Buffer.from(cpu.x87.values[index]).toString('hex'), '00000000000000c0ffff');
  cpu.x87.reset();
  cpu.x87.tags[0] = 2;
  cpu.x87.values[0].set(Buffer.from('0000000000000080ff7f', 'hex'));
  cpu.x87.control &= ~1;
  assert.throws(() => cpu.step(CODE), /Unmasked x87 exception 0x1/);
  assert.equal(cpu.x87.top, 0);
  assert.equal(cpu.x87.tags[7], 3);
  assert.equal(Buffer.from(cpu.x87.values[0]).toString('hex'), '0000000000000080ff7f');
});

test('trig results retain ext80 precision under all precision-control settings', async () => {
  const { vectors } = JSON.parse(
    await readFile(new URL('./fixtures/x87-trig-vectors.json', import.meta.url)),
  );
  const cases = vectors.filter((v) => v.name === 'one');
  const { cpu, bytes } = await machine([0xdb, 0x28, 0xd9, 0xfb, 0xdb, 0x3a, 0xdb, 0x39]);
  cpu.r[0].value = DATA;
  cpu.r[1].value = DATA + 16; // sine
  cpu.r[2].value = DATA + 32; // cosine
  for (const pc of [0, 2, 3])
    for (const v of cases) {
      cpu.x87.reset();
      cpu.x87.control = 0x7f | (pc << 8) | (v.mode << 10);
      bytes.set(Buffer.from(v.x, 'hex'), DATA);
      cpu.step(CODE);
      assert.equal(Buffer.from(bytes.slice(DATA + 16, DATA + 26)).toString('hex'), v.sine.output);
      assert.equal(Buffer.from(bytes.slice(DATA + 32, DATA + 42)).toString('hex'), v.cosine.output);
      assert.equal(cpu.x87.top, 0);
    }
});

test('FXAM classifies every value class and sign, including empty and signaling NaN, without exceptions', async () => {
  const { cpu } = await machine([0xd9, 0xe5]);
  const cases = [
    ['0000000000000080ff3f', 0, 0x400], // normal
    ['0000000000000080ff7f', 2, 0x500], // infinity
    ['00000000000000000000', 1, 0x4000], // zero
    ['01000000000000000000', 2, 0x4400], // denormal
    ['01000000000000c0ff7f', 2, 0x100], // quiet NaN
    ['0100000000000080ff7f', 2, 0x100], // signaling NaN
    ['0100000000000000ff3f', 2, 0], // unsupported unnormal
    ['0000000000000080ff3f', 3, 0x4100], // stale normal in an empty slot
    ['00000000000000000000', 3, 0x4100], // empty takes precedence over zero
  ];
  for (const [hex, tag, expected] of cases)
    for (const sign of [0, 1]) {
      cpu.x87.reset();
      cpu.x87.top = 5;
      cpu.x87.control = 0x0300; // All exceptions unmasked; FXAM raises none.
      cpu.x87.values[5].set(Buffer.from(hex, 'hex'));
      cpu.x87.values[5][9] |= sign << 7;
      cpu.x87.tags[5] = tag;
      cpu.x87.status = 0x477f; // Preserve prior exception flags.
      const before = cpu.x87.values[5].slice();
      cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
      cpu.step(CODE);
      assert.equal(cpu.x87.status, 0x7f | expected | (sign << 9));
      assert.equal(cpu.x87.top, 5);
      assert.equal(cpu.x87.tags[5], tag);
      assert.deepEqual(cpu.x87.values[5], before);
      assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
    }
});

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

test('FISTTP truncates and pops all integer widths without changing rounding control or integer flags', async () => {
  for (const [width, opcode] of [
    [2, 0xdf],
    [4, 0xdb],
    [8, 0xdd],
  ])
    for (const mode of [0, 1, 2, 3])
      for (const value of [-1.75, -0.75, 0, 0.75, 1.75]) {
        const { cpu, view, bytes } = await machine([0xdd, 0x00, opcode, 0x09]); // fld qword [eax]; fisttp [ecx]
        cpu.r[0].value = DATA;
        cpu.r[1].value = DATA + 17;
        view.setFloat64(DATA, value, true);
        bytes.fill(0xa5, DATA + 16, DATA + 32);
        cpu.x87.control = 0x37f | (mode << 10);
        cpu.x87.status = 0x200;
        cpu.f = { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 };
        cpu.af = 1;
        cpu.step(CODE);
        const actual =
          width === 8
            ? view.getBigInt64(DATA + 17, true)
            : BigInt(width === 4 ? view.getInt32(DATA + 17, true) : view.getInt16(DATA + 17, true));
        assert.equal(actual, BigInt(Math.trunc(value)));
        assert.equal(cpu.x87.control, 0x37f | (mode << 10));
        assert.equal(cpu.x87.status & 0x23f, Number(!Number.isInteger(value)) * 32);
        assert.equal(cpu.x87.top, 0);
        assert.ok(cpu.x87.tags.every((tag) => tag === 3));
        assert.equal(bytes[DATA + 16], 0xa5);
        assert.equal(bytes[DATA + 17 + width], 0xa5);
        assert.deepEqual(cpu.f, { cf: 1, zf: 1, sf: 0, of: 1, pf: 0 });
        assert.equal(cpu.af, 1);
        cpu.dispose();
      }
});

test('FISTTP preserves int64 low bits and bounds without narrowing ext80 to a JS number', async () => {
  const { cpu, view, bytes } = await machine([0xdb, 0x28, 0xdd, 0x09]);
  cpu.r[0].value = DATA;
  cpu.r[1].value = DATA + 16;
  for (const [significand, exponent, expected, flags] of [
    [0x8000000000000c00n, 0x4034, 0x20000000000003n, 0], // 2^53+3
    [0xfffffffffffffffen, 0x403d, 0x7fffffffffffffffn, 0], // INT64_MAX
    [0x8000000000000000n, 0xc03e, -0x8000000000000000n, 0],
    [0x8000000000000000n, 0x403e, -0x8000000000000000n, 1], // +2^63 invalid
  ]) {
    cpu.x87.reset();
    view.setBigUint64(DATA, significand, true);
    view.setUint16(DATA + 8, exponent, true);
    bytes.fill(0xa5, DATA + 16, DATA + 24);
    cpu.step(CODE);
    assert.equal(view.getBigInt64(DATA + 16, true), expected);
    assert.equal(cpu.x87.status & 63, flags);
  }
  cpu.dispose();
});

test('FISTTP masked invalid stores integer indefinite; unmasked invalid/precision preserve memory and stack', async () => {
  for (const [width, opcode, invalid] of [
    [2, 0xdf, 32768.5],
    [4, 0xdb, 2147483648.5],
    [8, 0xdd, 2 ** 63],
  ])
    for (const value of [invalid, NaN, Infinity]) {
      const { cpu, view, bytes } = await machine([0xdd, 0x00, opcode, 0x09]);
      cpu.r[0].value = DATA;
      cpu.r[1].value = DATA + 16;
      view.setFloat64(DATA, value, true);
      cpu.step(CODE);
      const result = bytes.slice(DATA + 16, DATA + 16 + width);
      assert.deepEqual([...result], [...Array(width - 1).fill(0), 0x80]);
      assert.equal(cpu.x87.status & 63, 1);
      cpu.x87.reset();
      cpu.x87.control = 0x35e;
      bytes.fill(0xa5, DATA + 16, DATA + 24); // invalid and precision unmasked
      assert.throws(() => cpu.step(CODE), /Unmasked x87 exception 0x1/);
      assert.equal(cpu.x87.top, 7);
      assert.notEqual(cpu.x87.tags[7], 3);
      assert.ok(bytes.slice(DATA + 16, DATA + 24).every((x) => x === 0xa5));
      cpu.dispose();
    }
  const { cpu, view, bytes } = await machine([0xdd, 0x00, 0xdd, 0x09]);
  cpu.r[0].value = DATA;
  cpu.r[1].value = DATA + 16;
  view.setFloat64(DATA, 1.25, true);
  cpu.x87.control = 0x35f;
  bytes.fill(0xa5, DATA + 16, DATA + 24);
  assert.throws(() => cpu.step(CODE), /Unmasked x87 exception 0x20/);
  assert.equal(cpu.x87.top, 7);
  assert.ok(bytes.slice(DATA + 16, DATA + 24).every((x) => x === 0xa5));
  cpu.dispose();
});

test('FISTTP preflights memory before stack/status mutation and reports empty-stack faults', async () => {
  const { cpu } = await machine([0xdf, 0x08], () => {
    throw Error('integer store denied');
  });
  cpu.x87.status = 0x200;
  const before = cpu.x87.snapshot();
  assert.throws(() => cpu.step(CODE), /integer store denied/);
  assert.deepEqual(cpu.x87.snapshot(), before);
  cpu.dispose();
  for (const [width, opcode] of [
    [2, 0xdf],
    [4, 0xdb],
    [8, 0xdd],
  ]) {
    const { cpu, bytes } = await machine([opcode, 0x08]);
    cpu.r[0].value = DATA;
    cpu.x87.status = 0x200;
    cpu.step(CODE);
    assert.deepEqual([...bytes.slice(DATA, DATA + width)], [...Array(width - 1).fill(0), 0x80]);
    assert.equal(cpu.x87.status & 0x241, 0x41);
    assert.equal(cpu.x87.top, 1);
    cpu.dispose();
  }
});

test('FISTP int16 range failure takes priority over an unmasked inexact intermediate', async () => {
  const { cpu, view } = await machine([0xdd, 0x00, 0xdf, 0x19]);
  cpu.r[0].value = DATA;
  cpu.r[1].value = DATA + 16;
  view.setFloat64(DATA, 32767.75, true);
  cpu.x87.control = 0x35f; // invalid masked, precision unmasked, nearest-even
  cpu.step(CODE);
  assert.equal(view.getInt16(DATA + 16, true), -32768);
  assert.equal(cpu.x87.status & 63, 1);
  assert.equal(cpu.x87.top, 0);
  cpu.dispose();
});

function integerExt80(value) {
  const negative = value < 0n;
  const n = negative ? -value : value;
  if (!n) return ext80(0n, 0);
  const bits = n.toString(2).length;
  return ext80(n << BigInt(64 - bits), (negative ? 0x8000 : 0) | (16382 + bits));
}
async function integerOperation(width, selector, left, operand, control = 0x037f, check) {
  const result = await machine([width === 2 ? 0xde : 0xda, (selector << 3) | 1], check);
  const { cpu, view } = result;
  cpu.r[1].value = DATA;
  if (width === 2) view.setInt16(DATA, operand, true);
  else view.setInt32(DATA, operand, true);
  cpu.x87.top = 0;
  cpu.x87.tags[0] = 0;
  cpu.x87.values[0].set(left);
  cpu.x87.control = control;
  return result;
}

test('FIADD/FIMUL/FISUB/FISUBR/FIDIV/FIDIVR decode both signed integer widths and preserve integer flags', async () => {
  for (const width of [2, 4]) {
    for (const [selector, expected] of [
      [0, integerExt80(9n)],
      [1, integerExt80(-36n)],
      [4, integerExt80(15n)],
      [5, integerExt80(-15n)],
      [6, integerExt80(-4n)],
      [7, ext80(0x8000000000000000n, 0xbffd)],
    ]) {
      const { cpu } = await integerOperation(width, selector, integerExt80(12n), -3);
      try {
        cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
        cpu.af = 1;
        cpu.x87.status = 0x200;
        cpu.step(CODE);
        assert.deepEqual(cpu.x87.values[0], expected, `${width}-byte selector ${selector}`);
        assert.equal(cpu.x87.top, 0);
        assert.equal(cpu.x87.status & 0x23f, 0);
        assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
        assert.equal(cpu.af, 1);
      } finally {
        cpu.dispose();
      }
    }
    const min = width === 2 ? -32768 : -2147483648;
    const { cpu } = await integerOperation(width, 0, integerExt80(-BigInt(min)), min);
    cpu.step(CODE);
    assert.deepEqual(cpu.x87.values[0], integerExt80(0n));
    cpu.dispose();
  }
});

test('integer operands convert exactly before arithmetic/comparison regardless of x87 precision control', async () => {
  for (const pc of [0, 2, 3])
    for (const selector of [4, 2]) {
      const { cpu } = await integerOperation(
        4,
        selector,
        integerExt80(2147483647n),
        2147483647,
        0x7f | (pc << 8),
      );
      cpu.step(CODE);
      if (selector === 4) assert.deepEqual(cpu.x87.values[0], integerExt80(0n));
      else assert.equal(cpu.x87.status & 0x4500, 0x4000);
      assert.equal(cpu.x87.status & 0x3f, 0);
      cpu.dispose();
    }
  const { cpu } = await integerOperation(4, 0, ext80(0x8000000000000001n, 0x3fff), -1);
  cpu.step(CODE);
  assert.deepEqual(cpu.x87.values[0], ext80(0x8000000000000000n, 0x3fc0));
  cpu.dispose();
});

test('FIDIV rounds a rational at every precision/rounding mode and reports inexact and C1 for either sign', async () => {
  for (const [pc, precision] of [
    [0, 24],
    [2, 53],
    [3, 64],
  ])
    for (const rc of [0, 1, 2, 3])
      for (const negative of [false, true]) {
        const scaled = 1n << BigInt(precision + 1),
          q = scaled / 3n,
          remainder = scaled % 3n;
        const increment =
          rc === 0 ? remainder * 2n > 3n : rc === 1 ? negative : rc === 2 ? !negative : false;
        const expected = ext80(
          (q + BigInt(increment)) << BigInt(64 - precision),
          (negative ? 0x8000 : 0) | 0x3ffd,
        );
        const { cpu } = await integerOperation(
          4,
          6,
          integerExt80(negative ? -1n : 1n),
          3,
          0x7f | (pc << 8) | (rc << 10),
        );
        try {
          cpu.step(CODE);
          assert.deepEqual(
            cpu.x87.values[0],
            expected,
            `PC=${precision}, RC=${rc}, negative=${negative}`,
          );
          assert.equal(cpu.x87.status & 0x23f, 0x20 | (increment ? 0x200 : 0));
        } finally {
          cpu.dispose();
        }
      }
});

test('FICOM/FICOMP compare signed integers, clear C1 and pop only after successful or masked comparisons', async () => {
  for (const width of [2, 4])
    for (const selector of [2, 3])
      for (const [left, bits] of [
        [-8n, 0x100],
        [-7n, 0x4000],
        [-6n, 0],
      ]) {
        const { cpu } = await integerOperation(width, selector, integerExt80(left), -7);
        cpu.x87.status = 0x200;
        cpu.step(CODE);
        assert.equal(cpu.x87.status & 0x4700, bits);
        assert.equal(cpu.x87.top, selector === 3 ? 1 : 0);
        cpu.dispose();
      }
  for (const masked of [true, false]) {
    const { cpu } = await integerOperation(
      4,
      3,
      ext80(0xc000000000000001n, 0x7fff),
      0,
      masked ? 0x37f : 0x37e,
    );
    if (masked) {
      cpu.step(CODE);
      assert.equal(cpu.x87.status & 0x4501, 0x4501);
      assert.equal(cpu.x87.top, 1);
    } else {
      assert.throws(() => cpu.step(CODE), /Unmasked x87 exception 0x1/);
      assert.equal(cpu.x87.top, 0);
      assert.equal(cpu.x87.tags[0], 0);
    }
    cpu.dispose();
  }
});

test('integer memory faults leave the complete x87 state unchanged; unmasked divide-by-zero preserves ST0', async () => {
  for (const width of [2, 4])
    for (const selector of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const { cpu } = await integerOperation(
        width,
        selector,
        integerExt80(7n),
        1,
        0x37f,
        (address, size) => {
          if (address === DATA) throw Error('operand read denied');
          return address;
        },
      );
      cpu.x87.status = 0x200;
      const before = cpu.x87.snapshot();
      assert.throws(() => cpu.step(CODE), /operand read denied/);
      assert.deepEqual(cpu.x87.snapshot(), before);
      cpu.dispose();
    }
  const { cpu } = await integerOperation(4, 6, integerExt80(7n), 0, 0x37b);
  assert.throws(() => cpu.step(CODE), /Unmasked x87 exception 0x4/);
  assert.deepEqual(cpu.x87.values[0], integerExt80(7n));
  assert.equal(cpu.x87.top, 0);
  assert.equal(cpu.x87.status & 0x84, 0x84);
  cpu.dispose();
});

test('inexact integer add/subtract/reverse/multiply share C1 magnitude rounding and overflow handling', async () => {
  const plusUlp = ext80(0x8000000000000001n, 0x3fff);
  for (const [selector, integer, exponent, base, negative] of [
    [0, 1, 0x4000, 0x8000000000000000n, false], // 2 + 2^-63, halfway between ext80 numbers.
    [4, -1, 0x4000, 0x8000000000000000n, false],
    [5, -1, 0x4000, 0x8000000000000000n, true],
    [1, 3, 0x4000, 0xc000000000000001n, false], // 3 + 3*2^-63, half-ULP above base.
  ])
    for (const rc of [1, 2, 3]) {
      const up = rc === 1 ? negative : rc === 2 ? !negative : false;
      const { cpu } = await integerOperation(4, selector, plusUlp, integer, 0x37f | (rc << 10));
      try {
        cpu.step(CODE);
        assert.deepEqual(
          cpu.x87.values[0],
          ext80(base + BigInt(up), exponent | (negative ? 0x8000 : 0)),
        );
        assert.equal(cpu.x87.status & 0x23f, 0x20 | (up ? 0x200 : 0));
      } finally {
        cpu.dispose();
      }
    }
  const { cpu } = await integerOperation(4, 1, ext80(0xffffffffffffffffn, 0x7ffe), 2);
  cpu.step(CODE);
  assert.deepEqual(cpu.x87.values[0], ext80(0x8000000000000000n, 0x7fff));
  assert.equal(cpu.x87.status & 0x23f, 0x228);
  cpu.dispose();
});

test('freestanding native integer-x87 fixture passes the ordinary PE runtime', async () => {
  const { probeX87Integer } = await import('../scripts/lib/x87-integer-probe.js');
  const bytes = new Uint8Array(
    await readFile(new URL('./fixtures/x87-integer/x87-integer.exe', import.meta.url)),
  );
  const report = await probeX87Integer(iced, { files: new Map([['x87-integer.exe', bytes]]) });
  assert.equal(report.status, 'passed', report.failure);
});

// FCMOVcc moves ST(i) into ST(0) only when the matching integer condition
// holds. The encodings are DA/DB C0..DF with ST(i) in the low three bits.
const FCMOV = {
  fcmovb: [0xda, 0xc0],
  fcmove: [0xda, 0xc8],
  fcmovbe: [0xda, 0xd0],
  fcmovu: [0xda, 0xd8],
  fcmovnb: [0xdb, 0xc0],
  fcmovne: [0xdb, 0xc8],
  fcmovnbe: [0xdb, 0xd0],
  fcmovnu: [0xdb, 0xd8],
};
// Explicit flag pairs per condition: [movesWhen], [doesNotMoveWhen].
const F = (cf, zf, pf) => ({ cf, zf, pf });
const CONDITIONS = {
  fcmovb: [F(1, 0, 0), F(0, 0, 0)],
  fcmove: [F(0, 1, 0), F(0, 0, 0)],
  fcmovbe: [F(1, 0, 0), F(0, 0, 0)],
  fcmovu: [F(0, 0, 1), F(0, 0, 0)],
  fcmovnb: [F(0, 0, 0), F(1, 0, 0)],
  fcmovne: [F(0, 0, 0), F(0, 1, 0)],
  fcmovnbe: [F(0, 0, 0), F(1, 0, 0)],
  fcmovnu: [F(0, 0, 0), F(0, 0, 1)],
};

// Eight distinct, finite ext80 patterns so a copy is unmistakable.
const CONSTANTS_FOR_TEST = [
  '0000000000000000' + '0000',
  '0000000000000080' + 'ff3f',
  '00000000000000c0' + 'ff3f',
  '0000000000000000' + '0140',
  '0000000000000000' + '0240',
  '0000000000000000' + '0340',
  '0000000000000000' + '0440',
  '0000000000000000' + '0540',
].map((hex) => Uint8Array.from(hex.match(/../g), (x) => Number.parseInt(x, 16)));

test('FCMOVcc conditionally copies ST(i) to ST0 for all eight integer conditions', async () => {
  for (const [name, [opcode, base]] of Object.entries(FCMOV)) {
    for (const i of [1, 2, 5, 7]) {
      const { cpu } = await machine([opcode, base + i]);
      try {
        const [trueFlags, falseFlags] = CONDITIONS[name];
        for (const [flags, expectMove] of [
          [trueFlags, true],
          [falseFlags, false],
        ]) {
          cpu.x87.reset();
          cpu.x87.tags.fill(0);
          cpu.x87.values.forEach((v, n) => v.set(CONSTANTS_FOR_TEST[n]));
          const before = cpu.x87.snapshot();
          cpu.f = { sf: 0, of: 0, af: 0, df: 0, ...flags };
          cpu.step(CODE);
          assert.equal(cpu.x87.top, before.top, `${name} ST(${i}) preserves TOP`);
          for (let st = 0; st < 8; st++) {
            // FCMOVcc copies ST(i) into ST(0); every other register, including
            // the source, keeps its prior value.
            const expected =
              st === 0 ? (expectMove ? before.values[i] : before.values[0]) : before.values[st];
            assert.deepEqual(cpu.x87.values[st], expected, `${name} ST(${i}) value ${st}`);
          }
          assert.equal(cpu.x87.status & 0xff, 0, `${name} raises no exception flags`);
          assert.deepEqual(
            { cf: cpu.f.cf, zf: cpu.f.zf, pf: cpu.f.pf },
            flags,
            `${name} preserves integer flags`,
          );
        }
      } finally {
        cpu.dispose();
      }
    }
  }
});

// FNSTENV/FNSAVE store the 28-byte environment (control, status, tag word,
// instruction/data pointers, last opcode) and FNSAVE appends the eight 80-bit
// registers in physical R0..R7 order before reinitializing the FPU.
const ENV_STATE = () => ({
  control: 0x0320, // RC=0, PC=11 (64-bit), only some exception masks set.
  status: 0x0041,
  top: 3,
  tags: [0, 1, 2, 3, 0, 1, 2, 3],
  values: Array.from({ length: 8 }, (_, i) => Uint8Array.from({ length: 10 }, () => 0xa0 + i)),
});

test('FNSAVE stores control (masked), status, the tag word and physical registers, then reinitializes', async () => {
  const { cpu, view, bytes } = await machine([0xdd, 0x30]); // fnsave [eax]
  try {
    cpu.r[0].value = DATA;
    const state = ENV_STATE();
    cpu.x87.reset();
    cpu.x87.control = state.control;
    cpu.x87.status = state.status;
    cpu.x87.top = state.top;
    cpu.x87.tags.set(state.tags);
    state.values.forEach((value, i) => cpu.x87.values[i].set(value));

    cpu.step(CODE);

    assert.equal(view.getUint16(DATA, true), state.control | 0x3f, 'every exception is masked');
    assert.equal(
      view.getUint16(DATA + 4, true),
      (state.status & ~(7 << 11)) | (state.top << 11),
      'status carries TOP in bits 11-13',
    );
    assert.equal(view.getUint16(DATA + 8, true), 0xe4e4, 'two-bit tags, physical order');
    for (let i = 0; i < 8; i++)
      assert.deepEqual(
        [...bytes.subarray(DATA + 28 + i * 10, DATA + 38 + i * 10)],
        [...state.values[i]],
        `register R${i} stored in physical order`,
      );
    // FNSAVE reinitializes the FPU: default control, empty tags, TOP 0.
    assert.equal(cpu.x87.control, 0x037f);
    assert.equal(cpu.x87.status, 0);
    assert.equal(cpu.x87.top, 0);
    assert.ok([...cpu.x87.tags].every((tag) => tag === 3));
  } finally {
    cpu.dispose();
  }
});

test('FRSTOR restores the environment and registers from an FNSAVE image', async () => {
  const state = ENV_STATE();
  const stateBytes = Uint8Array.from({ length: 108 }, () => 0);
  const stateView = new DataView(stateBytes.buffer);
  stateView.setUint16(0, state.control | 0x3f, true);
  stateView.setUint16(4, (state.status & ~(7 << 11)) | (state.top << 11), true);
  let tags = 0;
  for (let i = 0; i < 8; i++) tags |= state.tags[i] << (i * 2);
  stateView.setUint16(8, tags, true);
  for (let i = 0; i < 8; i++) stateBytes.set(state.values[i], 28 + i * 10);

  // Only the FRSTOR instruction: a block starting at the save instruction
  // would otherwise re-save after the restore.
  const { cpu, bytes } = await machine([0xdd, 0x20]); // frstor [eax]
  try {
    cpu.r[0].value = DATA;
    cpu.x87.reset();
    cpu.x87.control = 0x037f;
    cpu.x87.tags.fill(3);
    bytes.set(stateBytes, DATA);

    cpu.step(CODE);

    assert.equal(cpu.x87.control, state.control | 0x3f, 'control comes back as stored (masked)');
    assert.equal(cpu.x87.top, state.top, 'TOP is restored');
    assert.deepEqual([...cpu.x87.tags], state.tags, 'tag word is restored verbatim');
    // Empty slots keep their undefined contents; only occupied registers load.
    for (let i = 0; i < 8; i++)
      if (state.tags[i] !== 3)
        assert.deepEqual([...cpu.x87.values[i]], [...state.values[i]], `R${i} restored`);
  } finally {
    cpu.dispose();
  }
});

test('an FNSAVE/FRSTOR round trip through memory preserves live x87 state', async () => {
  const state = ENV_STATE();
  // Two separate programs so each translated block holds exactly one state
  // instruction: a save block and a restore block.
  const save = await machine([0xdd, 0x30]); // fnsave [eax]
  const restore = await machine([0xdd, 0x20]); // frstor [eax]
  try {
    save.cpu.r[0].value = DATA;
    save.cpu.x87.reset();
    save.cpu.x87.control = state.control;
    save.cpu.x87.status = state.status;
    save.cpu.x87.top = state.top;
    save.cpu.x87.tags.set(state.tags);
    state.values.forEach((value, i) => save.cpu.x87.values[i].set(value));
    save.cpu.step(CODE);
    const image = save.bytes.slice(DATA, DATA + 108);

    restore.bytes.set(image, DATA);
    restore.cpu.r[0].value = DATA;
    restore.cpu.step(CODE);

    assert.equal(restore.cpu.x87.control, state.control | 0x3f);
    assert.equal(restore.cpu.x87.top, state.top);
    assert.deepEqual([...restore.cpu.x87.tags], state.tags);
    for (let i = 0; i < 8; i++)
      if (state.tags[i] !== 3)
        assert.deepEqual([...restore.cpu.x87.values[i]], [...state.values[i]]);
  } finally {
    save.cpu.dispose();
    restore.cpu.dispose();
  }
});

test('FNSTENV writes only the masked environment and leaves the live control word alone', async () => {
  const { cpu, view } = await machine([0xd9, 0x30]); // fnstenv [eax]
  try {
    cpu.r[0].value = DATA;
    const state = ENV_STATE();
    cpu.x87.reset();
    cpu.x87.control = state.control;
    cpu.x87.status = state.status;
    cpu.x87.top = state.top;
    cpu.x87.tags.set(state.tags);
    cpu.step(CODE);
    assert.equal(view.getUint16(DATA, true), state.control | 0x3f, 'stored control is masked');
    assert.equal(cpu.x87.control, state.control, 'the live control word is untouched by FNSTENV');
    assert.equal(cpu.x87.top, state.top, 'FNSTENV does not pop or reinitialize');
    assert.equal(view.getUint16(DATA + 8, true), 0xe4e4);
  } finally {
    cpu.dispose();
  }
});

test('FLDENV restores control and tags but leaves register contents stale', async () => {
  const state = ENV_STATE();
  const envBytes = Uint8Array.from({ length: 28 }, () => 0);
  const envView = new DataView(envBytes.buffer);
  envView.setUint16(0, state.control | 0x3f, true);
  envView.setUint16(4, (state.status & ~(7 << 11)) | (state.top << 11), true);
  let tags = 0;
  for (let i = 0; i < 8; i++) tags |= state.tags[i] << (i * 2);
  envView.setUint16(8, tags, true);

  const { cpu, bytes } = await machine([0xd9, 0x20]); // fldenv [eax]
  try {
    cpu.r[0].value = DATA;
    cpu.x87.reset();
    cpu.x87.tags.fill(0);
    cpu.x87.values.forEach((value, i) => value.fill(0x11 * i));
    bytes.set(envBytes, DATA);

    cpu.step(CODE);

    assert.equal(cpu.x87.control, state.control | 0x3f, 'control restored from the image');
    assert.equal(cpu.x87.top, state.top, 'TOP restored');
    assert.deepEqual([...cpu.x87.tags], state.tags, 'tags restored from the image');
    // FLDENV does not reload the register file; only the tag word changes.
    for (let i = 0; i < 8; i++)
      assert.ok(
        cpu.x87.values[i].every((byte) => byte === 0x11 * i),
        `R${i} contents stay stale after FLDENV`,
      );
  } finally {
    cpu.dispose();
  }
});
