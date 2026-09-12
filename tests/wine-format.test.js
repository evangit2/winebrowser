import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
const dll = new Uint8Array(
  await readFile(new URL('../public/runtime/wine-format.dll', import.meta.url)),
);
const manifest = JSON.parse(
  await readFile(new URL('../runtime/wine-format/manifest.json', import.meta.url)),
);
function setup() {
  return new Runtime(iced, {
    files: new Map([['console.exe', exe]]),
    exe: 'console.exe',
    builtinFiles: new Map([['wine-format.dll', dll]]),
  });
}
async function run(r, format, args, wide = false) {
  const output = r.allocate(2048),
    spec = r.allocString(format, wide),
    va = r.allocate(Math.max(4, args.length * 4));
  args.forEach((value, i) => r.write32(va + i * 4, value));
  const result = await r.apiProvider.get(`user32.dll!wvsprintf${wide ? 'W' : 'A'}`)(
    r,
    (i) => [output, spec, va][i],
  );
  return { result: result.result, text: wide ? r.wideString(output) : r.string(output) };
}
test('Wine formatter binary matches its retained-source manifest and executes as a relocated guest DLL', async () => {
  assert.equal(createHash('sha256').update(dll).digest('hex'), manifest.dllSha256);
  const source = await readFile(new URL('../' + manifest.source, import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), manifest.sourceSha256);
  const r = setup();
  assert.deepEqual(await run(r, '%d %u %08X %%', [-2147483648, 0xffffffff, 0x1234]), {
    result: 33,
    text: '-2147483648 4294967295 00001234 %',
  });
  const module = r.graph.modules.get('wine-format.dll');
  assert.equal(module.host, undefined);
  assert.notEqual(module.base, 0x10000000);
  assert.deepEqual(module.pe.exports.map((e) => e.name).sort(), [...manifest.exports].sort());
  assert.deepEqual(
    module.pe.imports.map((e) => `${e.dll}!${e.name}`).sort(),
    [...manifest.imports].sort(),
  );
  assert.ok(r.cpu.instructions > 0);
});
test('Wine handles precision, alignment, narrow/wide strings and 64-bit integer varargs', async () => {
  const r = setup(),
    ansi = r.allocString('hello'),
    wide = r.allocString('Euro €', true);
  assert.deepEqual(await run(r, '%-7.3s|%ls|%I64u', [ansi, wide, 0xffffffff, 0xffffffff]), {
    result: 35,
    text: 'hel    |Euro €|18446744073709551615',
  });
  assert.deepEqual(await run(r, '%S / %s', [ansi, wide], true), {
    result: 14,
    text: 'hello / Euro €',
  });
});
test('cdecl wsprintf bridge leaves caller arguments on the stack', async () => {
  const r = setup(),
    output = r.allocate(1024),
    spec = r.allocString('Score: %d');
  const original = r.cpu.r[4].value;
  r.cpu.push(42);
  r.cpu.push(spec);
  r.cpu.push(output);
  r.cpu.push(0x12345678);
  const stack = r.cpu.r[4].value;
  assert.equal(await r.api({ dll: 'user32.dll', name: 'wsprintfA' }), 0x12345678);
  assert.equal(r.cpu.r[4].value, stack + 4);
  assert.equal(r.cpu.r[0].value, 9);
  assert.equal(r.string(output), 'Score: 42');
  r.cpu.r[4].value = original;
});

test('Wine retains its 1024-character output limit and terminates the written buffer', async () => {
  const r = setup();
  const result = await run(r, 'x'.repeat(1100), []);
  assert.equal(result.result, 1024);
  assert.equal(result.text, 'x'.repeat(1023));
});
