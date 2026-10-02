import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
const memory = new WebAssembly.Memory({ initial: 1 });
const v = new DataView(memory.buffer);
// A vec3 dot product with the original x87 arithmetic, rounded to float32.
const bytes = Buffer.from(
  'd90500200000d80d10200000d90504200000d80d14200000dec1d90508200000d80d18200000dec1d91d20200000ebcc',
  'hex',
);
bytes[bytes.length - 1] = -bytes.length & 255;
new Uint8Array(memory.buffer).set(bytes, 0x1000);
[1.25, -2, 3.5, 0, 4, 0.5, -1].forEach((x, i) => v.setFloat32(0x2000 + i * 4, x, true));
const cpu = new CPU(iced, {
  memory,
  executableRanges: [[0x1000, 0x1000 + bytes.length]],
  read32: (a) => v.getUint32(a, true),
  write32: (a, x) => v.setUint32(a, x, true),
  check: (a, n) => {
    if ((a >>> 0) + n > 65536) throw Error('range');
    return a >>> 0;
  },
});
await cpu.initialize();
cpu.compile(0x1000);
const synchronousPrepare = cpu.prepare.bind(cpu);
const legacyPrepare = (ip) => {
  const block = cpu.cache.get(ip) ?? cpu.compile(ip);
  if (block.x87) return cpu.initialize();
  cpu.pendingBlock = block;
  return null;
};
const runs = [];
for (const [mode, prepare] of [
  ['repeated-initialization-await', legacyPrepare],
  ['initialized-synchronous-dispatch', synchronousPrepare],
]) {
  const start = performance.now();
  let ip = 0x1000;
  const before = cpu.instructions;
  for (let i = 0; i < 500000; i++) {
    const preparation = prepare(ip);
    if (preparation) await preparation;
    ip = cpu.step(ip);
  }
  runs.push({
    mode,
    elapsedMs: performance.now() - start,
    blocks: 500000,
    instructions: cpu.instructions - before,
    result: v.getFloat32(0x2020, true),
    compiledBytes: cpu.compiledBytes,
  });
}
console.log(
  JSON.stringify(
    {
      date: new Date().toISOString(),
      environment: 'Node ' + process.version,
      scope: 'Exact x87 vec3 arithmetic dispatcher microbenchmark; not full application startup',
      runs,
    },
    null,
    2,
  ),
);
cpu.dispose();
