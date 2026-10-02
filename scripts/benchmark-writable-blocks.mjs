import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { GuestMemory } from '../src/memory.js';
const runs = [];
for (const conservative of [true, false]) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let cpu;
  const guest = new GuestMemory(
    memory,
    [
      { start: 0x1000, end: 0x8000, exec: true, write: true },
      { start: 0x8000, end: 0x10000, write: true },
    ],
    { onCodeWrite: (a, n) => cpu.invalidateRange(a, n) },
  );
  cpu = new CPU(iced, {
    memory,
    executableRanges: [[0x1000, 0x8000, true]],
    read32: (a) => guest.read32(a),
    write32: (a, v) => guest.write32(a, v),
    read: (a, w) => guest.read(a, w),
    write: (a, v, w) => guest.write(a, v, w),
    check: (a, n, w) => guest.check(a, n, w),
  });
  if (conservative) cpu.compile = (ip) => CPU.prototype.compile.call(cpu, ip, true);
  const code = [];
  for (let i = 0; i < 20; i++) code.push(0x40, 0xa3, 0, 0x90, 0, 0);
  code.push(0x49, 0x75, -123 & 255);
  guest.data.set(code, 0x1000);
  cpu.r[1].value = 50000;
  let ip = 0x1000,
    dispatches = 0;
  const start = performance.now();
  while (ip < 0x1000 + code.length) {
    ip = cpu.step(ip);
    dispatches++;
  }
  runs.push({
    mode: conservative ? 'conservative-write-boundary' : 'guarded-writable-block',
    elapsedMs: performance.now() - start,
    dispatches,
    instructions: cpu.instructions,
    compiledBlocks: cpu.compilations,
    value: guest.read32(0x9000),
  });
  cpu.dispose();
}
console.log(JSON.stringify({ date: new Date().toISOString(), runs }, null, 2));
