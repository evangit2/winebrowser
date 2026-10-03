import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { packageNeedsNativeBase } from '../src/wine-base-assets.js';
test('native character helpers select Wine before startup even when host names cover their imports', async () => {
  const exe = new Uint8Array(await readFile('tests/fixtures/characters/characters.exe'));
  assert.equal(packageNeedsNativeBase(new Map([['characters.exe', exe]])), true);
});
test('DLL header flags identify extension modules independently of their filename', async () => {
  const dll = new Uint8Array(await readFile('public/examples/lua/lua54.dll'));
  for (const name of ['module.dll', 'module.pyd', 'module.ocx', 'module.bin'])
    assert.equal(packageNeedsNativeBase(new Map([[name, dll]])), true, name);
  assert.equal(packageNeedsNativeBase(new Map([['data.dll', new Uint8Array([1, 2, 3])]])), false);
});
