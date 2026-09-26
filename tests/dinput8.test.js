import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { DI } from '../src/dinput8.js';
import { readGuid } from '../src/com.js';

const IA = 'bf798030-483a-4da2-aa99-5d64ed369700',
  IW = 'bf798031-483a-4da2-aa99-5d64ed369700';
const DA = '54d41080-dc15-4833-a41b-748f73a38179',
  DW = '54d41081-dc15-4833-a41b-748f73a38179';
const U = '00000000-0000-0000-c000-000000000046';
const mouse = '6f1d2b60-d5a0-11cf-bfc7-444553540000',
  keyboard = '6f1d2b61-d5a0-11cf-bfc7-444553540000';

test('native DirectInput executable checks stdcall callbacks and A/W COM identity', async () => {
  const bytes = new Uint8Array(await readFile('tests/fixtures/dinput8/dinput8.exe'));
  const r = new Runtime(iced, { files: new Map([['dinput8.exe', bytes]]), exe: 'dinput8.exe' });
  try {
    assert.equal((await r.run()).exitCode, 0);
  } finally {
    r.windows.dispose();
  }
});
async function setup(t) {
  const bytes = new Uint8Array(await readFile('public/demos/console/console.exe'));
  const r = new Runtime(iced, { files: new Map([['console.exe', bytes]]), exe: 'console.exe' });
  t.after(() => r.windows.dispose());
  return r;
}
function guid(r, text) {
  const p = r.allocate(16),
    s = text.replaceAll('-', '');
  const bytes = s.match(/../g).map((s) => parseInt(s, 16));
  r.data.set(
    [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15].map((i) => bytes[i]),
    p,
  );
  return p;
}
const create = (r, ...args) =>
  r.apiProvider.get('dinput8.dll!DirectInput8Create')(r, (i) => args[i] >>> 0);
function method(r, p, slot, ...args) {
  const thunk = r.thunks.get(r.read32(r.read32(p) + slot * 4));
  return thunk.invoke(r, (i) => [p, ...args][i] >>> 0);
}
function factory(r, iid = IA) {
  const p = r.allocate(4);
  assert.deepEqual(create(r, 0x400000, 0x800, guid(r, iid), p, 0), { result: 0, argc: 5 });
  return r.read32(p);
}

test('DirectInput creation validates output, interface and version without leaking objects', async (t) => {
  const r = await setup(t),
    p = r.allocate(4),
    iid = guid(r, IA);
  assert.equal(create(r, 0, 0, 0, 0, 0).result, DI.POINTER);
  for (const [instance, version, expected] of [
    [0, 0x800, DI.INVALID],
    [1, 0, DI.NOTINITIALIZED],
    [1, 0x700, DI.BETA],
    [1, 0x801, DI.OLD],
  ]) {
    r.write32(p, 0xdeadbeef);
    assert.equal(create(r, instance, version, iid, p, 0).result, expected);
    assert.equal(r.read32(p), 0);
  }
  assert.equal(create(r, 0, 0, guid(r, DA), p, 0).result, DI.NOINTERFACE);
  assert.equal(r.comObjects, undefined);
  assert.throws(() => create(r, 1, 0x800, iid, p, 1), /aggregation is unsupported/);
  assert.equal(r.read32(p), 0);
});

test('DirectInput A/W views have common identity, reference counts and correct info encoding', async (t) => {
  const r = await setup(t),
    a = factory(r),
    out = r.allocate(4);
  assert.equal((await method(r, a, 0, guid(r, IW), out)).result, 0);
  const w = r.read32(out);
  assert.notEqual(a, w);
  assert.equal((await method(r, w, 0, guid(r, U), out)).result, 0);
  assert.equal(r.read32(out), a);
  assert.equal((await method(r, a, 2)).result, 2);
  assert.equal((await method(r, w, 2)).result, 1);
  assert.equal((await method(r, a, 3, guid(r, keyboard), out, 0)).result, 0);
  const device = r.read32(out);
  assert.equal((await method(r, a, 2)).result, 1, 'device retains parent lifetime');
  assert.equal((await method(r, device, 0, guid(r, DW), out)).result, 0);
  const deviceW = r.read32(out),
    info = r.allocate(1104);
  r.data.fill(0xa5, info, info + 1104);
  r.write32(info, 1100);
  assert.equal((await method(r, deviceW, 15, info)).result, 0);
  assert.equal(r.wideString(info + 40), 'Keyboard');
  assert.equal(r.wideString(info + 560), 'WineBrowser Keyboard');
  assert.equal(readGuid(r, info + 4), keyboard);
  assert.equal(r.read32(info + 1100), 0xa5a5a5a5);
  r.write32(info, 560);
  assert.equal((await method(r, device, 15, info)).result, 0);
  assert.equal(r.string(info + 40), 'Keyboard');
  r.write32(info, 579);
  assert.equal((await method(r, device, 15, info)).result, DI.INVALID);
  assert.equal((await method(r, deviceW, 2)).result, 1);
  assert.equal((await method(r, device, 2)).result, 0);
  await assert.rejects(method(r, a, 1), /Released COM/);
  await assert.rejects(method(r, deviceW, 1), /Released COM/);
});

test('enumeration invokes native-compatible callbacks with filters, stop and bounded scratch lifetime', async (t) => {
  const r = await setup(t),
    a = factory(r, IW),
    calls = [];
  let stop = false;
  r.callGuest = async (proc, [p, ref]) => {
    assert.equal(proc, 0x1234);
    assert.equal(ref, 0xabcd);
    calls.push({ guid: readGuid(r, p + 4), name: r.wideString(p + 40), size: r.read32(p) });
    return stop ? 0 : 1;
  };
  const enumerate = (type = 0, flags = 0) => method(r, a, 4, type, 0x1234, 0xabcd, flags);
  assert.equal((await enumerate()).result, 0);
  assert.deepEqual(calls, [
    { guid: mouse, name: 'Mouse', size: 1100 },
    { guid: keyboard, name: 'Keyboard', size: 1100 },
  ]);
  calls.length = 0;
  stop = true;
  await enumerate();
  assert.equal(calls.length, 1);
  calls.length = 0;
  stop = false;
  for (const type of [3, 0x13]) {
    await enumerate(type, 0x70001);
    assert.equal(calls.at(-1).guid, keyboard);
  }
  calls.length = 0;
  await enumerate(4);
  await enumerate(0, 0x100);
  assert.equal(calls.length, 0);
  for (const [type, flags] of [
    [5, 0],
    [0x1d, 0],
    [0, 2],
  ])
    assert.equal((await enumerate(type, flags)).result, DI.INVALID);
  assert.equal((await method(r, a, 4, 0, 0, 0, 0)).result, DI.INVALID);
});

test('device registration, capabilities and unknown methods are explicit', async (t) => {
  const r = await setup(t),
    a = factory(r),
    out = r.allocate(4);
  assert.equal((await method(r, a, 5, guid(r, mouse))).result, 0);
  assert.equal((await method(r, a, 5, guid(r, U))).result, DI.DEVICENOTREG);
  r.write32(out, 0xdeadbeef);
  assert.equal((await method(r, a, 3, guid(r, U), out, 0)).result, DI.DEVICENOTREG);
  assert.equal(r.read32(out), 0);
  await method(r, a, 3, guid(r, mouse), out, 0);
  const device = r.read32(out),
    caps = r.allocate(48);
  r.write32(caps, 44);
  r.write32(caps + 44, 0x12345678);
  assert.equal((await method(r, device, 3, caps)).result, 0);
  assert.deepEqual(
    Array.from({ length: 6 }, (_, i) => r.read32(caps + i * 4)),
    [44, 1, 0x212, 3, 5, 0],
  );
  assert.equal(r.read32(caps + 44), 0x12345678);
  await assert.rejects(method(r, device, 9, 16, caps), /Unsupported COM method .*GetDeviceState/);
  await assert.rejects(method(r, a, 6, 0, 0), /Unsupported COM method .*RunControlPanel/);
  assert.equal((await method(r, device, 0, guid(r, IA), out)).result, DI.NOINTERFACE);
  assert.equal(r.read32(out), 0);
});
