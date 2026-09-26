import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { windowDataApis } from '../src/win32-window-data.js';

const call = (r, name, ...args) => windowDataApis[`user32.dll!${name}`](r, (i) => args[i] ?? 0);
function setup() {
  const windows = new Map(),
    r = {
      lastError: 0,
      windows: {
        windows,
        fail(error, argc) {
          r.lastError = error;
          return { result: 0, argc };
        },
      },
    };
  for (const id of [1, 2])
    windows.set(id, {
      extra: new DataView(new ArrayBuffer(12)),
      userData: 0,
      cls: { wide: false },
      proc: 0x401000,
      parentId: 0,
      style: 0,
      exStyle: 0,
      instance: 0x400000,
      controlId: 0,
      visible: false,
      enabled: true,
    });
  return r;
}

test('Get/SetWindowLong A/W share per-window userdata and byte-addressed extra storage', () => {
  const r = setup();
  r.lastError = 0xaabbccdd;
  assert.deepEqual(call(r, 'SetWindowLongA', 1, -21, 0xfedcba98), { result: 0, argc: 3 });
  assert.deepEqual(call(r, 'GetWindowLongW', 1, -21), { result: 0xfedcba98, argc: 2 });
  assert.equal(call(r, 'GetWindowLongA', 2, -21).result, 0);
  assert.equal(call(r, 'SetWindowLongW', 1, -21, 0).result, 0xfedcba98);
  for (let offset = 0; offset <= 8; offset++) {
    r.windows.windows.get(1).extra = new DataView(new ArrayBuffer(12));
    assert.equal(call(r, 'SetWindowLongA', 1, offset, 0x12345678).result, 0);
    assert.equal(call(r, 'GetWindowLongW', 1, offset).result, 0x12345678);
    assert.deepEqual(
      [...new Uint8Array(r.windows.windows.get(1).extra.buffer)],
      [...Array(offset).fill(0), 0x78, 0x56, 0x34, 0x12, ...Array(8 - offset).fill(0)],
    );
  }
  assert.deepEqual([...new Uint8Array(r.windows.windows.get(2).extra.buffer)], Array(12).fill(0));
  assert.equal(r.lastError, 0xaabbccdd);
});

test('window data bounds and invalid HWNDs fail without changing state or masking unsupported services', () => {
  const r = setup(),
    w = r.windows.windows.get(1);
  const before = [...new Uint8Array(w.extra.buffer)];
  for (const index of [9, 12, 0x7fffffff, -1, -100, 0x80000000]) {
    assert.equal(call(r, 'SetWindowLongW', 1, index, 0xdeadbeef).result, 0);
    assert.equal(r.lastError, 1413);
    assert.equal(call(r, 'GetWindowLongA', 1, index).result, 0);
    assert.equal(r.lastError, 1413);
  }
  assert.deepEqual([...new Uint8Array(w.extra.buffer)], before);
  for (const index of [-4, -8, -16, -20])
    assert.throws(() => call(r, 'SetWindowLongA', 1, index, 0xdeadbeef), /unsupported|require/);
  assert.equal(w.proc, 0x401000);
  assert.equal(w.style, 0);
  assert.equal(w.exStyle, 0);
  assert.equal(w.parentId, 0);
  assert.equal(call(r, 'GetWindowLongA', 1, -4).result, 0x401000);
  assert.throws(() => call(r, 'GetWindowLongW', 1, -4), /unsupported/);
  r.windows.windows.delete(1);
  assert.equal(call(r, 'GetWindowLongA', 1, -21).result, 0);
  assert.equal(r.lastError, 1400);
  assert.equal(call(r, 'SetWindowLongW', 1, 0, 123).result, 0);
  assert.equal(r.lastError, 1400);
});

test('native window callbacks use metadata through creation, A/W calls, controls and teardown', async () => {
  const bytes = new Uint8Array(await readFile('tests/fixtures/window-data/window-data.exe'));
  const r = new Runtime(iced, {
    files: new Map([['window-data.exe', bytes]]),
    exe: 'window-data.exe',
  });
  try {
    assert.equal((await r.run()).exitCode, 0);
  } finally {
    r.windows.dispose();
  }
});
