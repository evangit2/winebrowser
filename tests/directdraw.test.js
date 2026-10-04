import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ddrawApis, directDrawState, DD } from '../src/ddraw.js';
import { DDRAW_ABI } from '../src/ddraw-abi.js';

const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
const ids = {
  dd7: '15e65ec0-3b9c-11d2-b92f-00609797ea5b',
  dd1: '6c14db80-a733-11ce-a521-0020af0be560',
  surface7: '06675a80-3b9b-11d2-b92f-00609797ea5b',
  unknown: '00000000-0000-0000-c000-000000000046',
};
function guid(r, id) {
  const p = r.allocate(16),
    [a, b, c, ...d] = ids[id].split('-');
  r.write32(p, parseInt(a, 16));
  r.view.setUint16(p + 4, parseInt(b, 16), true);
  r.view.setUint16(p + 6, parseInt(c, 16), true);
  const hex = d.join('');
  for (let i = 0; i < 8; i++) r.data[p + 8 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return p;
}
async function fixture(version = 7) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' }),
    p = r.allocate(4);
  const api = ddrawApis['ddraw.dll!DirectDrawCreate' + (version === 7 ? 'Ex' : '')];
  assert.equal(
    api(r, (i) => (version === 7 ? [0, p, guid(r, 'dd7'), 0][i] : [0, p, 0][i])).result,
    0,
  );
  const root = r.read32(p);
  const call = async (pointer, name, ...args) => {
    const o = r.comObjects.objects.get(pointer),
      abi = DDRAW_ABI[o.name] ?? DDRAW_ABI.IDirectDrawSurface7;
    const slot = abi.findIndex(([n]) => n === name);
    assert.ok(slot >= 0);
    const thunk = r.thunks.get(r.read32(o.vtable + slot * 4));
    return (await thunk.invoke(r, (i) => [pointer, ...args][i] ?? 0)).result >>> 0;
  };
  const surface = async (
    width = 4,
    height = 2,
    format = [0x40, 0, 32, 0xff0000, 0xff00, 0xff, 0],
    caps = 0x840,
    backCount = 0,
  ) => {
    const d = r.allocate(version === 7 ? 124 : 108, true);
    r.write32(d, version === 7 ? 124 : 108);
    r.write32(d + 4, 0x1007 | (backCount ? 0x20 : 0));
    r.write32(d + 8, height);
    r.write32(d + 12, width);
    r.write32(d + 20, backCount);
    [32, ...format].forEach((n, i) => r.write32(d + 72 + i * 4, n));
    r.write32(d + 104, caps);
    const hr = await call(root, 'CreateSurface', d, p, 0);
    return { hr, pointer: r.read32(p), descriptor: d };
  };
  return { r, root, p, call, surface };
}

test('DD7 adapter identifiers preserve the PE32 buffer boundary and reject unknown flags', async () => {
  const { r, root, call } = await fixture();
  try {
    const p = r.allocate(1080);
    r.data.fill(0xa5, p, p + 1080);
    assert.equal(await call(root, 'GetDeviceIdentifier', p + 4, 0), 0);
    assert.equal(r.string(p + 4), 'winebrowser-webgpu');
    assert.equal(r.string(p + 516), 'WineBrowser WebGPU Adapter');
    assert.equal(r.read32(p), 0xa5a5a5a5);
    assert.equal(r.read32(p + 1076), 0xa5a5a5a5);
    assert.deepEqual(
      [...r.data.slice(p + 1068, p + 1076)],
      Array(8).fill(0),
      'no WHQL certification or uninitialized tail padding',
    );
    const identifier = r.data.slice(p + 4, p + 1076);
    assert.equal(await call(root, 'GetDeviceIdentifier', p + 4, 1), 0);
    assert.deepEqual(r.data.slice(p + 4, p + 1076), identifier);
    assert.equal(await call(root, 'GetDeviceIdentifier', p + 4, 2), DD.INVALID);
    assert.deepEqual(r.data.slice(p + 4, p + 1076), identifier);
    assert.equal(await call(root, 'GetDeviceIdentifier', 0, 0), DD.INVALID);
  } finally {
    await call(root, 'Release');
    r.windows.dispose();
    r.cpu.dispose();
  }
});

test('opaque DirectDraw RGB ignores an alpha-mask union member without affecting explicit alpha validation', async () => {
  const { r, root, call, surface } = await fixture();
  try {
    const image = await surface(4, 2, [0x40, 0, 32, 0xff0000, 0xff00, 0xff, 0xff000000]);
    assert.equal(image.hr, 0);
    const descriptor = r.allocate(124);
    r.write32(descriptor, 124);
    assert.equal(await call(image.pointer, 'GetSurfaceDesc', descriptor), 0);
    assert.equal(r.read32(descriptor + 76), 0x40);
    assert.equal(r.read32(descriptor + 100), 0);
    await call(image.pointer, 'Release');
    assert.equal(directDrawState(r).bytes, 0);
    assert.notEqual((await surface(4, 2, [0x41, 0, 32, 0xff0000, 0xff00, 0xff, 0])).hr, 0);
  } finally {
    await call(root, 'Release');
    r.windows.dispose();
    r.cpu.dispose();
  }
});

test('DD1/7 COM views share identity, enforce descriptor sizes, preserve legacy caps bounds and release storage', async () => {
  for (const version of [1, 7]) {
    const { r, root, p, call, surface } = await fixture(version),
      s = await surface();
    assert.equal(s.hr, 0);
    const caps = r.allocate(20, true);
    r.write32(caps + 4, 0xabcdef01);
    r.write32(caps + 16, 0xabcdef02);
    assert.equal(await call(s.pointer, 'GetCaps', caps), 0);
    assert.equal(
      r.read32(caps + (version === 1 ? 4 : 16)),
      version === 1 ? 0xabcdef01 : 0xabcdef02,
    );
    assert.equal(await call(s.pointer, 'QueryInterface', guid(r, 'surface7'), p), 0);
    const view = r.read32(p);
    assert.equal(await call(view, 'QueryInterface', guid(r, 'unknown'), p), 0);
    assert.equal(r.read32(p), s.pointer);
    const desc = r.allocate(128, true);
    r.write32(desc, version === 1 ? 124 : 108);
    assert.equal(await call(s.pointer, 'GetSurfaceDesc', desc), DD.INVALID);
    assert.equal(r.read32(desc + 4), 0);
    assert.equal(await call(s.pointer, 'Release'), 2);
    assert.equal(await call(view, 'Release'), 1);
    assert.equal(await call(s.pointer, 'Release'), 0);
    assert.equal(directDrawState(r).bytes, 0);
    assert.equal(await call(root, 'Release'), 0);
    assert.equal(r.comObjects.liveObjects, 0);
    await assert.rejects(call(view, 'GetCaps', caps), /Released COM object/);
  }
});

test('RGB masks and allocation bounds reject unsupported surfaces without leaking bytes or outputs', async () => {
  const { r, root, call, surface } = await fixture();
  for (const f of [
    [0x40, 0, 8, 0, 0, 0, 0],
    [0x40, 0, 16, 0xf801, 0x7e0, 0x1e, 0],
    [0x40, 0, 16, 0xff0000, 0xff00, 0xff, 0],
    [0x40, 0, 32, 0xff0000, 0xff0000, 0xff, 0],
    [0x41, 0, 32, 0xff0000, 0xff00, 0xff, 0],
  ]) {
    const s = await surface(4, 2, f);
    assert.notEqual(s.hr, 0);
    assert.equal(s.pointer, 0);
    assert.equal(directDrawState(r).bytes, 0);
  }
  const large = await surface(2048, 2048);
  assert.equal(large.hr, 0);
  const another = await surface(2048, 2048);
  assert.equal(another.hr, 0);
  const failed = await surface();
  assert.notEqual(failed.hr, 0);
  assert.equal(failed.pointer, 0);
  assert.equal(directDrawState(r).bytes, 32 * 1024 * 1024);
  await call(large.pointer, 'Release');
  await call(another.pointer, 'Release');
  assert.equal(directDrawState(r).bytes, 0);
  await call(root, 'Release');
  assert.equal(r.comObjects.liveObjects, 0);
});

test('24-bit modes agree with Win32, and RGB565-to-24-bit stretching preserves row pitch and color', async () => {
  const { r, root, p, call, surface } = await fixture();
  assert.equal(await call(root, 'SetDisplayMode', 9, 3, 24, 0, 0), 0);
  assert.deepEqual(
    [r.displayMode.width, r.displayMode.height, r.displayMode.bitsPerPixel],
    [9, 3, 24],
  );
  const mode = r.allocate(124, true);
  r.write32(mode, 124);
  await call(root, 'GetDisplayMode', mode);
  assert.equal(r.read32(mode + 84), 24);
  assert.equal(r.read32(mode + 16), 28);
  const src = await surface(2, 1, [0x40, 0, 16, 0xf800, 0x7e0, 0x1f, 0]),
    dst = await surface(4, 2, [0x40, 0, 24, 0xff0000, 0xff00, 0xff, 0]);
  const lock = r.allocate(124, true);
  r.write32(lock, 124);
  assert.equal(await call(src.pointer, 'Lock', 0, lock, 0x20, 0), 0);
  const mem = r.read32(lock + 36);
  r.view.setUint16(mem, 0xf800, true);
  r.view.setUint16(mem + 2, 0x7e0, true);
  await call(src.pointer, 'Unlock', 0);
  assert.equal(await call(dst.pointer, 'Blt', 0, src.pointer, 0, 0x1000000, 0), 0);
  r.write32(lock, 124);
  await call(dst.pointer, 'Lock', 0, lock, 0x10, 0);
  const out = r.read32(lock + 36);
  assert.deepEqual([...r.data.slice(out, out + 12)], [0, 0, 255, 0, 0, 255, 0, 255, 0, 0, 255, 0]);
  await call(dst.pointer, 'Unlock', 0);
  await call(src.pointer, 'Release');
  await call(dst.pointer, 'Release');
  await call(root, 'RestoreDisplayMode');
  assert.equal(r.displayMode.bitsPerPixel, 32);
  await call(root, 'Release');
  assert.equal(r.comObjects.liveObjects, 0);
  assert.ok(p);
});

test('attachments prevent transitive reference cycles and clippers retain and clip HWND client bounds', async () => {
  const { r, root, p, call, surface } = await fixture(),
    surfaces = [];
  for (let i = 0; i < 3; i++) surfaces.push((await surface()).pointer);
  assert.equal(await call(surfaces[0], 'AddAttachedSurface', surfaces[1]), 0);
  assert.equal(await call(surfaces[1], 'AddAttachedSurface', surfaces[2]), 0);
  assert.equal(await call(surfaces[2], 'AddAttachedSurface', surfaces[0]), DD.INVALID);
  r.windows.windows.set(123, {
    id: 123,
    x: 1,
    y: 0,
    width: 2,
    height: 2,
    style: 0x80000000,
    visible: true,
    parentId: 0,
  });
  assert.equal(await call(root, 'CreateClipper', 0, p, 0), 0);
  const clipper = r.read32(p);
  assert.equal(await call(clipper, 'SetHWnd', 0, 123), 0);
  assert.equal(await call(surfaces[0], 'SetClipper', clipper), 0);
  assert.equal(await call(clipper, 'Release'), 1);
  const fx = r.allocate(100, true);
  r.write32(fx, 100);
  r.write32(fx + 80, 0xff0000);
  assert.equal(await call(surfaces[0], 'Blt', 0, 0, 0, 0x400, fx), 0);
  const s = r.comObjects.objects.get(surfaces[0]).state;
  assert.deepEqual(
    Array.from({ length: 4 }, (_, x) => r.read32(s.memory + x * 4)),
    [0, 0xff0000, 0xff0000, 0],
  );
  for (const pointer of surfaces) await call(pointer, 'Release');
  await call(root, 'Release');
  assert.equal(directDrawState(r).bytes, 0);
  assert.equal(r.comObjects.liveObjects, 0);
});
