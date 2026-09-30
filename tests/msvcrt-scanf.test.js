import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));

// The scanf family is varargs, so each call pushes its arguments in reverse
// order and a return address last, exactly as a compiled caller would.
async function setup(t, files = {}) {
  const r = new Runtime(iced, {
    files: new Map([['console.exe', exe], ...Object.entries(files)]),
    exe: 'console.exe',
  });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  await r.cpu.initialize();
  const call = async (name, ...args) => {
    const original = r.cpu.r[4].value;
    for (const value of args) r.cpu.push(value);
    r.cpu.push(0x12345678);
    await r.api({ dll: 'msvcrt.dll', name });
    const response = { result: r.cpu.r[0].value | 0, stack: r.cpu.r[4].value };
    r.cpu.r[4].value = original;
    return response;
  };
  return { r, call };
}

test('sscanf assigns integers, strings and floats with the C conversions', async (t) => {
  const { r, call } = await setup(t);
  const input = r.allocString('42 hello 3.5');
  const format = r.allocString('%d %s %f');
  const integer = r.allocate(4),
    text = r.allocate(16),
    real = r.allocate(8);
  const assigned = await call('sscanf', real, text, integer, format, input);
  assert.equal(assigned.result, 3);
  assert.equal(r.read32(integer) | 0, 42);
  assert.equal(r.string(text), 'hello');
  assert.equal(r.view.getFloat64(real, true), 3.5);
});

test('sscanf honours base prefixes, field widths and suppression', async (t) => {
  const { r, call } = await setup(t);
  // %i infers the base from the 0x prefix.
  const hex = r.allocate(4);
  assert.equal((await call('sscanf', hex, r.allocString('%i'), r.allocString('0x1f'))).result, 1);
  assert.equal(r.read32(hex) | 0, 31);
  // Octal for a leading 0.
  assert.equal((await call('sscanf', hex, r.allocString('%i'), r.allocString('0777'))).result, 1);
  assert.equal(r.read32(hex) | 0, 511);
  // A field width bounds the digits read.
  assert.equal((await call('sscanf', hex, r.allocString('%3d'), r.allocString('12345'))).result, 1);
  assert.equal(r.read32(hex) | 0, 123);
  // %*d consumes without storing, so the next conversion still lands.
  const next = r.allocate(4);
  const assigned = await call('sscanf', next, r.allocString('%*d %d'), r.allocString('10 20'));
  assert.equal(assigned.result, 1);
  assert.equal(r.read32(next) | 0, 20);
  // %x and %u are unsigned.
  assert.equal((await call('sscanf', hex, r.allocString('%x'), r.allocString('ff'))).result, 1);
  assert.equal(r.read32(hex) >>> 0, 255);
});

test('sscanf supports %c, the %[ set and %n', async (t) => {
  const { r, call } = await setup(t);
  // %c reads exactly one character and does not terminate.
  const character = r.allocate(4);
  r.data.fill(0xcc, character, character + 4);
  assert.equal(
    (await call('sscanf', character, r.allocString('%c'), r.allocString('A'))).result,
    1,
  );
  assert.equal(r.data[character], 0x41);
  assert.equal(r.data[character + 1], 0xcc, 'no NUL terminator for %c');
  // %[a-z] reads the run of matching characters.
  const word = r.allocate(16);
  assert.equal(
    (await call('sscanf', word, r.allocString('%[a-z]'), r.allocString('abcDEF'))).result,
    1,
  );
  assert.equal(r.string(word), 'abc');
  // %n reports the number of input characters consumed so far. It counts as an
  // assignment, so a suppressed %*d before it keeps a single destination.
  const count = r.allocate(4);
  assert.equal(
    (await call('sscanf', count, r.allocString('%*d%n'), r.allocString('123x'))).result,
    1,
  );
  assert.equal(r.read32(count) | 0, 3);
});

test('sscanf distinguishes a matching failure from an input failure', async (t) => {
  const { r, call } = await setup(t);
  // A matching failure on the very first conversion returns 0, not EOF: the
  // input was present but did not match (C99 7.19.6.2).
  const out = r.allocate(4);
  assert.equal((await call('sscanf', out, r.allocString('%d'), r.allocString('abc'))).result, 0);
  // Empty input is an input failure and reports EOF.
  assert.equal((await call('sscanf', out, r.allocString('%d'), r.allocString(''))).result, -1);
  // A later failure returns the assignments already made, and the first
  // destination still holds its value.
  const assigned = await call('sscanf', out, out, r.allocString('%d %d'), r.allocString('7 x'));
  assert.equal(assigned.result, 1);
  assert.equal(r.read32(out) | 0, 7);
});

test('swscanf scans UTF-16 input and the _sn forms bound the input length', async (t) => {
  const { r, call } = await setup(t);
  const wideInput = r.allocString('88 wide', true);
  const wideFormat = r.allocString('%d %ls', true);
  const number = r.allocate(4),
    text = r.allocate(32);
  const assigned = await call('swscanf', text, number, wideFormat, wideInput);
  assert.equal(assigned.result, 2);
  assert.equal(r.read32(number) | 0, 88);
  assert.equal(r.wideString(text), 'wide');
  // _snscanf(input, maxLength, format, ...): the destinations are pushed first,
  // then the format, the maximum length and the input last.
  const bounded = r.allocate(4);
  assert.equal(
    (await call('_snscanf', bounded, r.allocString('%d'), 2, r.allocString('12345'))).result,
    1,
  );
  assert.equal(r.read32(bounded) | 0, 12);
});

test('fscanf reads the caller stream and advances only past what it consumed', async (t) => {
  const { r, call } = await setup(t, {
    'data.txt': new Uint8Array([...'7 rest'].map((c) => c.charCodeAt(0))),
  });
  const stream = r.allocate(32);
  // Build a real FILE through fopen so the stream table knows it.
  const opened = await r.apiProvider.get('msvcrt.dll!fopen')(
    r,
    (index) => [r.allocString('data.txt'), r.allocString('rb')][index] ?? 0,
  );
  const file = opened.result >>> 0;
  const value = r.allocate(4);
  const assigned = await call('fscanf', value, r.allocString('%d'), file);
  assert.equal(assigned.result, 1);
  assert.equal(r.read32(value) | 0, 7);
  // The position moved past the digits, so a second read sees the space then text.
  const next = r.allocate(8);
  assert.equal((await call('fscanf', next, r.allocString('%s'), file)).result, 1);
  assert.equal(r.string(next), 'rest');
  void stream;
});
