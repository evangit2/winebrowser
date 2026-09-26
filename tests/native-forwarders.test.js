import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

test('native character forwarders require a real KernelBase component instead of inventing casing results', async () => {
  const bytes = new Uint8Array(
    await readFile(new URL('./fixtures/characters/characters.exe', import.meta.url)),
  );
  const runtime = new Runtime(iced, {
    files: new Map([['characters.exe', bytes]]),
    exe: 'characters.exe',
  });
  await assert.rejects(runtime.run(), /Missing DLL kernelbase.dll/);
  assert.equal(runtime.exitCode, null);
});
