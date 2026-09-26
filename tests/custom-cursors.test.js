import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { cursorApis } from '../src/win32-cursors.js';
import { readPEResource } from '../src/pe-resources.js';
import {
  parseGroupCursor,
  cursorCandidate,
  selectCursor,
  decodeCursorResource,
} from '../src/cursor-resources.js';
const exe = new Uint8Array(
    await readFile(new URL('./fixtures/custom-cursors/cursors.exe', import.meta.url)),
  ),
  dll = new Uint8Array(
    await readFile(new URL('./fixtures/custom-cursors/cursors.dll', import.meta.url)),
  );
const entries = (name) =>
  parseGroupCursor(readPEResource(exe, 12, name)).map((e) =>
    cursorCandidate(readPEResource(exe, 1, e.id), e),
  );
const call = (r, n, args = []) => cursorApis['user32.dll!' + n](r, (i) => args[i] ?? 0);
const setup = (emit) =>
  new Runtime(iced, {
    files: new Map([
      ['cursors.exe', exe],
      ['cursors.dll', dll],
    ]),
    exe: 'cursors.exe',
    emit,
  });

test('cursor group selection uses actual bitmap depth and scales images and hotspots', () => {
  for (const [name, bits] of [
    [101, 1],
    ['FOUR', 4],
    ['EIGHT', 8],
    ['TRUECOLOR', 24],
    ['ALPHA', 32],
  ]) {
    const e = selectCursor(entries(name)),
      image = decodeCursorResource(e.resource, e);
    assert.equal(e.bitCount, bits);
    assert.deepEqual([image.width, image.height, image.hotX, image.hotY], [32, 32, 3, 5]);
    assert.ok(image.pixels.some((n, i) => i % 4 === 3 && n === 255));
    assert.ok(image.pixels.some((n, i) => i % 4 === 3 && n === 0));
  }
  const multi = selectCursor(entries('MULTI'));
  assert.deepEqual([multi.width, multi.height, multi.bitCount], [32, 32, 4]);
  assert.deepEqual(
    [
      decodeCursorResource(multi.resource, multi).hotX,
      decodeCursorResource(multi.resource, multi).hotY,
    ],
    [5, 7],
  );
  const small = selectCursor(entries('SMALL')),
    image = decodeCursorResource(small.resource, small);
  assert.deepEqual([image.hotX, image.hotY], [4, 6]);
  for (let y = 0; y < 32; y += 2)
    for (let x = 0; x < 32; x += 2) {
      const at = (y * 32 + x) * 4;
      assert.deepEqual(image.pixels.slice(at, at + 4), image.pixels.slice(at + 4, at + 8));
      assert.deepEqual(image.pixels.slice(at, at + 4), image.pixels.slice(at + 128, at + 132));
    }
  const blank = selectCursor(entries('BLANK'));
  assert.ok(decodeCursorResource(blank.resource, blank).pixels.every((n) => n === 0));
  const big = entries('MULTI').at(-1),
    down = decodeCursorResource(big.resource, big);
  assert.deepEqual([down.width, down.height, down.hotX, down.hotY], [32, 32, 4, 6]);
  assert.deepEqual(selectCursor([big]), big);
});

test('cursor resource validation rejects broken headers, ranges, hotspots and destination XOR', () => {
  const e = entries(101)[0],
    b = e.resource.slice();
  assert.throws(() => parseGroupCursor(new Uint8Array(5)), /Invalid/);
  const group = readPEResource(exe, 12, 101);
  group[2] = 1;
  assert.throws(() => parseGroupCursor(group), /Invalid/);
  assert.throws(() => cursorCandidate(b, { ...e, bytes: b.length + 1 }), /size/);
  assert.throws(() => cursorCandidate(b, { ...e, width: 16 }), /dimensions/);
  assert.throws(() => decodeCursorResource(b.subarray(0, 43)), /Invalid/);
  b[0] = 32;
  assert.throws(() => decodeCursorResource(b, e), /hotspot/);
  b[0] = 3;
  // Top-left is transparent. A set XOR bit would invert the backdrop rather
  // than produce a transparent RGBA pixel, which CSS image cursors cannot do.
  b[4 + 40 + 8 + 31 * 4] |= 0x80;
  assert.throws(() => decodeCursorResource(b, e), /XOR.*unsupported/);
  const alpha = entries('ALPHA')[0],
    a = alpha.resource.slice();
  a[a.length - 128] = 0xff; // Alpha-bearing bitmap ignores AND mask.
  const image = decodeCursorResource(a, alpha);
  assert.equal(image.pixels[(31 * 32 + 1) * 4 + 3], 128);
});

test('cursor A/W resource handles are module-local, cached and do not expose mutable stored pixels', () => {
  const messages = [],
    r = setup((m) => messages.push(m));
  try {
    const name = r.allocate(16);
    r.data.set(new TextEncoder().encode('FOUR\0'), name);
    const first = call(r, 'LoadCursorA', [0x400000, name]).result;
    assert.ok(first);
    assert.equal(call(r, 'LoadCursorA', [0x400000, name]).result, first);
    const missing = call(r, 'LoadCursorA', [0x400000, 999]);
    assert.equal(missing.result, 0);
    assert.equal(r.lastError, 1814);
    assert.equal(call(r, 'LoadCursorA', [0xdead0000, 101]).result, 0);
    assert.equal(r.lastError, 6);
    call(r, 'SetCursor', [first]);
    const expected = messages.at(-1).image.pixels.slice();
    messages.at(-1).image.pixels.fill(0);
    call(r, 'ShowCursor', [0]);
    call(r, 'ShowCursor', [1]);
    assert.deepEqual(messages.at(-1).image.pixels, expected);
    const count = messages.length;
    call(r, 'SetCursor', [first]);
    assert.equal(messages.length, count);
  } finally {
    r.cpu.dispose();
  }
});

test('native PE32 loads custom EXE/DLL cursors and uses class callbacks, overrides and visibility', async () => {
  const events = [];
  let queued = false;
  const r = setup((event) => {
    if (event.type === 'cursor') events.push(event);
    if (event.type === 'window' && event.window.visible && !queued) {
      queued = true;
      const windowId = event.window.id;
      r.windows.input({ windowId, type: 'mousemove', x: 10, y: 10, buttons: 0 });
      for (const key of ['2', '3', '4', '5', '6', '7', '8', 'D', 'H', 'S', 'N', 'R'])
        r.windows.input({ windowId, type: 'keydown', key, keyCode: key.charCodeAt(0) });
      r.windows.input({ windowId, type: 'close' });
    }
  });
  const result = await r.run();
  assert.equal(result.exitCode, 0, 'native C line ' + result.exitCode);
  assert.ok(events.some((e) => e.image?.hotX === 5 && e.image?.hotY === 7));
  assert.ok(events.some((e) => e.image?.hotX === 4 && e.image?.hotY === 6));
  assert.ok(events.some((e) => e.image && e.image.pixels.every((n) => n === 0)));
  assert.ok(events.some((e) => e.css === 'none'));
  assert.equal(events.at(-1).css, 'default');
  assert.equal(r.windows.windows.size, 0);
});
