import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { unpackPackage } from '../src/package.js';
import { Runtime } from '../src/runtime.js';

async function runtimeWithWineShell32() {
  const archive = new Uint8Array(
    await readFile(new URL('../public/demos/console.zip', import.meta.url)),
  );
  const pkg = await unpackPackage(archive, 'console.zip');
  const shell32 = new Uint8Array(
    await readFile(new URL('../public/runtime/shell32.dll', import.meta.url)),
  );
  const runtime = new Runtime(iced, {
    files: pkg.files,
    exe: pkg.executables[0],
    builtinFiles: new Map([['shell32.dll', shell32]]),
  });
  const preferredBase = 0x10000000;
  await runtime.loadLibrary('shell32.dll');
  const module = runtime.graph.modules.get('shell32.dll');
  assert.ok(module, 'Wine shell32.dll should be loaded as a guest module');
  assert.notEqual(module.base, preferredBase, 'shell32.dll must be relocated into guest memory');
  const target = runtime.graph.resolve(module, 'CommandLineToArgvW');
  assert.equal(target.module, module);
  assert.equal(runtime.graph.address(target), module.base + target.rva);
  assert.ok(
    module.dependencies.some((dependency) => dependency.name === 'kernel32.dll' && dependency.host),
    'Wine imports are connected to the host Win32 boundary',
  );
  assert.equal(runtime.cpu.cache.size, 0, 'loading the DLL should not substitute host parser code');
  return { runtime, address: runtime.graph.address(target) };
}

function readArgv(runtime, pointer, argcPointer) {
  assert.notEqual(pointer, 0, 'Wine should return an argv array');
  const count = runtime.read32(argcPointer);
  assert.ok(count > 0 && count < 128, 'argument count stays within the fixture bounds');
  const argv = [];
  for (let i = 0; i < count; i++) argv.push(runtime.wideString(runtime.read32(pointer + i * 4)));
  assert.equal(runtime.read32(pointer + count * 4), 0, 'argv has a null terminator');
  return argv;
}

async function parseCommandLine(runtime, address, commandLine) {
  const commandPointer = runtime.allocString(commandLine, true);
  const argcPointer = runtime.allocate(4);
  const argvPointer = await runtime.callGuest(address, [commandPointer, argcPointer]);
  return readArgv(runtime, argvPointer, argcPointer);
}

test('Wine CommandLineToArgvW executes as guest code and follows documented quoting rules', async () => {
  const { runtime, address } = await runtimeWithWineShell32();
  const initialCompiledBlocks = runtime.cpu.cache.size;

  // Expected arrays are explicit Windows command-line vectors, independent of
  // the parser implementation under test. Wine's source documents the same
  // rules at third_party/wine/shcore-main.c, beside CommandLineToArgvW.
  const vectors = [
    {
      input: '"C:\\Program Files\\app.exe" "two words" "" plain',
      expected: ['C:\\Program Files\\app.exe', 'two words', '', 'plain'],
    },
    {
      input: String.raw`"C:\Program Files\app.exe" plain \"quoted\" "two\\slashes" "a\\\"b"`,
      expected: ['C:\\Program Files\\app.exe', 'plain', '"quoted"', 'two\\\\slashes', 'a\\"b'],
    },
    {
      input: '"C:\\Program Files\\λ.exe" "猫 🧪"',
      expected: ['C:\\Program Files\\λ.exe', '猫 🧪'],
    },
    {
      input: 'C:\\Program Files\\app.exe --flag',
      expected: ['C:\\Program', 'Files\\app.exe', '--flag'],
    },
  ];

  for (const { input, expected } of vectors)
    assert.deepEqual(await parseCommandLine(runtime, address, input), expected, input);

  assert.ok(
    runtime.cpu.cache.size > initialCompiledBlocks,
    'guest parser instructions were compiled',
  );
});

test('Wine CommandLineToArgvW handles empty input and a null argc pointer', async () => {
  const { runtime, address } = await runtimeWithWineShell32();
  const emptyInput = await parseCommandLine(runtime, address, '');
  assert.deepEqual(emptyInput, ['console\\console.exe']);

  const commandPointer = runtime.allocString('console.exe --ignored', true);
  runtime.lastError = 0;
  const result = await runtime.callGuest(address, [commandPointer, 0]);
  assert.equal(result, 0);
  assert.equal(runtime.lastError, 87, 'Wine calls SetLastError(ERROR_INVALID_PARAMETER)');
});

test('Wine parser export is resolved from the bundled DLL and rejects invalid guest pointers', async () => {
  const { runtime, address } = await runtimeWithWineShell32();
  const module = runtime.graph.modules.get('shell32.dll');
  assert.throws(() => runtime.graph.resolve(module, 'MissingWineExport'), /Missing export/);
  assert.ok(address >= module.base && address < module.base + module.pe.imageSize);
  await assert.rejects(
    runtime.callGuest(address, [0x40000000, runtime.allocate(4)]),
    /Guest read violation/,
  );
});
