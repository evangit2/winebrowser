import test from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/memory.js';

test('bounded write tracing keeps the latest writes after an instruction threshold', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const guest = new GuestMemory(memory, [{ start: 0, end: 65536, read: true, write: true }]);
  let instructions = 0;
  guest.watchAnyRange = [256, 260];
  guest.watchAfterInstructions = 10;
  guest.watchInstructions = () => instructions;
  guest.watchIp = () => instructions * 2;
  guest.watchCallStack = (address) => ({ address });
  for (; instructions < 150; instructions++) guest.write(256, instructions);
  assert.equal(guest.watchEntries.length, 128);
  assert.equal(guest.watchEntries[0].instructions, 22);
  assert.deepEqual(guest.watchEntries.at(-1), {
    address: 256,
    width: 4,
    value: 149,
    ip: 298,
    instructions: 149,
    registers: null,
    context: { address: 256 },
  });
  assert.equal(guest.read(256), 149);
});

test('write observers cover validated scalar and bulk writes, clip overlaps and detach cleanly', () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const guest = new GuestMemory(memory, [{ start: 0, end: 65536, read: true, write: true }]);
  const first = [],
    second = [];
  const detach = guest.observeWrites(256, 16, (start, end) => first.push([start, end]));
  guest.observeWrites(264, 8, (start, end) => second.push([start, end]));
  guest.write(100, 1);
  guest.write(254, 1, 4);
  guest.write32(266, 123);
  guest.check(270, 8, true);
  guest.data.fill(3, 270, 278);
  guest.noteCodeWrite(264, 20); // a bulk writer can report an already checked range
  assert.deepEqual(first, [
    [256, 258],
    [266, 270],
    [270, 272],
    [264, 272],
  ]);
  assert.deepEqual(second, [
    [266, 270],
    [270, 272],
    [264, 272],
  ]);
  detach();
  detach();
  guest.write(256, 0);
  assert.equal(first.length, 4);
  assert.equal(guest.writeObservers.length, 1);
  guest.regions[0] = { start: 0, end: 65536, read: true, write: false };
  assert.throws(() => guest.write(264, 99), /violation/);
  assert.equal(second.length, 3, 'failed writes do not invalidate derived data');
  for (const [start, size, callback] of [
    [-1, 1, () => {}],
    [0, 0, () => {}],
    [65530, 8, () => {}],
    [0, 1, null],
  ])
    assert.throws(() => guest.observeWrites(start, size, callback), /Invalid guest write observer/);
});
