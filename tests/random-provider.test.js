import test from 'node:test';
import assert from 'node:assert/strict';
import { fillGuestEntropy, randomApis } from '../src/win32-random.js';

function setup() {
  const data = new Uint8Array(70000).fill(0xcc),
    view = new DataView(data.buffer);
  return {
    data,
    view,
    lastError: 0,
    check: (pointer, length) => {
      if (pointer < 16 || pointer + length > data.length) throw Error('Guest bounds');
    },
    write32: (pointer, value) => view.setUint32(pointer, value, true),
    string: () => '',
    wideString: () => '',
  };
}
const call = (r, name, args) => randomApis[name](r, (i) => args[i]);
test('entropy fills a prechecked guest range in bounded Web Crypto requests without touching adjacent bytes', () => {
  const r = setup(),
    sizes = [];
  let cursor = 0;
  fillGuestEntropy(r, 32, 65537, {
    getRandomValues: (bytes) => {
      sizes.push(bytes.length);
      for (let i = 0; i < bytes.length; i++) bytes[i] = (cursor++ * 17 + 31) & 255;
    },
  });
  assert.deepEqual(sizes, [65536, 1]);
  for (let i = 0; i < 65537; i++) assert.equal(r.data[32 + i], (i * 17 + 31) & 255);
  assert.ok(r.data.subarray(0, 32).every((byte) => byte === 0xcc));
  assert.ok(r.data.subarray(32 + 65537).every((byte) => byte === 0xcc));
  const original = r.data.slice();
  assert.throws(
    () =>
      fillGuestEntropy(r, 32, 70000, {
        getRandomValues: () => assert.fail('no partial entropy requests'),
      }),
    /bounds/,
  );
  assert.deepEqual(r.data, original);
});
test('ephemeral CSP contexts retain references and errors never create persistent or unsupported providers', () => {
  const r = setup();
  assert.deepEqual(call(r, 'advapi32.dll!CryptAcquireContextW', [16, 0, 0, 1, 0xf0000040]), {
    result: 1,
    argc: 5,
  });
  const handle = r.view.getUint32(16, true);
  assert.equal(call(r, 'advapi32.dll!CryptGenRandom', [handle, 0, 0]).result, 1);
  assert.equal(call(r, 'advapi32.dll!CryptContextAddRef', [handle, 0, 0]).result, 1);
  assert.equal(call(r, 'advapi32.dll!CryptReleaseContext', [handle, 0]).result, 1);
  assert.equal(call(r, 'advapi32.dll!CryptGenRandom', [handle, 7, 32]).result, 1);
  assert.equal(call(r, 'advapi32.dll!CryptReleaseContext', [handle, 0]).result, 1);
  assert.equal(call(r, 'advapi32.dll!CryptGenRandom', [handle, 7, 32]).result, 0);
  assert.equal(r.lastError, 87);
  for (const [type, flags, error] of [
    [1, 0, 0x80090016],
    [99, 0xf0000000, 0x80090014],
    [1, 0xf0000008, 0x80090009],
  ]) {
    const before = r.data.slice(16, 20);
    assert.equal(call(r, 'advapi32.dll!CryptAcquireContextA', [16, 0, 0, type, flags]).result, 0);
    assert.equal(r.lastError, error);
    assert.deepEqual(r.data.slice(16, 20), before);
  }
});
test('system-preferred BCrypt random rejects invalid algorithms and flags without modifying output', () => {
  const r = setup(),
    before = r.data.slice();
  assert.equal(call(r, 'bcrypt.dll!BCryptGenRandom', [1, 32, 7, 2]).result, 0xc0000008);
  assert.equal(call(r, 'bcrypt.dll!BCryptGenRandom', [0, 32, 7, 0]).result, 0xc000000d);
  assert.deepEqual(r.data, before);
  assert.equal(call(r, 'bcrypt.dll!BCryptGenRandom', [0, 0, 0, 2]).result, 0);
  assert.equal(call(r, 'bcrypt.dll!BCryptGenRandom', [0, 32, 7, 2]).result, 0);
  assert.deepEqual(r.data.subarray(0, 32), before.subarray(0, 32));
  assert.deepEqual(r.data.subarray(39), before.subarray(39));
});
