import test from 'node:test';
import assert from 'node:assert/strict';
import iced from 'iced-x86';
import { readFile } from 'node:fs/promises';
import { GuestPerformanceClock } from '../src/guest-clock.js';
import { createSharedUserData, SHARED_USER_DATA_ADDRESS as BASE } from '../src/shared-user-data.js';
import { GuestMemory } from '../src/memory.js';
import { CPU } from '../src/cpu.js';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
import { multimediaTimeApis } from '../src/winmm-time.js';

function setup(now = () => 0x123456789abcdefn, systemNow = () => 1234567890123) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const clock = new GuestPerformanceClock(now);
  const guest = new GuestMemory(memory, [{ start: 0, end: 65536, read: true, write: true }], {
    readOnlyViews: [createSharedUserData(clock, systemNow)],
  });
  return { memory, guest, clock };
}
const u64 = (bytes) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);

test('shared data clocks, UTC bias, frequency and processor flags match their independent byte layouts', () => {
  const nanos = 0x123456789abcdefn;
  const { guest, memory } = setup();
  const tick = nanos / 1000000n;
  assert.equal(guest.read32(BASE), Number(tick & 0xffffffffn));
  assert.equal(guest.read32(BASE + 4), 16777216);
  assert.equal(u64(guest.readBytes(BASE + 8, 12)), nanos / 100n);
  assert.equal(u64(guest.readBytes(BASE + 0x320, 12)), tick);
  assert.equal(guest.read32(BASE + 0x324), guest.read32(BASE + 0x328));
  assert.equal(u64(guest.readBytes(BASE + 0x14, 12)), 128790414901230000n);
  assert.deepEqual([...guest.readBytes(BASE + 0x20, 12)], Array(12).fill(0));
  assert.equal(u64(guest.readBytes(BASE + 0x300, 8)), 1000000000n);
  assert.deepEqual(
    [...guest.readBytes(BASE + 0x274, 64)],
    Array.from({ length: 64 }, (_, i) => +(i === 8)),
  );
  assert.equal(guest.read(BASE + 0x301, 1), 0xca);
  assert.equal(guest.read(BASE + 0x301, 2), 0x9aca);
  assert.equal(
    memory.buffer.byteLength,
    65536,
    'high guest addresses consume only their small external view',
  );
});

test('shared KSYSTEM_TIME high-low-high readers detect rollover and the source clock cannot run backward', () => {
  const boundary = 0x100000000n * 1000000n;
  const values = [boundary - 1n, boundary, boundary, boundary];
  const { guest } = setup(() => values.shift() ?? 1n);
  const firstHigh = guest.read32(BASE + 0x324);
  assert.equal(firstHigh, 0);
  assert.equal(guest.read32(BASE + 0x320), 0);
  assert.equal(guest.read32(BASE + 0x328), 1, 'a high-low-high loop sees the change and retries');
  assert.equal(u64(guest.readBytes(BASE + 0x320, 12)), 0x100000000n);
  assert.equal(u64(guest.readBytes(BASE + 0x320, 12)), 0x100000000n);
});

test('external views reject stores, gaps, overflow, boundary crossings and raw linear access', () => {
  const { guest } = setup();
  for (const [address, size] of [
    [BASE - 1, 2],
    [BASE + 0x32f, 2],
    [BASE + 0x2c, 4],
    [BASE + 0x1000, 0],
    [BASE + 0x320, -1],
    [BASE + 0x320, 1.5],
    [0xffffffff, 2],
  ])
    assert.throws(() => guest.readBytes(address, size), /read violation/);
  for (const width of [1, 2, 4])
    assert.throws(() => guest.write(BASE + 0x320, 0, width), /write violation/);
  assert.throws(() => guest.write32(BASE + 0x320, 0), /write violation/);
  assert.throws(() => guest.checkLinear(BASE + 0x320, 4), /read violation/);
  assert.equal(guest.check(BASE + 0x320, 16), BASE + 0x320);
  const copy = guest.readBytes(BASE + 0x300, 8);
  copy.fill(0);
  assert.equal(guest.read32(BASE + 0x300), 1000000000);
});

async function machine(code) {
  const result = setup(() => 0x123456789n * 1000000n);
  result.guest.data.set(code, 0x1000);
  const { memory, guest } = result;
  const cpu = new CPU(iced, {
    memory,
    read: guest.read.bind(guest),
    readBytes: guest.readBytes.bind(guest),
    write: guest.write.bind(guest),
    read32: guest.read32.bind(guest),
    write32: guest.write32.bind(guest),
    check: guest.check.bind(guest),
    executableRanges: [[0x1000, 0x1000 + code.length]],
  });
  await cpu.initialize();
  return { ...result, cpu };
}

test('compiled scalar, SIMD, x87 and REP MOVS reads use external mappings without truncating guest addresses', async () => {
  const code = [
    0xa1,
    0x20,
    0x03,
    0xfe,
    0x7f, // mov eax,[7ffe0320]
    0x0f,
    0x10,
    0x05,
    0x20,
    0x03,
    0xfe,
    0x7f, // movups xmm0,[7ffe0320]
    0xdf,
    0x2d,
    0x20,
    0x03,
    0xfe,
    0x7f, // fild qword [7ffe0320]
    0xdf,
    0x3d,
    0x00,
    0x20,
    0x00,
    0x00, // fistp qword [2000]
    0xf3,
    0xa5, // rep movsd
  ];
  const { cpu, guest } = await machine(code);
  try {
    cpu.r[1].value = 3;
    cpu.r[6].value = BASE + 0x320;
    cpu.r[7].value = 0x2010;
    let ip = 0x1000;
    while (ip < 0x1000 + code.length) ip = cpu.step(ip);
    assert.equal(cpu.r[0].value >>> 0, 0x23456789);
    assert.deepEqual([...cpu.simd.registers[0]], [0x23456789, 1, 1, 0]);
    assert.equal(u64(guest.readBytes(0x2000, 8)), 0x123456789n);
    assert.deepEqual([...guest.readBytes(0x2010, 12)], [...guest.readBytes(BASE + 0x320, 12)]);
  } finally {
    cpu.dispose();
  }
});

test('native shared-data fixture and host/NT clock APIs use the same 64-bit time sources', async () => {
  const exe = new Uint8Array(
    await readFile(new URL('./fixtures/shared-data/shared-data.exe', import.meta.url)),
  );
  const r = new Runtime(iced, {
    files: new Map([['shared-data.exe', exe]]),
    exe: 'shared-data.exe',
    performanceNow: () => 0x123456789n * 1000000n,
    systemNow: () => 1234567890123,
  });
  const out = r.allocate(8);
  assert.equal(
    ntServices.NtQuerySystemTime.call(r, () => out),
    0,
  );
  assert.equal(r.view.getBigUint64(out, true), u64(r.guestMemory.readBytes(BASE + 0x14, 8)));
  const tick = r.apiProvider.get('kernel32.dll!GetTickCount64')(r);
  assert.deepEqual(tick, { result: 0x23456789, resultHigh: 1, argc: 0 });
  assert.equal(r.apiProvider.get('kernel32.dll!GetTickCount')(r).result, 0x23456789);
  assert.equal(multimediaTimeApis['winmm.dll!timeGetTime'](r).result, 0x23456789);
  const result = await r.run();
  assert.equal(result.exitCode, 0, 'native C fixture line ' + result.exitCode);
});
