import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Runtime } from '../src/runtime.js';

const CODE = 0x1000,
  DATA = 0x2000;
const opcodes = [0x58, 0x5c, 0x59, 0x5e, 0x51];
test('native Windows packed SSE fixture executes the complete vector geometry pipeline', async () => {
  const runtime = new Runtime(iced, {
    files: new Map([
      [
        'packed.exe',
        new Uint8Array(await readFile(new URL('./fixtures/sse/packed.exe', import.meta.url))),
      ],
    ]),
    exe: 'packed.exe',
  });
  const result = await runtime.run();
  assert.equal(
    result.exitCode,
    0,
    `Native packed SSE fixture failed at C source line ${result.exitCode}`,
  );
});
function machine(format, op, { memoryOperand = false, alias = false, check } = {}) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const code = [
    ...(format ? [0x66] : []),
    0x0f,
    opcodes[op],
    memoryOperand ? 0x38 : alias ? 0xff : 0xfe,
  ];
  new Uint8Array(memory.buffer).set(code, CODE); // xmm7 <- xmm6/[eax]/xmm7
  const view = new DataView(memory.buffer);
  const cpu = new CPU(iced, {
    memory,
    read32: (a) => view.getUint32(a, true),
    write32: (a, v) => view.setUint32(a, v, true),
    read: (a, n) =>
      n === 1 ? view.getUint8(a) : n === 2 ? view.getUint16(a, true) : view.getUint32(a, true),
    write: (a, v, n) =>
      n === 1
        ? view.setUint8(a, v)
        : n === 2
          ? view.setUint16(a, v, true)
          : view.setUint32(a, v, true),
    check:
      check ??
      ((a, n) => {
        if (a + n > memory.buffer.byteLength) throw Error('range violation');
        return a;
      }),
    executableRanges: [[CODE, CODE + code.length]],
  });
  cpu.r[0].value = DATA;
  return { cpu, view };
}
const vector = (format, values) => {
  const view = new DataView(new ArrayBuffer(16));
  values.forEach((v, i) =>
    format ? view.setBigUint64(i * 8, v, true) : view.setUint32(i * 4, Number(v), true),
  );
  return Array.from(new Uint32Array(view.buffer));
};
const exact = (format, values) => {
  const view = new DataView(new ArrayBuffer(16));
  values.forEach((v, i) =>
    format ? view.setFloat64(i * 8, v, true) : view.setFloat32(i * 4, v, true),
  );
  return Array.from(new Uint32Array(view.buffer));
};

test('packed SSE/SSE2 arithmetic decodes all ten register/memory forms and preserves integer flags', async () => {
  for (const format of [0, 1])
    for (const memoryOperand of [false, true])
      for (const op of [0, 1, 2, 3, 4]) {
        const { cpu, view } = machine(format, op, { memoryOperand });
        const a = [8, -4, 2, -16].slice(0, format ? 2 : 4);
        const b = [4, 4, 1, 16].slice(0, format ? 2 : 4);
        const expected = [
          [12, 0, 3, 0],
          [4, -8, 1, -32],
          [32, -16, 2, -256],
          [2, -1, 2, -1],
          [2, 2, 1, 4],
        ][op].slice(0, format ? 2 : 4);
        cpu.simd.registers[7].set(exact(format, a));
        cpu.simd.registers[6].set(exact(format, b));
        exact(format, b).forEach((v, i) => view.setUint32(DATA + i * 4, v, true));
        cpu.f = { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 };
        cpu.af = 1;
        await cpu.prepare(CODE);
        cpu.step(CODE);
        assert.deepEqual(
          Array.from(cpu.simd.registers[7]),
          exact(format, expected),
          `format=${format} op=${op} memory=${memoryOperand}`,
        );
        assert.deepEqual(cpu.f, { cf: 1, zf: 0, sf: 1, of: 1, pf: 0 });
        assert.equal(cpu.af, 1);
        assert.equal(cpu.simd.mxcsr, 0x1f80);
        cpu.dispose();
      }
});

test('packed arithmetic handles source/destination aliases and square root ignores old destination', async () => {
  for (const format of [0, 1])
    for (const op of [0, 1, 2, 3, 4]) {
      const { cpu } = machine(format, op, { alias: true });
      cpu.simd.registers[7].set(exact(format, format ? [4, 16] : [4, 16, 64, 256]));
      await cpu.prepare(CODE);
      cpu.step(CODE);
      const expected = [
        [8, 32, 128, 512],
        [0, 0, 0, 0],
        [16, 256, 4096, 65536],
        [1, 1, 1, 1],
        [2, 4, 8, 16],
      ][op];
      assert.deepEqual(
        Array.from(cpu.simd.registers[7]),
        exact(format, expected.slice(0, format ? 2 : 4)),
      );
      cpu.dispose();
    }
});

test('packed memory operations preflight all 16 bytes and alignment before MXCSR/destination mutation', async () => {
  for (const format of [0, 1])
    for (const op of [0, 1, 2, 3, 4])
      for (const fault of ['alignment', 'access']) {
        let checked = [];
        const { cpu } = machine(format, op, {
          memoryOperand: true,
          check: (a, n, write) => {
            checked.push([a, n, write]);
            throw Error('denied packed read');
          },
        });
        cpu.r[0].value = DATA + Number(fault === 'alignment');
        cpu.simd.registers[7].set([1, 2, 3, 4]);
        cpu.simd.mxcsr |= 32;
        const before = cpu.simd.snapshot();
        await cpu.prepare(CODE);
        assert.throws(
          () => cpu.step(CODE),
          fault === 'alignment' ? /16-byte alignment/ : /denied packed read/,
        );
        assert.deepEqual(cpu.simd.snapshot(), before);
        assert.deepEqual(checked, fault === 'alignment' ? [] : [[DATA, 16, false]]);
        cpu.dispose();
      }
});

test('packed rounding applies independently to positive/negative lanes in every MXCSR mode', async () => {
  for (const format of [0, 1])
    for (let mode = 0; mode < 4; mode++) {
      const one = format ? 0x3ff0000000000000n : 0x3f800000n,
        sign = format ? 1n << 63n : 1n << 31n;
      const half = format ? 0x3ca0000000000000n : 0x33800000n;
      const { cpu } = machine(format, 0);
      cpu.simd.registers[7].set(
        vector(format, format ? [one, one | sign] : [one, one | sign, one, one | sign]),
      );
      cpu.simd.registers[6].set(
        vector(format, format ? [half, half | sign] : [half, half | sign, half, half | sign]),
      );
      cpu.simd.mxcsr = 0x1f80 | (mode << 13);
      await cpu.prepare(CODE);
      cpu.step(CODE);
      const pair = [one + BigInt(mode === 2), (one | sign) + BigInt(mode === 1)];
      assert.deepEqual(
        Array.from(cpu.simd.registers[7]),
        vector(format, format ? pair : [...pair, ...pair]),
      );
      assert.equal(cpu.simd.mxcsr, 0x1f80 | (mode << 13) | 32);
      cpu.dispose();
    }
});

test('packed exceptions aggregate every lane and preserve the entire destination on unmasked faults', async () => {
  for (const format of [0, 1])
    for (const reverse of [false, true]) {
      const tiny = 1n,
        one = format ? 0x3ff0000000000000n : 0x3f800000n,
        three = format ? 0x4008000000000000n : 0x40400000n;
      const a = [tiny, one],
        b = [three, 0n]; // DE + UE/PE in one lane, ZE in another
      if (reverse) {
        a.reverse();
        b.reverse();
      }
      const { cpu } = machine(format, 3);
      cpu.simd.registers[7].set(vector(format, format ? a : [...a, one, one]));
      cpu.simd.registers[6].set(vector(format, format ? b : [...b, one, three]));
      cpu.simd.mxcsr = 0x1d80 | 8; // ZE unmasked; retain previously sticky overflow
      const before = Array.from(cpu.simd.registers[7]);
      await cpu.prepare(CODE);
      assert.throws(() => cpu.step(CODE), /divide by zero/);
      assert.deepEqual(Array.from(cpu.simd.registers[7]), before);
      assert.equal(cpu.simd.mxcsr, 0x1d80 | 8 | 6); // no new post-computation status
      cpu.dispose();
    }
});

// Run the reference instructions on Linux x86_64 CI. Rosetta can independently
// check masked results locally, but does not deliver unmasked SIMD traps.
const hardware = process.platform === 'linux' && process.arch === 'x64';
const rosetta = process.platform === 'darwin' && process.env.WINEBROWSER_SSE_ORACLE === 'rosetta';
test(
  'packed arithmetic agrees with independent x86 instructions including mixed-lane exception priority',
  { skip: !hardware && !rosetta },
  async () => {
    const temp = mkdtempSync(join(tmpdir(), 'winebrowser-packed-sse-'));
    try {
      const executable = join(temp, 'oracle');
      execFileSync(rosetta ? 'clang' : 'cc', [
        ...(rosetta ? ['-arch', 'x86_64'] : []),
        '-O0',
        '-Wall',
        '-Wextra',
        '-Werror',
        fileURLToPath(new URL('./fixtures/sse/packed-oracle.c', import.meta.url)),
        '-o',
        executable,
      ]);
      const cases = [];
      for (const format of [0, 1]) {
        const sign = format ? 1n << 63n : 1n << 31n;
        const one = format ? 0x3ff0000000000000n : 0x3f800000n,
          three = format ? 0x4008000000000000n : 0x40400000n;
        const inf = format ? 0x7ff0000000000000n : 0x7f800000n;
        const min = format ? 0x10000000000000n : 0x800000n,
          max = inf - 1n;
        const qnan = inf | (format ? 0x8000000000001n : 0x400001n),
          snan = inf | 2n;
        const sets = [
          [
            [one, one | sign],
            [three, three | sign],
          ],
          [
            [1n, sign | 1n],
            [three, three],
          ],
          [
            [min, sign | min],
            [one >> 0n, three],
          ],
          [
            [max, max | sign],
            [three, three],
          ],
          [
            [0n, sign],
            [0n, 0n],
          ],
          [
            [one, 1n],
            [0n, three],
          ],
          [
            [0n, 1n],
            [0n, three],
          ],
          [
            [snan, max],
            [1n, three],
          ],
          [
            [qnan, 1n],
            [snan, three],
          ],
          [
            [inf, inf | sign],
            [inf | sign, inf],
          ],
          [
            [min, one],
            [three, 0n],
          ],
          [
            [one, one | sign],
            [
              format ? 0x3ca0000000000000n : 0x33800000n,
              (format ? 0x3ca0000000000000n : 0x33800000n) | sign,
            ],
          ],
        ];
        const controls = [
          0x1f80,
          0x3f80,
          0x5f80,
          0x7f80,
          0x1fc0,
          0x9f80,
          0x9fc0,
          ...(hardware ? [0x1f00, 0x1e80, 0x1d80, 0x1b80, 0x1780, 0x0f80, 0x1000, 0] : []),
        ];
        for (const op of [0, 1, 2, 3, 4])
          for (const control of controls)
            for (const [a, b] of sets)
              for (const reverse of [false, true]) {
                const left = vector(format, format ? a : [...a, ...a]);
                const right = vector(format, format ? b : [...b, ...b]);
                if (reverse) {
                  const width = format ? 2 : 1;
                  left.push(...left.splice(0, width));
                  right.push(...right.splice(0, width));
                }
                cases.push({ format, op, control, left, right });
              }
      }
      const input =
        cases
          .map(({ format, op, control, left, right }) =>
            [format, op, ...[control, ...left, ...right].map((v) => v.toString(16))].join(' '),
          )
          .join('\n') + '\n';
      const results = execFileSync(executable, {
        input,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      })
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(results.length, cases.length);
      for (let i = 0; i < cases.length; i++) {
        const c = cases[i],
          native = results[i],
          label = JSON.stringify(c);
        const { cpu } = machine(c.format, c.op);
        cpu.simd.registers[7].set(c.left);
        cpu.simd.registers[6].set(c.right);
        cpu.simd.mxcsr = c.control;
        await cpu.prepare(CODE);
        try {
          if (native.trapped) assert.throws(() => cpu.step(CODE), /Unmasked SIMD/, label);
          else cpu.step(CODE);
          assert.deepEqual(Array.from(cpu.simd.registers[7]), native.words, label);
          assert.equal(cpu.simd.mxcsr, native.mxcsr, label);
        } finally {
          cpu.dispose();
        }
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  },
);
