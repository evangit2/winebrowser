import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { unpackPackage } from '../src/package.js';
import { Runtime } from '../src/runtime.js';
import { parsePE } from '../src/pe.js';

test('loads guest DLL imports, ordinals, forwarders, relocations, and callback', async () => {
  const archive = new Uint8Array(
    await readFile(new URL('./fixtures/modules/modules.zip', import.meta.url)),
  );
  const pkg = await unpackPackage(archive, 'modules.zip');
  assert.deepEqual(pkg.executables, ['app.exe']);
  const runtime = new Runtime(iced, { files: pkg.files, exe: 'app.exe' });

  const forward = runtime.graph.modules.get('forward.dll');
  const math = runtime.graph.modules.get('math.dll');
  assert.ok(forward && math);
  assert.equal(forward.pe.preferredImageBase, 0x10000000);
  assert.equal(math.pe.preferredImageBase, 0x10000000);

  const forwardExport = forward.pe.exports.find((entry) => entry.name === 'ForwardSum');
  assert.equal(forwardExport.forwarder, 'math.sum');
  const forwarded = runtime.graph.resolve(forward, 'ForwardSum');
  assert.equal(forwarded.module, math);
  assert.equal(
    runtime.graph.address(forwarded),
    math.base + math.pe.exports.find((entry) => entry.name === 'sum').rva,
  );
  assert.equal(
    runtime.graph.resolve(math, 1).rva,
    math.pe.exports.find((entry) => entry.ordinal === 1).rva,
  );

  const result = await runtime.run();
  assert.equal(result.exitCode, 0);
  const mapped = new Map(result.modules.map((module) => [module.name, module]));
  assert.equal(mapped.get('math.dll').preferredBase, 0x10000000);
  assert.equal(mapped.get('forward.dll').preferredBase, 0x10000000);
  assert.notEqual(mapped.get('math.dll').base, mapped.get('forward.dll').base);
  assert.notEqual(mapped.get('math.dll').base, 0x10000000);
  assert.notEqual(mapped.get('forward.dll').base, 0x10000000);
  assert.equal(mapped.get('math.dll').initialized, true);
  assert.equal(mapped.get('forward.dll').initialized, true);
});

async function dynamicRuntime(mathBytes) {
  const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
  const builtins = new Map();
  for (const name of ['math.dll', 'forward.dll'])
    builtins.set(
      name,
      name === 'math.dll' && mathBytes
        ? mathBytes
        : new Uint8Array(await readFile('tests/fixtures/modules/' + name)),
    );
  return new Runtime(iced, {
    files: new Map([['console.exe', exe]]),
    exe: 'console.exe',
    builtinFiles: builtins,
  });
}

test('dynamic forwarded export maps and initializes its dependency before returning a callable address', async () => {
  const r = await dynamicRuntime();
  await r.initializeModules();
  await r.loadLibrary('forward.dll');
  assert.equal(r.graph.modules.has('math.dll'), false);
  const forward = r.graph.modules.get('forward.dll');
  const name = r.allocString('ForwardSum');
  const resolved = await r.apiProvider.get('kernel32.dll!GetProcAddress')(
    r,
    (i) => [forward.base, name][i],
  );
  const math = r.graph.modules.get('math.dll');
  assert.ok(math.mapped && math.initialized);
  assert.ok(resolved.result >= math.base);
  assert.equal(await r.callGuest(resolved.result, [17, 25], 'cdecl'), 42);
});

test('rejected native DllMain rolls back mapping and repeated loads both fail', async () => {
  const bytes = new Uint8Array(await readFile('tests/fixtures/modules/math.dll'));
  const pe = parsePE(bytes, { allowDll: true });
  const section = pe.sections.find(
    (s) => pe.entryPointRva >= s.rva && pe.entryPointRva < s.rva + s.rawSize,
  );
  // Replace only the test DLL entry with native x86 `xor eax,eax; ret 12`.
  bytes.set([0x31, 0xc0, 0xc2, 12, 0], section.rawOffset + pe.entryPointRva - section.rva);
  const r = await dynamicRuntime(bytes),
    regions = r.regions.length;
  const dllName = r.allocString('math.dll');
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await r.apiProvider.get('kernel32.dll!LoadLibraryA')(r, () => dllName);
    assert.equal(result.result, 0);
    assert.equal(r.lastError, 1114);
    assert.equal(r.graph.modules.has('math.dll'), false);
    assert.equal(r.regions.length, regions);
  }
  // A failed load must not poison unrelated subsequent dynamic loads.
  assert.ok(await r.loadLibrary('forward.dll'));
});
