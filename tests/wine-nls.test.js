import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
const call = (r, name, ...args) => ntServices[name].call(r, (i) => args[i] ?? 0);
async function runtime(nlsFiles) {
  const exe = new Uint8Array(
    await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
  );
  return new Runtime(iced, {
    files: new Map([['console.exe', exe]]),
    exe: 'console.exe',
    nlsFiles,
  });
}
test('Wine NLS maps supplied immutable bytes, returns LCID, and leaves the unused LARGE_INTEGER untouched', async () => {
  const source = new Uint8Array([1, 2, 3, 4, 5]);
  const r = await runtime(new Map([['locale.nls', source]]));
  source.fill(99);
  const out = r.allocate(16);
  r.write32(out + 8, 0x12345678);
  r.write32(out + 12, 0xabcdef01);
  assert.equal(call(r, 'NtInitializeNlsFiles', out, out + 4, out + 8), 0);
  const base = r.read32(out);
  assert.deepEqual([...r.data.slice(base, base + 5)], [1, 2, 3, 4, 5]);
  assert.equal(r.read32(out + 4), 0x409);
  assert.equal(r.read32(out + 8), 0x12345678);
  assert.equal(r.read32(out + 12), 0xabcdef01);
  assert.throws(() => r.write32(base, 0), /write violation/);
  assert.equal(call(r, 'NtUnmapViewOfSection', 0xffffffff, base + 1), 0);
  assert.throws(() => r.read32(base), /read violation/);
  assert.equal(call(r, 'NtUnmapViewOfSection', 0xffffffff, base), 0xc0000019);
});
test('NLS section selection follows Wine type/id statuses and returns page-rounded mapping size', async () => {
  const names = [
    [9, 0, 'sortdefault.nls'],
    [10, 0, 'l_intl.nls'],
    [11, 437, 'c_437.nls'],
    [12, 1, 'normnfc.nls'],
  ];
  const r = await runtime(new Map(names.map(([, , name]) => [name, new Uint8Array(4097).fill(7)])));
  const out = r.allocate(8);
  for (const [type, id] of names) {
    assert.equal(call(r, 'NtGetNlsSectionPtr', type, id, 0xdeadbeef, out, out + 4), 0);
    assert.equal(r.read32(out + 4), 8192);
    assert.equal(r.read32(r.read32(out)), 0x07070707);
  }
  for (const [type, id, status] of [
    [9, 1, 0xc00000ef],
    [10, 1, 0xc0000001],
    [12, 99, 0xc0000034],
    [99, 0, 0xc00000ef],
    [11, 1252, 0xc0000034],
  ])
    assert.equal(call(r, 'NtGetNlsSectionPtr', type, id, 0, out, out + 4), status);
});
test('missing or invalid NLS outputs do not produce bogus maps or overwrite output pointers', async () => {
  const r = await runtime(new Map());
  const out = r.allocate(8);
  r.write32(out, 0x11223344);
  assert.equal(call(r, 'NtInitializeNlsFiles', out, out + 4, 0xffffffff), 0xc0000034);
  assert.equal(r.read32(out), 0x11223344);
  assert.equal(r.read32(out + 4), 0x409);
  assert.equal(call(r, 'NtGetNlsSectionPtr', 9, 0, 0, 0, out), 0xc0000005);
  assert.equal(r.sectionViews.views.size, 0);
  assert.equal(call(r, 'NtQueryDefaultLocale', 1, out), 0);
  assert.equal(r.read32(out), 0x409);
  assert.equal(call(r, 'NtUnmapViewOfSection', 123, 0), 0xc0000008);
});
