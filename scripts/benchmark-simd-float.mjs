import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { SIMDFloat } from '../src/simd-float.js';
const ref = process.argv.find((a) => a.startsWith('--baseline-ref='))?.split('=')[1];
assert.ok(ref, 'Supply --baseline-ref=<commit> for an independent before/after comparison');
const source = execFileSync('git', ['show', ref + ':src/simd-float.js']);
const { SIMDFloat: Baseline } = await import(
  'data:text/javascript;base64,' + source.toString('base64')
);
const cpu = new CPU(iced, {
  memory: new WebAssembly.Memory({ initial: 1 }),
  read32: () => 0,
  write32() {},
  check: (a) => a >>> 0,
});
await cpu.initialize();
const modes = [
  ['baseline', new Baseline(() => cpu.x87.sf)],
  ['reused-scratch', new SIMDFloat(() => cpu.x87.sf)],
];
const operands = [
  [
    Uint32Array.from([0x3fa00000, 0x40000000, 0x40800000, 0x3f000000]),
    Uint32Array.from([0x40000000, 0x3f800000, 0x3f000000, 0x40800000]),
  ],
  [
    Uint32Array.from([0, 0x3ff40000, 0, 0x40000000]),
    Uint32Array.from([0, 0x40000000, 0, 0x3ff00000]),
  ],
];
const operations = [0, 1, 2, 3, 4, 11, 12, 13];
const samples = 7,
  iterations = 50000;
function run(service, count) {
  let checksum = 0;
  for (let i = 0; i < count; i++) {
    const double = !!(i & 1),
      [a, b] = operands[+double];
    const result = service.packed(operations[(i >>> 1) & 7], double, a, b, (i >>> 4) & 7);
    for (const word of result) checksum = (Math.imul(checksum, 31) + word) | 0;
  }
  return checksum;
}
for (const [, service] of modes) run(service, 10000);
const runs = [];
for (let round = 0; round < samples; round++) {
  for (const [mode, service] of round & 1 ? [...modes].reverse() : modes) {
    const start = performance.now();
    const checksum = run(service, iterations);
    runs.push({
      round,
      mode,
      elapsedMs: performance.now() - start,
      checksum,
      mxcsr: service.mxcsr,
    });
  }
}
assert.equal(new Set(runs.map((r) => r.checksum + ':' + r.mxcsr)).size, 1);
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const baselineMs = median(runs.filter((r) => r.mode === 'baseline').map((r) => r.elapsedMs));
const optimizedMs = median(runs.filter((r) => r.mode === 'reused-scratch').map((r) => r.elapsedMs));
const report = {
  date: new Date().toISOString(),
  environment: 'Node ' + process.version + ' ' + process.platform + '/' + process.arch,
  baselineRef: ref,
  samples,
  vectorsPerSample: iterations,
  scope:
    'Alternating packed binary32/binary64 add/subtract/multiply/divide/sqrt/min/max/comparison service microbenchmark. Includes raw-word lane preparation and allocations; excludes x86 compilation, browser startup and graphics. Samples alternate order after warming both versions; the same pinned SoftFloat module computes both.',
  baselineMedianMs: baselineMs,
  optimizedMedianMs: optimizedMs,
  speedup: baselineMs / optimizedMs,
  runs,
};
if (process.env.SIMD_BENCHMARK_EVIDENCE)
  await writeFile(process.env.SIMD_BENCHMARK_EVIDENCE, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
for (const [, service] of modes) service.dispose();
cpu.dispose();
