import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { Runtime } from '../src/runtime.js';
import { PROCESS_LAYOUT, initializeThreadLayout } from '../src/process-layout.js';

function machine(t, programs) {
  const memory = new WebAssembly.Memory({ initial: 1 }),
    data = new Uint8Array(memory.buffer),
    view = new DataView(memory.buffer);
  for (const [address, code] of programs) data.set(code, address);
  const cpu = new CPU(iced, {
    memory,
    executableRanges: programs.map(([address, code]) => [address, address + code.length]),
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
  });
  t.after(() => cpu.dispose());
  return { cpu, data, view };
}

test('alternating CPU contexts reuse compiled FS code while isolating stacks, flags, XMM and x87 state', async (t) => {
  const { cpu, view } = machine(t, [
    [0x1000, [0xd9, 0xe8]], // fld1
    [0x1010, [0xd9, 0xee]], // fldz
    [
      0x1020,
      [
        0x64,
        0xa1,
        0x24,
        0,
        0,
        0, // mov eax,fs:[24h]
        0x50,
        0x58, // push eax; pop eax (separate stacks)
        0x64,
        0xa3,
        0x34,
        0,
        0,
        0, // mov fs:[34h],eax
        0x66,
        0x0f,
        0x6e,
        0xd8, // movd xmm3,eax
        0xd8,
        0xc0, // fadd st0,st0
        0xdd,
        0x17, // fst qword [edi]
      ],
    ],
  ]);
  await cpu.initialize();
  const contexts = [];
  for (let n = 0; n < 2; n++) {
    cpu.x87.reset();
    cpu.step(n ? 0x1010 : 0x1000);
    cpu.fsBase = 0x2000 + n * 0x2000;
    cpu.r.forEach((r, i) => (r.value = 100 * n + i));
    cpu.r[4].value = 0x3000 + n * 0x3000;
    cpu.r[7].value = 0x7000 + n * 8;
    cpu.f = { cf: n, zf: 1 - n, sf: n, of: n, pf: 1 - n };
    cpu.af = n;
    cpu.df = n;
    cpu.controlFlags = n ? 0x244000 : 0;
    cpu.simd.mxcsr = n ? 0x7f80 : 0x1f80;
    cpu.x87.control = n ? 0xb7f : 0x37f;
    cpu.simd.registers[7].set([n, n + 1, n + 2, n + 3]);
    view.setUint32(cpu.fsBase + 0x24, n + 11, true);
    contexts.push(cpu.captureContext());
  }
  let compiled;
  for (let round = 1; round <= 20; round++) {
    for (let n = 0; n < 2; n++) {
      const context = contexts[n];
      cpu.restoreContext(context);
      cpu.step(0x1020);
      compiled ??= cpu.cache.get(0x1020);
      assert.equal(cpu.cache.get(0x1020), compiled, 'context switch retains the same Wasm block');
      assert.equal(cpu.r[0].value, n + 11);
      assert.equal(cpu.r[4].value, context.registers[4]);
      assert.equal(view.getUint32(context.registers[4] - 4, true), n + 11);
      assert.equal(view.getUint32(context.fsBase + 0x34, true), n + 11);
      assert.equal(view.getFloat64(0x7000 + n * 8, true), n ? 0 : 2 ** round);
      assert.deepEqual(cpu.f, context.flags);
      assert.equal(cpu.af, context.af);
      assert.equal(cpu.df, context.df);
      assert.equal(cpu.controlFlags, context.controlFlags);
      assert.equal(cpu.simd.mxcsr, context.simd.mxcsr);
      assert.equal(cpu.x87.control, context.x87.control);
      assert.deepEqual([...cpu.simd.registers[3]], [n + 11, 0, 0, 0]);
      assert.deepEqual(cpu.simd.registers[7], context.simd.registers[7]);
      if (round === 1)
        assert.notDeepEqual(
          cpu.simd.registers[3],
          context.simd.registers[3],
          'saved context is an independent copy',
        );
      contexts[n] = cpu.captureContext();
    }
  }
  const instructions = cpu.instructions;
  cpu.restoreContext(contexts[0]);
  assert.equal(cpu.instructions, instructions, 'instruction budget remains process-wide');
  cpu.fsBase = 0;
  assert.throws(() => cpu.step(0x1020), /FS requires guest TEB/);
  assert.equal(cpu.instructions, instructions, 'invalid FS does not execute or count the block');
});

test('cached FS-prefixed string copies read the active TEB and retain independent direction state', (t) => {
  const { cpu, view, data } = machine(t, [[0x1000, [0x64, 0xf3, 0xa4]]]);
  const contexts = [];
  for (let n = 0; n < 2; n++) {
    cpu.fsBase = 0x2000 + n * 0x2000;
    view.setUint32(cpu.fsBase + 0x24, n ? 0x55667788 : 0x11223344, true);
    cpu.df = n;
    cpu.r[1].value = 4;
    cpu.r[6].value = 0x24 + 3 * n;
    cpu.r[7].value = 0x7000 + 0x100 * n + 3 * n;
    contexts.push(cpu.captureContext());
  }
  for (let round = 0; round < 3; round++) {
    for (const context of contexts) {
      cpu.restoreContext(context);
      cpu.step(0x1000);
      assert.equal(cpu.r[1].value, 0);
    }
  }
  assert.equal(cpu.cache.size, 1);
  assert.deepEqual([...data.slice(0x7000, 0x7004)], [0x44, 0x33, 0x22, 0x11]);
  assert.deepEqual([...data.slice(0x7100, 0x7104)], [0x88, 0x77, 0x66, 0x55]);
  assert.equal(contexts[0].registers[1], 4, 'restoring/executing does not mutate a saved context');
  for (const bad of [-1, 1.5, 0x100000000, NaN])
    assert.throws(() => (cpu.fsBase = bad), /Invalid FS base/);
});

test('separate TEB initialization preserves the PEB and main thread while resetting thread-local storage', async (t) => {
  const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.cpu.dispose();
    r.windows.dispose();
  });
  const { peb, teb: mainTeb } = PROCESS_LAYOUT;
  const beforePeb = r.data.slice(peb, peb + 4096),
    beforeMain = r.data.slice(mainTeb, mainTeb + 0x1800);
  const allocation = r.allocate(0x3000),
    teb = Math.ceil(allocation / 4096) * 4096;
  const stackLimit = r.allocate(0x10000),
    stackBase = stackLimit + 0x10000;
  r.data.fill(0xcc, teb, teb + 0x1800);
  const layout = { teb, peb, stackBase, stackLimit, threadId: 7, syscallDispatcher: 0x123456 };
  initializeThreadLayout(r, layout);
  for (const [offset, expected] of [
    [0, 0xffffffff],
    [4, stackBase],
    [8, stackLimit],
    [0x18, teb],
    [0x20, 1],
    [0x24, 7],
    [0x30, peb],
    [0xc0, 0x123456],
    [0x1a8, teb + 0x184],
    [0x188, teb + 0x188],
    [0xbf8, 522 << 16],
    [0xbfc, teb + 0xc00],
  ])
    assert.equal(r.read32(teb + offset), expected);
  for (const offset of [0x2c, 0x34, 0xe10, 0xf94, 0x1000, 0x17fc])
    assert.equal(r.read32(teb + offset), 0);
  assert.deepEqual(r.data.slice(peb, peb + 4096), beforePeb);
  assert.deepEqual(r.data.slice(mainTeb, mainTeb + 0x1800), beforeMain);
  const initialized = r.data.slice(teb, teb + 0x1800);
  for (const invalid of [
    { threadId: 0 },
    { stackLimit: teb },
    { teb: peb },
    { teb: teb + 1 },
    { stackBase: 0x5000000 },
  ]) {
    assert.throws(() => initializeThreadLayout(r, { ...layout, ...invalid }));
    assert.deepEqual(r.data.slice(teb, teb + 0x1800), initialized);
  }
});
