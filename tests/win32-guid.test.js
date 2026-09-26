import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { comApis } from '../src/win32-com.js';
import { registryApis } from '../src/win32-registry.js';
import { readGuid } from '../src/com.js';

const files = new Map([
  ['client.exe', new Uint8Array(await readFile('tests/fixtures/com/client.exe'))],
]);
const setup = () => new Runtime(iced, { files, exe: 'client.exe' });
const call = (r, name, args = []) => comApis['ole32.dll!' + name](r, (i) => args[i] ?? 0);
const text = '{9a5bF010-1234-4321-8234-102030405060}';
const expected = [
  0x10, 0xf0, 0x5b, 0x9a, 0x34, 0x12, 0x21, 0x43, 0x82, 0x34, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60,
];
const CLASSSTRING = 0x800401f3,
  IIDSTRING = 0x800401f4,
  INVALIDARG = 0x80070057;

function register(r, name, value, root = 0x80000000, type = 1) {
  const api = (name, args) => registryApis['advapi32.dll!' + name](r, (i) => args[i] ?? 0);
  const out = r.allocate(4),
    keyName = r.allocString(
      (root === 0x80000000 ? '' : 'Software\\Classes\\') + name + '\\CLSID',
      true,
    );
  assert.equal(api('RegCreateKeyExW', [root, keyName, 0, 0, 0, 2, 0, out]).result, 0);
  const key = r.read32(out),
    data = r.allocString(value, true);
  assert.equal(api('RegSetValueExW', [key, 0, 0, type, data, (value.length + 1) * 2]).result, 0);
  assert.equal(api('RegCloseKey', [key]).result, 0);
  for (const p of [out, keyName, data]) r.free(p);
}

test('GUID conversion preserves mixed-case hex, native field byte order, guards and last error without COM initialization', () => {
  const r = setup(),
    out = r.allocate(18),
    input = r.allocString(text, true);
  r.data.fill(0xaa, out, out + 18);
  r.lastError = 0x1234abcd;
  for (const name of ['CLSIDFromString', 'IIDFromString']) {
    assert.deepEqual(call(r, name, [input, out + 1]), { result: 0, argc: 2 });
    assert.deepEqual([...r.data.subarray(out + 1, out + 17)], expected);
    assert.equal(r.data[out], 0xaa);
    assert.equal(r.data[out + 17], 0xaa);
    assert.equal(r.lastError, 0x1234abcd);
    assert.equal(call(r, name, [0, out + 1]).result, 0);
    assert.deepEqual([...r.data.subarray(out + 1, out + 17)], Array(16).fill(0));
    assert.equal(call(r, name, [input, 0]).result, INVALIDARG);
  }
});

test('CLSID malformed fields retain native partial output; IID length/brace errors leave output intact', () => {
  const r = setup(),
    out = r.allocate(16);
  const parse = (value, name = 'CLSIDFromString') => {
    r.data.fill(0xcc, out, out + 16);
    return call(r, name, [r.allocString(value, true), out]).result;
  };
  for (const value of [text + 'junk', text.slice(0, -1), text.slice(0, -1) + '!']) {
    assert.equal(parse(value), CLASSSTRING);
    assert.deepEqual([...r.data.subarray(out, out + 16)], expected);
  }
  assert.equal(parse('{9a*'), CLASSSTRING);
  assert.equal(r.read32(out), 0x9a);
  assert.deepEqual([...r.data.subarray(out + 4, out + 16)], Array(12).fill(0xcc));
  assert.equal(parse(text.slice(0, 9) + '*' + text.slice(10)), CLASSSTRING);
  assert.equal(r.read32(out), 0x9a5bf010);
  assert.equal(r.read32(out + 4), 0xcccccccc);
  for (const value of ['', text.slice(1), 'Unregistered.Component']) {
    assert.equal(parse(value), CLASSSTRING);
    assert.deepEqual([...r.data.subarray(out, out + 16)], Array(16).fill(0));
  }
  for (const value of [text + 'junk', text.slice(0, -1), 'ProgID']) {
    assert.equal(parse(value, 'IIDFromString'), INVALIDARG);
    assert.deepEqual([...r.data.subarray(out, out + 16)], Array(16).fill(0xcc));
  }
  assert.equal(parse('!' + text.slice(1), 'IIDFromString'), IIDSTRING);
  assert.deepEqual([...r.data.subarray(out, out + 16)], Array(16).fill(0xcc));
  assert.equal(parse(text.slice(0, 20) + 'g' + text.slice(21), 'IIDFromString'), IIDSTRING);
  assert.deepEqual([...r.data.subarray(out, out + 8)], expected.slice(0, 8));
  assert.deepEqual([...r.data.subarray(out + 8, out + 16)], Array(8).fill(0xcc));
  for (let at = 0; at < 38; at++) {
    assert.equal(parse(text.slice(0, at)), CLASSSTRING, `truncated at ${at}`);
    assert.equal(
      parse(text.slice(0, at) + '\uff21' + text.slice(at + 1)),
      CLASSSTRING,
      `non-ASCII at ${at}`,
    );
  }
});

test('CLSID registry fallback sees guest registrations, preserves isolation and does not treat ProgIDs as IIDs', () => {
  for (const root of [0x80000000, 0x80000001, 0x80000002]) {
    const r = setup(),
      out = r.allocate(16),
      input = r.allocString('winebrowser.counter', true);
    register(r, 'WineBrowser.Counter', text, root);
    assert.equal(call(r, 'CLSIDFromString', [input, out]).result, 0);
    assert.equal(readGuid(r, out), text.slice(1, -1).toLowerCase());
    assert.equal(call(r, 'IIDFromString', [input, out]).result, INVALIDARG);
    assert.equal(readGuid(r, out), text.slice(1, -1).toLowerCase());
    const other = setup(),
      otherOut = other.allocate(16);
    assert.equal(
      call(other, 'CLSIDFromString', [other.allocString('WineBrowser.Counter', true), otherOut])
        .result,
      CLASSSTRING,
    );
    for (const value of ['bad', text + 'extra', '\ufeff' + text, text + '\0extra']) {
      register(r, 'WineBrowser.Counter', value, root);
      assert.equal(call(r, 'CLSIDFromString', [input, out]).result, CLASSSTRING);
      assert.deepEqual([...r.data.subarray(out, out + 16)], Array(16).fill(0));
    }
    register(r, 'WineBrowser.Counter', text, root, 3);
    assert.equal(call(r, 'CLSIDFromString', [input, out]).result, CLASSSTRING);
  }
  const r = setup(),
    out = r.allocate(16),
    input = r.allocString('Counter', true);
  register(r, 'Counter', text, 0x80000002);
  register(r, 'Counter', '{00000000-0000-0000-0000-000000000000}', 0x80000001);
  assert.equal(call(r, 'CLSIDFromString', [input, out]).result, 0);
  assert.equal(readGuid(r, out), '00000000-0000-0000-0000-000000000000');
  register(r, 'Counter', text);
  assert.equal(call(r, 'CLSIDFromString', [input, out]).result, 0);
  assert.equal(readGuid(r, out), text.slice(1, -1).toLowerCase());
});

test('StringFromGUID2 writes uppercase UTF-16 and its terminator only when the entire signed capacity fits', () => {
  const r = setup(),
    id = r.allocate(16),
    buffer = r.allocate(82);
  r.data.set(expected, id);
  r.data.fill(0xcc, buffer, buffer + 82);
  r.lastError = 0xbeef;
  for (const count of [0, 1, 38, -1, 0xffffffff, 0x80000000]) {
    assert.deepEqual(call(r, 'StringFromGUID2', [id, buffer + 2, count]), { result: 0, argc: 3 });
    assert.deepEqual([...r.data.subarray(buffer, buffer + 82)], Array(82).fill(0xcc));
  }
  assert.equal(call(r, 'StringFromGUID2', [0, 0, 39]).result, 0);
  assert.equal(call(r, 'StringFromGUID2', [id, buffer + 2, 39]).result, 39);
  assert.equal(r.wideString(buffer + 2), text.toUpperCase());
  assert.deepEqual([...r.data.subarray(buffer, buffer + 2)], [0xcc, 0xcc]);
  assert.deepEqual([...r.data.subarray(buffer + 80, buffer + 82)], [0xcc, 0xcc]);
  assert.equal(r.lastError, 0xbeef);
  for (const count of [39, 0x7fffffff])
    assert.equal(call(r, 'StringFromGUID2', [id, buffer + 2, count]).result, 39);
  for (let i = 0; i < 256; i++) {
    // Independent binary input verifies all bytes survive the text round trip.
    const binary = Uint8Array.from({ length: 16 }, (_, n) => (i + n * 19) & 255);
    r.data.set(binary, id);
    call(r, 'StringFromGUID2', [id, buffer + 2, 39]);
    r.data.fill(0, id, id + 16);
    assert.equal(call(r, 'IIDFromString', [buffer + 2, id]).result, 0);
    assert.deepEqual(r.data.subarray(id, id + 16), binary);
  }
});

test('GUID entry points check guest memory instead of silently truncating writes', () => {
  const r = setup(),
    input = r.allocString(text, true),
    out = r.allocate(16);
  for (const name of ['CLSIDFromString', 'IIDFromString']) {
    assert.throws(() => call(r, name, [input, 0xfffffff8]));
    assert.throws(() => call(r, name, [0xfffffff8, out]));
  }
  call(r, 'CLSIDFromString', [input, out]);
  assert.throws(() => call(r, 'StringFromGUID2', [out, 0xfffffff8, 39]));
  assert.throws(() => call(r, 'StringFromGUID2', [0xfffffff8, input, 39]));
});
