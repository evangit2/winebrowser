import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { debugNtServices } from '../src/wine-debug.js';
import { CONTEXT_BYTES, CONTEXT_OFFSETS, writeContext } from '../src/seh.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
test('Wine first-chance dispatch stages exact exception/context records with the native stack ABI; second-chance and oversized records fail', (t) => {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => r.cpu.dispose());
  const record = r.allocate(80),
    ctx = r.allocate(CONTEXT_BYTES),
    module = {
      base: 0x400000,
      pe: { exports: [{ name: 'KiUserExceptionDispatcher', rva: 0x1000 }] },
    };
  r.graph.modules.set('ntdll.dll', module);
  r.data.fill(0, record, record + 80);
  r.write32(record, 0xe06d7363);
  r.write32(record + 4, 1);
  r.write32(record + 16, 3);
  [0x19930520, 0x1234, 0x5678].forEach((v, i) => r.write32(record + 20 + 4 * i, v));
  writeContext(r.write32.bind(r), ctx, r.cpu, 0x401000, r.cpu.fsBase);
  const saved = r.data.slice(ctx, ctx + CONTEXT_BYTES),
    before = r.cpu.r[4].value >>> 0,
    call = (chance) => debugNtServices.NtRaiseException.call(r, (i) => [record, ctx, chance][i]);
  const result = call(1),
    stack = r.cpu.r[4].value >>> 0;
  assert.equal(result.jumpTo, 0x401000);
  assert.ok(stack < before);
  assert.equal(r.read32(stack), stack + 8);
  assert.equal(r.read32(stack + 4), stack + 88);
  assert.deepEqual(r.data.slice(stack + 8, stack + 88), r.data.slice(record, record + 80));
  assert.deepEqual(r.data.slice(stack + 88, stack + 88 + CONTEXT_BYTES), saved);
  assert.throws(() => call(0), /Unsupported Wine NT exception/);
  r.write32(record + 16, 16);
  assert.equal(call(1), 0xc000000d);
  r.graph.modules.delete('ntdll.dll');
  assert.throws(() => call(1), /Unsupported Wine NT exception/);
});
test('NtContinue restores native registers/flags and transfers to the saved instruction; unsupported APC/xstate paths stay explicit', (t) => {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => r.cpu.dispose());
  const ctx = r.allocate(CONTEXT_BYTES);
  writeContext(r.write32.bind(r), ctx, r.cpu, 0x401000, r.cpu.fsBase);
  r.write32(ctx + CONTEXT_OFFSETS.Eax, 0x12345678);
  r.write32(ctx + CONTEXT_OFFSETS.EFlags, 0x602);
  const call = (alertable) => debugNtServices.NtContinue.call(r, (i) => [ctx, alertable][i]);
  assert.equal(call(1), 0xc00000bb);
  const result = call(0);
  assert.equal(result.jumpTo, 0x401000);
  assert.equal(result.result, 0x12345678);
  assert.equal(r.cpu.df, 1);
  r.write32(ctx, r.read32(ctx) | 0x40);
  assert.equal(call(0), 0xc00000bb);
});
test('original Wine RaiseException dispatches real native SEH handlers and resumes via NtContinue', async (t) => {
  const files = new Map([
      [
        'native-exceptions.exe',
        new Uint8Array(await readFile('tests/fixtures/native-exceptions/native-exceptions.exe')),
      ],
    ]),
    builtinFiles = new Map(),
    nlsFiles = new Map(),
    manifest = JSON.parse(await readFile('runtime/wine-base/manifest.json'));
  for (const row of manifest.dlls)
    builtinFiles.set(
      row.name,
      new Uint8Array(await readFile('public/runtime/wine-base/' + row.path)),
    );
  for (const row of manifest.nls)
    nlsFiles.set(row.name, new Uint8Array(await readFile('public/runtime/wine-base/' + row.path)));
  const r = new Runtime(iced, { files, exe: 'native-exceptions.exe', builtinFiles, nlsFiles });
  t.after(() => r.cpu.dispose());
  const result = await r.run();
  assert.equal(result.exitCode, 0);
  assert.ok(result.apiNames.includes('ntdll.dll!NtRaiseException'));
  assert.ok(result.apiNames.includes('ntdll.dll!NtContinue'));
});
