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
