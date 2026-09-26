import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { DI } from '../src/dinput-errors.js';
import { inputState } from '../src/dinput-device.js';

function guid(r, text) {
  const p = r.allocate(16),
    bytes = text
      .replaceAll('-', '')
      .match(/../g)
      .map((s) => parseInt(s, 16));
  r.data.set(
    [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15].map((i) => bytes[i]),
    p,
  );
  return p;
}
function method(r, p, slot, ...args) {
  return r.thunks.get(r.read32(r.read32(p) + slot * 4)).invoke(r, (i) => [p, ...args][i] >>> 0);
}
async function setup(t) {
  const bytes = new Uint8Array(await readFile('public/demos/console/console.exe'));
  const r = new Runtime(iced, { files: new Map([['console.exe', bytes]]), exe: 'console.exe' });
  t.after(() => r.windows.dispose());
  const out = r.allocate(4),
    iid = guid(r, 'bf798030-483a-4da2-aa99-5d64ed369700');
  r.apiProvider.get('dinput8.dll!DirectInput8Create')(r, (i) => [0x400000, 0x800, iid, out, 0][i]);
  const factory = r.read32(out),
    devices = [];
  for (const id of ['60', '61']) {
    await method(r, factory, 3, guid(r, `6f1d2b${id}-d5a0-11cf-bfc7-444553540000`), out, 0);
    devices.push(r.read32(out));
  }
  for (const id of [42, 43])
    r.windows.windows.set(id, {
      id,
      parentId: 0,
      x: 10,
      y: 20,
      width: 800,
      height: 600,
      style: 0x80000000,
      visible: true,
      enabled: true,
    });
  r.windows.active = 42;
  const input = (event) => r.windows.input({ windowId: 42, ...event });
  const key = (code, up = false, extra = {}) =>
    input({
      type: up ? 'keyup' : 'keydown',
      code,
      keyCode: code.startsWith('Key') ? code.charCodeAt(3) : 17,
      ...extra,
    });
  return { r, mouse: devices[0], keyboard: devices[1], input, key, out };
}
function format(r, fields, size, flags = 2) {
  const array = r.allocate(Math.max(16, fields.length * 16)),
    p = r.allocate(24);
  fields.forEach((field, i) =>
    [field.guid ? guid(r, field.guid) : 0, field.offset, field.type, field.flags ?? 0].forEach(
      (v, j) => r.write32(array + i * 16 + j * 4, v),
    ),
  );
  [24, 16, flags, size, fields.length, array].forEach((v, i) => r.write32(p + i * 4, v));
  return p;
}
const keyFields = [
  { offset: 3, type: 4 | (0x1e << 8) },
  { offset: 1, type: 4 | (0x9d << 8) },
];
const mouseFields = [
  { offset: 8, type: 1 },
  { offset: 0, type: 1 | (1 << 8) },
  { offset: 4, type: 1 | (2 << 8) },
  { offset: 13, type: 4 },
  { offset: 12, type: 4 | (1 << 8) },
  { offset: 14, type: 4 | (2 << 8) },
];
function prop(r, value) {
  const p = r.allocate(20);
  [20, 16, 0, 0, value].forEach((v, i) => r.write32(p + i * 4, v));
  return p;
}
async function read(r, device, size) {
  const p = r.allocate(size + 4);
  r.data.fill(0xcc, p, p + size + 4);
  const result = (await method(r, device, 9, size, p)).result;
  return { p, result, data: [...r.data.subarray(p, p + size)] };
}

test('custom keyboard layout copies descriptors, distinguishes extended keys and ignores repeats', async (t) => {
  const { r, keyboard, key } = await setup(t),
    f = format(r, keyFields, 6);
  assert.equal((await method(r, keyboard, 7)).result, DI.INVALID);
  assert.equal((await method(r, keyboard, 11, f)).result, 0);
  r.data.fill(0, r.read32(f + 20), r.read32(f + 20) + 32);
  assert.equal((await method(r, keyboard, 7)).result, 0);
  assert.equal((await method(r, keyboard, 7)).result, 1);
  assert.equal((await method(r, keyboard, 11, f)).result, DI.ACQUIRED);
  assert.equal((await method(r, keyboard, 25)).result, 1);
  key('KeyA');
  key('ControlRight');
  key('ControlLeft');
  key('KeyA', false, { repeat: true });
  const result = await read(r, keyboard, 6);
  assert.equal(result.result, 0);
  assert.deepEqual(result.data, [0, 128, 0, 128, 0, 0]);
  assert.equal(r.read32(result.p + 6), 0xcccccccc);
  key('KeyA', true);
  key('ControlRight', true);
  assert.deepEqual((await read(r, keyboard, 6)).data, [0, 0, 0, 0, 0, 0]);
  assert.equal((await method(r, keyboard, 8)).result, 0);
  assert.equal((await method(r, keyboard, 8)).result, 1);
  assert.equal((await read(r, keyboard, 6)).result, DI.NOTACQUIRED);
});

test('data format rejects missing/duplicate/out-of-bounds objects and initializes optional POVs', async (t) => {
  const { r, keyboard } = await setup(t);
  const unknown = 'a36d02f2-c9f3-11cf-bfc7-444553540000';
  const fields = [...keyFields, { offset: 4, type: 0x8000ff10, guid: unknown }];
  assert.equal((await method(r, keyboard, 11, format(r, fields, 8))).result, 0);
  await method(r, keyboard, 7);
  assert.deepEqual((await read(r, keyboard, 8)).data, [0, 0, 0, 0, 255, 255, 255, 255]);
  await method(r, keyboard, 8);
  for (const bad of [
    [
      { offset: 3, type: 4 | 0x1e00 },
      { offset: 1, type: 4 | 0x1e00 },
    ],
    [{ offset: 4, type: 4 }],
    [{ offset: 0, type: 1 }],
    [{ offset: 0, type: 4, guid: unknown }],
  ]) {
    assert.equal((await method(r, keyboard, 11, format(r, bad, 4))).result, DI.INVALID);
    assert.equal((await method(r, keyboard, 7)).result, DI.INVALID);
  }
  const huge = format(r, [], 65537);
  assert.equal((await method(r, keyboard, 11, huge)).result, DI.INVALID);
  assert.equal((await method(r, keyboard, 11, 0)).result, DI.POINTER);
});

test('relative mouse deltas reset only after successful reads; buttons and absolute axes persist', async (t) => {
  const { r, mouse, input } = await setup(t);
  await method(r, mouse, 11, format(r, mouseFields, 16));
  await method(r, mouse, 7);
  input({ type: 'mousemove', x: 20, y: 30, movementX: 6, movementY: -3, buttons: 0 });
  input({ type: 'mousedown', x: 20, y: 30, movementX: 0, movementY: 0, buttons: 3, button: 2 });
  input({ type: 'wheel', x: 20, y: 30, wheelDelta: -120, buttons: 3 });
  assert.equal((await read(r, mouse, 15)).result, DI.INVALID);
  const first = await read(r, mouse, 16);
  assert.equal(first.result, 0);
  assert.deepEqual(
    [0, 4, 8].map((o) => r.read32(first.p + o) | 0),
    [-3, -120, 6],
  );
  assert.deepEqual(first.data.slice(12), [128, 128, 0, 0]);
  const second = await read(r, mouse, 16);
  assert.deepEqual(second.data.slice(0, 12), Array(12).fill(0));
  assert.deepEqual(second.data.slice(12), [128, 128, 0, 0]);
  await method(r, mouse, 8);
  assert.equal((await method(r, mouse, 6, 2, prop(r, 0))).result, 0);
  await method(r, mouse, 7);
  const absolute = await read(r, mouse, 16);
  assert.deepEqual(
    [0, 4, 8].map((o) => r.read32(absolute.p + o) | 0),
    [50, -120, 30],
  );
  assert.deepEqual((await read(r, mouse, 16)).data, absolute.data);
});

test('buffered keyboard events use mapped offsets, peek, overflow and flush semantics', async (t) => {
  const { r, keyboard, key } = await setup(t),
    events = r.allocate(80),
    count = r.allocate(4);
  const data = async (n, flags = 0, pointer = events, size = 20) => {
    r.write32(count, n);
    return (await method(r, keyboard, 10, size, pointer, count, flags)).result;
  };
  assert.equal(await data(4), DI.NOTBUFFERED);
  await method(r, keyboard, 11, format(r, keyFields, 6));
  await method(r, keyboard, 6, 1, prop(r, 3));
  assert.equal(await data(4), DI.NOTACQUIRED);
  await method(r, keyboard, 7);
  key('KeyA');
  key('KeyA', false, { repeat: true });
  key('KeyA', true);
  key('ControlRight');
  assert.equal(await data(4, 1), 1);
  assert.equal(r.read32(count), 2);
  assert.deepEqual(
    [0, 4, 16, 20, 24, 36].map((o) => r.read32(events + o)),
    [3, 128, 0xffffffff, 3, 0, 0xffffffff],
  );
  assert.ok(r.read32(events + 32) > r.read32(events + 12));
  assert.equal(await data(1), 1);
  assert.equal(await data(4), 0);
  assert.equal(r.read32(count), 1);
  key('ControlRight', true);
  assert.equal(await data(0xffffffff, 0, 0), 0);
  assert.equal(r.read32(count), 1);
  assert.equal(await data(4), 0);
  assert.equal(r.read32(count), 0);
});

test('foreground loss, browser blur and exclusive acquisition never leave stuck input', async (t) => {
  const { r, keyboard, mouse, key, input } = await setup(t);
  await method(r, keyboard, 11, format(r, keyFields, 6));
  assert.equal((await method(r, keyboard, 13, 0x101, 10)).result, 0);
  assert.equal((await method(r, keyboard, 13, 999, 6)).result, DI.HANDLE);
  assert.equal((await method(r, keyboard, 13, 42, 9)).result, DI.UNSUPPORTED);
  await method(r, keyboard, 13, 42, 6);
  r.windows.active = 43;
  assert.equal((await method(r, keyboard, 7)).result, DI.PRIORITY);
  r.windows.active = 42;
  await method(r, keyboard, 7);
  key('KeyA');
  r.windows.active = 43;
  r.windows.active = 42;
  assert.equal((await read(r, keyboard, 6)).result, DI.NOTACQUIRED);
  await method(r, keyboard, 7);
  assert.equal((await read(r, keyboard, 6)).data[3], 128);
  input({ type: 'app-blur' });
  assert.equal((await method(r, keyboard, 7)).result, DI.PRIORITY);
  input({ type: 'app-focus' });
  await method(r, keyboard, 7);
  assert.deepEqual((await read(r, keyboard, 6)).data, Array(6).fill(0));
  await method(r, mouse, 11, format(r, mouseFields, 16));
  await method(r, mouse, 13, 42, 5);
  await method(r, mouse, 7);
  r.windows.queue.length = 0;
  input({ type: 'mousedown', x: 5, y: 5, buttons: 1, button: 0 });
  assert.equal(r.windows.queue.length, 0, 'exclusive device consumes guest mouse messages');
  assert.equal((await read(r, mouse, 16)).data[13], 128);
});

test('physical keys before device creation are available and property changes preserve acquisition rules', async (t) => {
  const bytes = new Uint8Array(await readFile('public/demos/console/console.exe'));
  const r = new Runtime(iced, { files: new Map([['console.exe', bytes]]), exe: 'console.exe' });
  t.after(() => r.windows.dispose());
  const input = inputState(r);
  input.input({ type: 'keydown', code: 'KeyA' });
  const out = r.allocate(4),
    iid = guid(r, 'bf798030-483a-4da2-aa99-5d64ed369700');
  r.apiProvider.get('dinput8.dll!DirectInput8Create')(r, (i) => [0x400000, 0x800, iid, out, 0][i]);
  const factory = r.read32(out);
  await method(r, factory, 3, guid(r, '6f1d2b61-d5a0-11cf-bfc7-444553540000'), out, 0);
  const device = r.read32(out),
    property = prop(r, 0);
  assert.equal((await method(r, device, 6, 2, property)).result, 0);
  r.write32(property + 16, 123);
  assert.equal((await method(r, device, 5, 2, property)).result, 0);
  assert.equal(r.read32(property + 16), 0);
  await method(r, device, 11, format(r, keyFields, 6));
  await method(r, device, 7);
  assert.equal((await read(r, device, 6)).data[3], 128);
  assert.equal((await method(r, device, 6, 1, prop(r, 32))).result, DI.ACQUIRED);
  await method(r, device, 8);
  await method(r, device, 2);
  assert.equal(input.devices.size, 0);
});
