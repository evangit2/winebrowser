import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import {
  cleanupWineNlsProcess,
  initializeWineNlsProcess,
  NLS_TABLE_INFO_SIZE,
  PEB_NLS_POINTERS,
} from '../src/wine-nls-process.js';

const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
const nlsFiles = () =>
  new Map([
    ['c_1252.nls', Uint8Array.of(0x52, 0x12, 0, 0)],
    ['c_437.nls', Uint8Array.of(0x37, 0x04, 0, 0)],
    ['l_intl.nls', Uint8Array.of(0x44, 0x33, 0x22, 0x11)],
  ]);
const module = {
  base: 0x100000,
  pe: {
    exports: [
      { name: 'RtlInitNlsTables', rva: 0x100 },
      { name: 'RtlResetRtlTranslations', rva: 0x200 },
    ],
  },
};

function runtime(files = new Map()) {
  return new Runtime(iced, {
    files: new Map([['console.exe', exe]]),
    exe: 'console.exe',
    nlsFiles: files,
  });
}

test('NLS bootstrap skips an unsupplied locale and rejects incomplete supplied data', async () => {
  const empty = runtime();
  empty.callGuest = () => {
    throw Error('unexpected guest call');
  };
  assert.deepEqual(await initializeWineNlsProcess(empty, module), {
    initialized: false,
    mappedBases: [],
    previousPointers: [],
  });
  assert.equal(empty.sectionViews.views.size, 0);

  const partial = runtime(new Map([['c_1252.nls', Uint8Array.of(1, 2)]]));
  await assert.rejects(initializeWineNlsProcess(partial, module), /requires c_437\.nls/);
  assert.equal(partial.sectionViews.views.size, 0);
  assert.equal(partial.virtualMemory.reservations.size, 0);
});

test('NLS bootstrap maps read-only files, calls Wine exports, publishes PEB pointers and releases scratch', async () => {
  const r = runtime(nlsFiles());
  assert.equal(NLS_TABLE_INFO_SIZE, 96);
  const calls = [];
  r.callGuest = async (address, args) => {
    calls.push([address, args]);
    if (calls.length === 1) {
      assert.equal(address, module.base + 0x100);
      assert.equal(args.length, 4);
      assert.equal(r.read32(PEB_NLS_POINTERS.ansi), args[0]);
      assert.equal(r.read32(PEB_NLS_POINTERS.oem), args[1]);
      assert.equal(r.read32(PEB_NLS_POINTERS.caseTable), args[2]);
      assert.deepEqual(
        [r.read32(args[0]), r.read32(args[1]), r.read32(args[2])],
        [0x00001252, 0x00000437, 0x11223344],
      );
      r.write32(args[3] + NLS_TABLE_INFO_SIZE - 4, 0xabcdef01);
    } else {
      assert.equal(address, module.base + 0x200);
      assert.deepEqual(args, [calls[0][1][3]]);
      assert.equal(r.read32(args[0] + NLS_TABLE_INFO_SIZE - 4), 0xabcdef01);
    }
  };
  const state = await initializeWineNlsProcess(r, module);
  assert.equal(state.initialized, true);
  assert.equal(calls.length, 2);
  assert.equal(state.mappedBases.length, 3);
  assert.equal(r.virtualMemory.reservations.size, 0);
  for (const base of state.mappedBases) {
    assert.ok(r.sectionViews.views.has(base));
    assert.throws(() => r.write32(base, 0), /write violation/);
  }
  cleanupWineNlsProcess(r, state);
  assert.equal(r.sectionViews.views.size, 0);
  for (const pointer of Object.values(PEB_NLS_POINTERS)) assert.equal(r.read32(pointer), 0);
});

test('NLS bootstrap failure restores PEB pointers and unmaps only its own views', async () => {
  const r = runtime(nlsFiles());
  const unrelated = r.sectionViews.map(Uint8Array.of(9), { name: 'unrelated' });
  assert.equal(unrelated.status, 0);
  for (const pointer of Object.values(PEB_NLS_POINTERS)) r.write32(pointer, 0x12345678);
  let calls = 0;
  r.callGuest = async () => {
    if (++calls === 2) throw Error('guest reset failed');
  };
  await assert.rejects(initializeWineNlsProcess(r, module), /guest reset failed/);
  assert.equal(calls, 2);
  assert.deepEqual([...r.sectionViews.views.keys()], [unrelated.base]);
  assert.equal(r.virtualMemory.reservations.size, 0);
  for (const pointer of Object.values(PEB_NLS_POINTERS))
    assert.equal(r.read32(pointer), 0x12345678);
});
