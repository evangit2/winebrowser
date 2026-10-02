import { GuestMemory } from '../src/memory.js';
const memory = new WebAssembly.Memory({ initial: 32 });
const regions = Array.from({ length: 128 }, (_, i) => ({
  start: (i + 1) * 8192,
  end: (i + 1) * 8192 + 4096,
  read: true,
  write: true,
  exec: false,
}));
const guest = new GuestMemory(memory, regions);
const addresses = [regions[13].start, regions[71].start, regions[107].start, regions[127].start];
for (let j = 0; j < addresses.length; j++) guest.write32(addresses[j], j + 11);
for (let run = 0; run < 4; run++) {
  const start = performance.now();
  let sum = 0;
  for (let i = 0; i < 2000000; i++) sum += guest.read32(addresses[i & 3]);
  console.log(JSON.stringify({ run, milliseconds: performance.now() - start, sum }));
}
