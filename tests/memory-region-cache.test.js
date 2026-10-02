import test from 'node:test';
import assert from 'node:assert/strict';
import { GuestMemory } from '../src/memory.js';

function fixture() {
  const memory = new WebAssembly.Memory({ initial: 16 });
  const regions = [0x11000, 0x32000, 0x75000].map((start) => ({
    start,
    end: start + 4096,
    read: true,
    write: true,
    exec: false,
  }));
  const writes = [];
  const guest = new GuestMemory(memory, regions, {
    onCodeWrite: (address, size) => writes.push([address, size]),
  });
  regions.forEach((r, i) => guest.write32(r.start, 100 + i));
  return { guest, regions, writes };
}

test('alternating mapped accesses honor replacement, removal and shifted region indices', () => {
  const { guest, regions } = fixture();
  const addresses = regions.map((r) => r.start);
  for (let i = 0; i < 24; i++) assert.equal(guest.read32(addresses[i % 3]), 100 + (i % 3));
  // A protection change replaces an entry already warmed by alternating reads.
  regions[0] = { ...regions[0], write: false };
  assert.throws(() => guest.write32(addresses[0], 999), /write violation/);
  assert.equal(guest.read32(addresses[0]), 100);
  regions[1] = { ...regions[1], read: false, write: false };
  assert.throws(() => guest.read32(addresses[1]), /read violation/);
  regions.splice(1, 1);
  assert.equal(guest.read32(addresses[2]), 102, 'shifting the surviving entry is safe');
  assert.throws(() => guest.read32(addresses[1]), /read violation/);
  regions.unshift({ start: 0x4000, end: 0x5000, read: true, write: true });
  guest.write32(0x4000, 123);
  assert.equal(guest.read32(0x4000), 123);
  assert.equal(guest.read32(addresses[2]), 102);
});

test('cached permissions and bounds are rechecked after in-place region changes', () => {
  const { guest, regions } = fixture();
  guest.read32(regions[0].start);
  guest.read32(regions[2].start);
  regions[0].write = false;
  assert.throws(() => guest.write32(regions[0].start, 0), /write violation/);
  regions[0].read = false;
  assert.throws(() => guest.read32(regions[0].start), /read violation/);
  const oldStart = regions[2].start;
  regions[2].start += 4;
  assert.throws(() => guest.read32(oldStart), /read violation/);
  regions[2].end = regions[2].start + 4;
  assert.throws(() => guest.read32(regions[2].start + 2), /read violation/);
});

test('page-cache collisions cannot grant access to holes or the wrong mapping', () => {
  const { guest, regions } = fixture();
  const collision = {
    start: regions[0].start + 0x40000,
    end: regions[0].end + 0x40000,
    read: true,
    write: false,
  };
  regions.push(collision);
  new DataView(guest.memory.buffer).setUint32(collision.start, 900, true);
  for (let i = 0; i < 20; i++) {
    assert.equal(guest.read32(regions[0].start), 100);
    assert.equal(guest.read32(collision.start), 900);
    assert.throws(() => guest.write32(collision.start, 0), /write violation/);
    assert.throws(() => guest.read32(collision.end), /read violation/);
  }
  assert.throws(() => guest.checkLinear(-1, 8), /read violation/);
  assert.throws(() => guest.checkLinear(collision.start, NaN), /read violation/);
});

test('cached executable writes still notify invalidation and adjacent mappings retain exact checks', () => {
  const { guest, regions, writes } = fixture();
  regions[0] = { ...regions[0], exec: true };
  for (let i = 0; i < 3; i++) {
    guest.read32(regions[2].start);
    guest.write32(regions[0].start + i * 4, i);
  }
  assert.deepEqual(writes, [
    [0x11000, 4],
    [0x11004, 4],
    [0x11008, 4],
  ]);
  regions.push({ start: regions[2].end, end: regions[2].end + 4096, read: true, write: false });
  assert.equal(guest.checkLinear(regions[2].end - 2, 4), regions[2].end - 2);
  assert.throws(() => guest.checkLinear(regions[2].end - 2, 4, true), /write violation/);
  assert.equal(guest.checkLinear(regions[2].end + 4096, 0), regions[2].end + 4096);
});
