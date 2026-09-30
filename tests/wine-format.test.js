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

test('msvcrt varargs and va_list entry points use the convention Wine declares', async () => {
  // Wine's msvcrt.spec lists vsprintf/vswprintf as `@ cdecl` and the varargs
  // forms (sprintf/swprintf) as cleaned up by the caller; user32's wvsprintfA/W
  // are `@ stdcall` and pop their own three words. Declaring the wrong one
  // removes stack words that belong to the caller, so each entry point is
  // checked against the stack pointer it is required to leave.
  const r = setup(),
    output = r.allocate(1024),
    spec = r.allocString('n=%d'),
    va = r.allocate(4);
  r.write32(va, 7);
  const original = r.cpu.r[4].value;
  const callDirect = async (name, pushes) => {
    for (const value of pushes) r.cpu.push(value);
    r.cpu.push(0x12345678); // return address
    const stack = r.cpu.r[4].value;
    assert.equal(await r.api({ dll: name.split('!')[0], name: name.split('!')[1] }), 0x12345678);
    const delta = r.cpu.r[4].value - stack;
    return { delta, text: r.string(output) };
  };
  // vsprintf(buffer, format, va_list): cdecl, so no argument words are removed.
  const vsprintf = await callDirect('msvcrt.dll!vsprintf', [va, spec, output]);
  assert.equal(vsprintf.delta, 4, 'a cdecl entry point removes only the return address');
  assert.equal(vsprintf.text, 'n=7');
  // wvsprintfA(buffer, format, va_list): stdcall, so its three words go too.
  const wvsprintf = await callDirect('user32.dll!wvsprintfA', [va, spec, output]);
  assert.equal(wvsprintf.delta, 16, 'a stdcall entry point removes its arguments');
  assert.equal(wvsprintf.text, 'n=7');
  r.cpu.r[4].value = original;
});

test('the bounded printf family applies the CRT size rules through the Wine body', async () => {
  // Each bounded entry point is a guest call: arguments are pushed in reverse and
  // a return address last, so ESP points at it when the thunk runs. The varargs
  // forms and the va_list forms are both exercised, and the reported stack delta
  // proves the cdecl cleanup the caller owns.
  const r = setup(),
    spec = r.allocString('id=%d end');
  const call = async (name, pushes) => {
    const original = r.cpu.r[4].value;
    for (const value of pushes) r.cpu.push(value);
    r.cpu.push(0x12345678);
    const stack = r.cpu.r[4].value;
    await r.api({ dll: 'msvcrt.dll', name });
    const response = { result: r.cpu.r[0].value | 0, delta: r.cpu.r[4].value - stack };
    r.cpu.r[4].value = original;
    return response;
  };

  // _snprintf(buffer, capacity, format, ...) NUL-terminates and returns the length
  // the formatted text would have had, so a caller can size its buffer and retry.
  const wide = r.allocate(64);
  const fits = await call('_snprintf', [12345, spec, 64, wide]);
  assert.equal(fits.result, 12);
  assert.equal(fits.delta, 4, 'cdecl: only the return address is removed');
  assert.equal(r.string(wide), 'id=12345 end');
  const narrow = r.allocate(8);
  const truncated = await call('_snprintf', [12345, spec, 8, narrow]);
  assert.equal(truncated.result, 12, 'the return value is the untruncated length');
  assert.equal(r.string(narrow), 'id=1234', 'the buffer holds capacity-1 characters');

  // sprintf_s(buffer, size, format, ...) must hold the whole result: an
  // undersized buffer is cleared and reported as ERANGE rather than truncated.
  const large = r.allocate(64);
  assert.equal((await call('sprintf_s', [7, spec, 64, large])).result, 8);
  assert.equal(r.string(large), 'id=7 end');
  const small = r.allocate(6);
  r.data.fill(0xcc, small, small + 6);
  assert.equal((await call('sprintf_s', [7, spec, 6, small])).result, 34);
  assert.equal(r.string(small), '', 'an undersized destination is emptied');

  // _snprintf_s(buffer, sizeOfBuffer, count, format, ...) with _TRUNCATE.
  const bounded = r.allocate(64);
  assert.equal((await call('_snprintf_s', [9, spec, 0xffffffff, 64, bounded])).result, 8);
  assert.equal(r.string(bounded), 'id=9 end');

  // vsprintf_s(buffer, size, format, va_list) takes a va_list, which on i386 is a
  // pointer to the first varargs slot.
  const values = r.allocate(4);
  r.write32(values, 3);
  const vaList = r.allocate(64);
  assert.equal((await call('vsprintf_s', [values, spec, 64, vaList])).result, 8);
  assert.equal(r.string(vaList), 'id=3 end');

  // The wide form keeps UTF-16 output and the same size rule.
  const wideSpec = r.allocString('w=%d', true);
  const wideBuffer = r.allocate(64);
  assert.equal((await call('swprintf_s', [5, wideSpec, 32, wideBuffer])).result, 3);
  assert.equal(r.wideString(wideBuffer), 'w=5');
});
