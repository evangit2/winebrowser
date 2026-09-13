import test from 'node:test';
import assert from 'node:assert/strict';
import { SectionViews, SectionViewStatus as S } from '../src/section-views.js';
import { GuestMemory } from '../src/memory.js';
import { NTSTATUS, VirtualMemory, VirtualMemoryConstants as VM } from '../src/virtual-memory.js';

function managers(extraRegions = []) {
  const memory = new WebAssembly.Memory({ initial: 736, maximum: 736 });
  const regions = [...extraRegions];
  const virtualMemory = new VirtualMemory(memory, regions);
  const sections = new SectionViews(memory, regions, virtualMemory);
  return { memory, regions, virtualMemory, sections, guest: new GuestMemory(memory, regions) };
}

const sectionRegionAt = (regions, address) =>
  regions.find(
    (region) => region.kind === 'section-view' && address >= region.start && address < region.end,
  );

test('maps an immutable byte snapshot into a read-only page view with a zero tail', () => {
  const { memory, regions, sections, guest } = managers();
  new Uint8Array(memory.buffer).fill(0xa5, VM.arenaStart, VM.arenaStart + VM.pageSize);
  const source = new Uint8Array([0xff, 0x11, 0x22, 0x33, 0x44]);
  const mapped = sections.map(source.subarray(1), { name: 'nls-data' });

  assert.deepEqual(mapped, {
    status: S.SUCCESS,
    base: VM.arenaStart,
    size: 4,
    mappedSize: VM.pageSize,
  });
  source[1] = 0x99;
  assert.deepEqual(
    [guest.read(mapped.base, 1), guest.read(mapped.base + 1, 1), guest.read(mapped.base + 3, 1)],
    [0x11, 0x22, 0x44],
    'input mutation does not change the mapped snapshot',
  );
  assert.equal(guest.read(mapped.base + mapped.size, 1), 0, 'rounded page tail is zero-filled');
  assert.equal(guest.read(mapped.base + VM.pageSize - 1, 1), 0);
  assert.throws(() => guest.write(mapped.base, 0, 1), /write violation/);
  assert.deepEqual(sectionRegionAt(regions, mapped.base), {
    start: mapped.base,
    end: mapped.base + mapped.mappedSize,
    read: true,
    write: false,
    exec: false,
    kind: 'section-view',
  });
});

test('section mappings avoid existing VM reservations and image/region guards', () => {
  const { virtualMemory, sections, regions } = managers();
  const reservation = virtualMemory.allocate(0, VM.pageSize, VM.MEM_RESERVE, VM.PAGE_NOACCESS);
  assert.equal(reservation.base, VM.arenaStart);

  const mapped = sections.map(new Uint8Array([1, 2, 3]));
  assert.equal(mapped.base, VM.arenaStart + VM.allocationGranularity);
  assert.equal(sectionRegionAt(regions, reservation.base), undefined);
  assert.equal(sectionRegionAt(regions, mapped.base).start, mapped.base);

  const guarded = managers([
    {
      start: VM.arenaStart,
      end: VM.arenaStart + VM.pageSize,
      read: false,
      write: false,
      exec: false,
      kind: 'image-reservation',
    },
  ]);
  assert.equal(
    guarded.sections.map(new Uint8Array([7])).base,
    VM.arenaStart + VM.allocationGranularity,
  );
});

test('VM reservations skip section views and VM free cannot release or decommit them', () => {
  const { virtualMemory, sections, regions } = managers();
  const mapped = sections.map(new Uint8Array([0x5a]));
  const reserved = virtualMemory.allocate(0, VM.pageSize, VM.MEM_RESERVE, VM.PAGE_NOACCESS);
  assert.equal(reserved.base, VM.arenaStart + VM.allocationGranularity);
  assert.equal(
    virtualMemory.allocate(mapped.base, VM.pageSize, VM.MEM_RESERVE, VM.PAGE_NOACCESS).status,
    NTSTATUS.CONFLICTING_ADDRESSES,
  );
  assert.equal(
    virtualMemory.free(mapped.base, 0, VM.MEM_RELEASE).status,
    NTSTATUS.MEMORY_NOT_ALLOCATED,
  );
  assert.equal(
    virtualMemory.free(mapped.base, VM.pageSize, VM.MEM_DECOMMIT).status,
    NTSTATUS.MEMORY_NOT_ALLOCATED,
  );
  assert.equal(
    sectionRegionAt(regions, mapped.base).write,
    false,
    'failed VM frees preserve the view',
  );
});

test('unmap accepts an interior and page-tail address, clears bytes, and permits reuse', () => {
  const { memory, virtualMemory, sections, regions, guest } = managers();
  const mapped = sections.map(new Uint8Array([0x12, 0x34, 0x56]));
  assert.equal(guest.read(mapped.base, 1), 0x12);
  assert.equal(sections.unmap(mapped.base + mapped.size), S.SUCCESS);
  assert.equal(sectionRegionAt(regions, mapped.base), undefined);
  assert.equal(new Uint8Array(memory.buffer)[mapped.base], 0);
  assert.equal(new Uint8Array(memory.buffer)[mapped.base + VM.pageSize - 1], 0);
  assert.equal(sections.unmap(mapped.base), S.NOT_MAPPED_VIEW, 'double unmap is reported');

  const reservation = virtualMemory.allocate(0, VM.pageSize, VM.MEM_RESERVE, VM.PAGE_NOACCESS);
  assert.equal(reservation.base, mapped.base, 'the released view range is reusable by VM');
});

test('rejects empty, invalid, overlarge and out-of-capacity view buffers without region changes', () => {
  const { sections, regions } = managers();
  const initialRegionCount = regions.length;
  assert.equal(sections.map(new Uint8Array()).status, S.INVALID_PARAMETER);
  assert.equal(sections.map({ byteLength: 10 }).status, S.INVALID_PARAMETER);
  assert.equal(sections.map(new Uint8Array([1]), { name: 17 }).status, S.INVALID_PARAMETER);
  assert.equal(sections.map(new Uint8Array(VM.arenaEnd - VM.arenaStart + 1)).status, S.NO_MEMORY);
  assert.equal(regions.length, initialRegionCount);
});

test('unmap misses unmapped or out-of-range addresses', () => {
  const { sections } = managers();
  assert.equal(sections.unmap(0), S.NOT_MAPPED_VIEW);
  assert.equal(sections.unmap(VM.arenaEnd), S.NOT_MAPPED_VIEW);
  assert.equal(sections.unmap(-1), S.NOT_MAPPED_VIEW);
});
