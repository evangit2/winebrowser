import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

async function dynamicRuntime() {
  const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
  const builtinFiles = new Map();
  for (const name of ['forward.dll', 'math.dll', 'tls.dll'])
    builtinFiles.set(
      name,
      new Uint8Array(
        await readFile(`tests/fixtures/${name === 'tls.dll' ? 'tls' : 'modules'}/${name}`),
      ),
    );
  return new Runtime(iced, {
    files: new Map([['console.exe', exe]]),
    exe: 'console.exe',
    builtinFiles,
  });
}

function exportedAddress(runtime, module, name) {
  const entry = module.pe.exports.find((item) => item.name === name);
  assert.ok(entry, `expected ${name} export`);
  return module.base + entry.rva;
}

test('FreeLibrary balances dynamic references, detaches TLS, unloads, and permits a fresh load', async () => {
  const outputs = [];
  const runtime = await dynamicRuntime();
  runtime.emit = (message) => {
    if (message.type === 'stdout') outputs.push(message.text);
  };
  const initialRegions = runtime.regions.length;
  const initialAllocations = runtime.allocations.size;
  const base = await runtime.loadLibrary('tls.dll');
  const module = runtime.graph.modules.get('tls.dll');
  assert.equal(module.refs, 1);
  assert.equal(module.initialized, true);
  assert.equal(runtime.tls.records.size, 1);
  assert.equal(await runtime.loadLibrary('tls.dll'), base);
  assert.equal(module.refs, 2);

  assert.equal(await runtime.freeLibrary(base), true);
  assert.equal(module.refs, 1);
  assert.equal(
    runtime.graph.modules.get('tls.dll'),
    module,
    'one outstanding reference keeps it mapped',
  );
  assert.equal(runtime.tls.records.size, 1);

  assert.equal(await runtime.freeLibrary(base), true);
  assert.equal(runtime.graph.modules.has('tls.dll'), false);
  assert.equal(runtime.regions.length, initialRegions);
  assert.equal(runtime.allocations.size, initialAllocations);
  assert.equal(runtime.tls.records.size, 0);
  assert.equal(runtime.tls.vector, 0);
  assert.match(
    outputs.join(''),
    /TLS events:123678/,
    'TLS callbacks and DllMain run in detach order before the image is released',
  );

  const reloadedBase = await runtime.loadLibrary('tls.dll');
  assert.notEqual(reloadedBase, base, 'a fresh load receives a fresh mapping');
  assert.equal(runtime.graph.modules.get('tls.dll').initialized, true);
  assert.equal(runtime.tls.records.size, 1);
});

test('FreeLibrary unloads unreferenced forwarded dependencies but preserves startup roots', async () => {
  const runtime = await dynamicRuntime();
  const base = await runtime.loadLibrary('forward.dll');
  const module = runtime.graph.modules.get('forward.dll');
  const address = await runtime.resolveExport(module, 'ForwardSum');
  const math = runtime.graph.modules.get('math.dll');
  assert.ok(math?.initialized);
  assert.equal(await runtime.callGuest(address, [17, 25], 'cdecl'), 42);
  assert.equal(await runtime.freeLibrary(base), true);
  assert.equal(runtime.graph.modules.has('forward.dll'), false);
  assert.equal(runtime.graph.modules.has('math.dll'), false);

  const reloaded = await runtime.loadLibrary('forward.dll');
  assert.notEqual(reloaded, base);
  const reloadedModule = runtime.graph.modules.get('forward.dll');
  const reloadedAddress = await runtime.resolveExport(reloadedModule, 'ForwardSum');
  assert.equal(await runtime.callGuest(reloadedAddress, [19, 23], 'cdecl'), 42);

  // The module fixture's normal executable statically imports both DLLs.
  const archive = new Uint8Array(await readFile('tests/fixtures/modules/modules.zip'));
  const { unpackPackage } = await import('../src/package.js');
  const pkg = await unpackPackage(archive, 'modules.zip');
  const rooted = new Runtime(iced, { files: pkg.files, exe: pkg.executables[0] });
  await rooted.initializeModules();
  const pinned = rooted.graph.modules.get('math.dll');
  const pinnedBase = await rooted.loadLibrary('math.dll');
  assert.equal(pinnedBase, pinned.base);
  assert.equal(await rooted.freeLibrary(pinnedBase), true);
  assert.equal(rooted.graph.modules.get('math.dll'), pinned);
  assert.equal(pinned.initialized, true);
});

test('shell32 forwards ExtractIconA/W and reports a resource-free PE without inventing handles', async () => {
  const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
  const shell32 = new Uint8Array(await readFile('public/runtime/shell32.dll'));
  const runtime = new Runtime(iced, {
    files: new Map([['console.exe', exe]]),
    exe: 'console.exe',
    builtinFiles: new Map([['shell32.dll', shell32]]),
  });
  const base = await runtime.loadLibrary('shell32.dll');
  const shell = runtime.graph.modules.get('shell32.dll');
  const ansiPath = runtime.allocString('console.exe');
  const widePath = runtime.allocString('console.exe', true);
  const builtinAnsiPath = runtime.allocString('shell32.dll');
  const builtinWidePath = runtime.allocString('shell32.dll', true);
  for (const name of ['ExtractIconA', 'ExtractIconW']) {
    const forwarded = await runtime.resolveExport(shell, name);
    const index = name.endsWith('A') ? ansiPath : widePath;
    assert.equal(
      await runtime.callGuest(forwarded, [0, index, 0xffffffff]),
      0,
      'count query returns zero when there are no RT_GROUP_ICON resources',
    );
    assert.equal(
      await runtime.callGuest(forwarded, [0, index, 0]),
      0,
      'resource-free files yield NULL rather than a fabricated HICON',
    );
    const builtinPath = name.endsWith('A') ? builtinAnsiPath : builtinWidePath;
    assert.equal(
      await runtime.callGuest(forwarded, [0, builtinPath, 0xffffffff]),
      0,
      'ExtractIcon can inspect the already-loaded built-in shell32 image',
    );
  }
  assert.ok(base);
});

test('host module handles remain unique after dynamic guest DLL unloads', async () => {
  const runtime = await dynamicRuntime();
  const guestBase = await runtime.loadLibrary('forward.dll');
  const shellBase = await runtime.loadLibrary('winebrowser-shell32.dll');
  assert.notEqual(await runtime.freeLibrary(guestBase), false);
  const winmmBase = await runtime.loadLibrary('winmm.dll');
  assert.notEqual(winmmBase, shellBase);

  const hostBases = [...runtime.graph.modules.values()]
    .filter((module) => module.host)
    .map((module) => module.base);
  assert.equal(
    new Set(hostBases).size,
    hostBases.length,
    'all live host module bases are distinct',
  );

  const checkpoint = runtime.graph.checkpoint();
  const transient = runtime.graph.load('user32.dll', true);
  runtime.graph.restore(checkpoint);
  const retried = runtime.graph.load('user32.dll', true);
  assert.equal(retried.base, transient.base, 'failed-load rollback restores the host-base cursor');
});
