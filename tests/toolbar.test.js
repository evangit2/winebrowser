import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

async function setup(t) {
  const bytes = new Uint8Array(await readFile('public/demos/console/console.exe'));
  const events = [],
    commands = [];
  const r = new Runtime(iced, {
    files: new Map([['console.exe', bytes]]),
    exe: 'console.exe',
    emit: (e) => events.push(e),
  });
  t.after(() => r.windows.dispose());
  const call = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] ?? 0);
  r.callGuest = async (address, args) => {
    if (r.thunks.get(address)?.invoke)
      return (await r.thunks.get(address).invoke(r, (i) => args[i] ?? 0)).result;
    assert.equal(address, 0x12345678);
    if (args[1] === 0x111) commands.push(args);
    return (await call('user32.dll!DefWindowProcA', ...args)).result;
  };
  const name = r.allocString('ToolbarOwner'),
    cls = r.allocate(40);
  r.data.fill(0, cls, cls + 40);
  r.write32(cls + 4, 0x12345678);
  r.write32(cls + 16, r.pe.imageBase);
  r.write32(cls + 36, name);
  await call('user32.dll!RegisterClassA', cls);
  const owner = (
    await call(
      'user32.dll!CreateWindowExA',
      0,
      name,
      name,
      0x10c80000,
      0,
      0,
      400,
      200,
      0,
      0,
      r.pe.imageBase,
      0,
    )
  ).result;
  const buttons = (records) => {
    const p = r.allocate(records.length * 20);
    r.data.fill(0, p, p + records.length * 20);
    records.forEach((b, i) => {
      const at = p + i * 20;
      r.write32(at, b.image ?? -1);
      r.write32(at + 4, b.id);
      r.data[at + 8] = b.state ?? 4;
      r.data[at + 9] = b.style ?? 0;
      r.write32(at + 12, b.data ?? 0);
      r.write32(at + 16, b.string ?? -1);
    });
    return p;
  };
  const create = async (records, bitmapCount = 0) => {
    const response = await call(
      'comctl32.dll!CreateToolbarEx',
      owner,
      0x50000900,
      55,
      bitmapCount,
      0xffffffff,
      0,
      buttons(records),
      records.length,
      24,
      24,
      16,
      16,
      20,
    );
    assert.equal(response.argc, 13);
    assert.ok(response.result);
    return response.result;
  };
  return {
    r,
    call,
    buttons,
    owner,
    commands,
    events,
    create,
    send: async (id, msg, wp = 0, lp = 0) =>
      (await call('user32.dll!SendMessageA', id, msg, wp, lp)).result,
  };
}

test('toolbar PE32 button layout, native geometry and state update without corrupting output tails', async (t) => {
  const { r, create, send, owner, events } = await setup(t);
  const id = await create(
    [
      { id: 101, image: 6, data: 0xfeedbeef },
      { id: 102, style: 2 },
      { id: 103, style: 6 },
      { id: 104, style: 6 },
    ],
    15,
  );
  assert.equal(await send(id, 0x418), 4);
  assert.equal(await send(id, 0x419, 101), 0);
  assert.equal(await send(id, 0x419, 999), -1 >>> 0);
  const out = r.allocate(24);
  r.data.fill(0xaa, out, out + 24);
  assert.equal(await send(id, 0x417, 0, out), 1);
  assert.equal(r.read32(out), 6);
  assert.equal(r.read32(out + 4), 101);
  assert.equal(r.read32(out + 12), 0xfeedbeef);
  assert.equal(r.read32(out + 20), 0xaaaaaaaa);
  assert.equal(await send(id, 0x42d, 101, out), -1 >>> 0);
  assert.equal(await send(id, 0x44b, 101, out), 0);
  assert.equal(r.read32(out), 6, 'an image-only text query leaves the buffer untouched');
  assert.equal(await send(id, 0x402, 103, 1), 1);
  assert.equal(await send(id, 0x40a, 103), 1);
  await send(id, 0x402, 104, 1);
  assert.equal(await send(id, 0x40a, 103), 0);
  await send(id, 0x401, 101, 0);
  assert.equal(await send(id, 0x409, 101), 0);
  assert.equal(await send(id, 0x428), 1);
  assert.equal(await send(id, 0x41d, 0, out), 1);
  assert.deepEqual(
    [0, 4, 8, 12].map((x) => r.read32(out + x)),
    [2, 2, 26, 26],
  );
  assert.equal(r.read32(out + 20), 0xaaaaaaaa);
  await send(id, 0x404, 101, 1);
  assert.equal(await send(id, 0x41d, 0, out), 0);
  const published = events.findLast((e) => e.type === 'window' && e.window.id === id).window;
  assert.equal(published.toolbar.buttons[0].image.width, 16);
  assert.equal(published.toolbar.buttons[0].image.label, 'New');
  assert.ok(published.toolbar.buttons[0].image.pixels.some((v, i) => i % 4 === 3 && v === 255));
  assert.equal(r.windows.windows.get(id).width, r.windows.windows.get(owner).width);
});

test('toolbar A/W strings copy caller memory, mutable lists retain native data and clicks obey state', async (t) => {
  const { r, create, send, buttons, commands } = await setup(t);
  const pointer = r.allocString('Save');
  const id = await create([
    { id: 201, string: pointer },
    { id: 202, style: 2 },
    { id: 203, state: 0 },
  ]);
  r.free(pointer);
  const out = r.allocate(48);
  assert.equal(await send(id, 0x42d, 201, out), 4);
  assert.equal(r.string(out), 'Save');
  const pool = r.allocString('First\0Second\0', true);
  assert.equal(await send(id, 0x44d, 0, pool), 0);
  const p = buttons([
    { id: 204, string: 1, data: 123 },
    { id: 205, string: r.allocString('Ω€', true) },
  ]);
  assert.equal(await send(id, 0x444, 2, p), 1);
  assert.equal(await send(id, 0x44b, 205, out), 2);
  assert.equal(r.wideString(out), 'Ω€');
  assert.equal(await send(id, 0x42d, 204, out), 6);
  assert.equal(r.string(out), 'Second');
  await send(id, 0x7fc1, 203);
  assert.equal(commands.length, 0);
  await send(id, 0x7fc1, 202);
  assert.equal(await send(id, 0x40a, 202), 1);
  assert.deepEqual(commands[0].slice(1), [0x111, 202, id]);
  await send(id, 0x7fc1, 202);
  assert.equal(await send(id, 0x40a, 202), 0);
  await send(id, 0x404, 202, 1);
  await send(id, 0x7fc1, 202);
  assert.equal(commands.length, 2);
  assert.equal(await send(id, 0x416, 0), 1);
  assert.equal(await send(id, 0x419, 201), -1 >>> 0);
  assert.equal(await send(id, 0x417, 2, out), 1);
  assert.equal(r.read32(out + 12), 123);
  assert.equal(await send(id, 0x415, 0, buttons([{ id: 206 }])), 1);
  assert.equal(await send(id, 0x419, 206), 0);
});

test('TBBUTTONINFO A/W honors masks, text capacities, untouched tails and stable native data', async (t) => {
  const { r, create, send } = await setup(t);
  const id = await create([{ id: 300, data: 0xfeedbeef }]);
  const info = r.allocate(36),
    out = r.allocate(12);
  r.data.fill(0, info, info + 36);
  r.write32(info, 32);
  r.write32(info + 4, 0x42);
  r.write32(info + 24, r.allocString('Ω€ABC', true));
  r.view.setUint16(info + 18, 80, true);
  assert.equal(await send(id, 0x440, 300, info), 1);
  r.data.fill(0xaa, out, out + 12);
  r.write32(info + 4, 0x8000007f);
  r.write32(info + 24, out);
  r.write32(info + 28, 3);
  r.data.fill(0xbb, info + 32, info + 36);
  assert.equal(await send(id, 0x43f, 0, info), 0);
  assert.equal(r.wideString(out), 'Ω€');
  assert.equal(r.read32(info + 8), 300);
  assert.equal(r.read32(info + 20), 0xfeedbeef);
  assert.equal(r.view.getUint16(info + 18, true), 80);
  assert.equal(r.read32(info + 32), 0xbbbbbbbb);
  assert.ok(r.data.slice(out + 6, out + 12).every((b) => b === 0xaa));
  r.write32(info + 4, 2);
  r.write32(info + 24, r.allocString('café'));
  assert.equal(await send(id, 0x442, 300, info), 1);
  r.write32(info + 24, out);
  r.write32(info + 28, 3);
  assert.equal(await send(id, 0x441, 300, info), 0);
  assert.equal(r.string(out), 'ca');
  r.write32(info, 31);
  assert.equal(await send(id, 0x441, 300, info), -1 >>> 0);
  r.write32(info, 32);
  r.write32(info + 4, 8);
  r.data[info + 17] = 8;
  assert.equal(await send(id, 0x442, 300, info), 0);
  assert.equal(r.lastError, 120);
  assert.equal(await send(id, 0x42d, 300, out), 4);
  assert.equal(r.string(out), 'café');
});

test('standard small/large icon families and invalid toolbar structures remain bounded', async (t) => {
  const { r, create, send, call, owner, buttons } = await setup(t);
  const id = await create([{ id: 301 }]);
  const bitmap = r.allocate(8);
  r.write32(bitmap, 0xffffffff);
  for (const [asset, count, size] of [
    [0, 15, 16],
    [1, 15, 24],
    [4, 12, 16],
    [5, 12, 24],
    [8, 5, 16],
    [9, 5, 24],
  ]) {
    r.write32(bitmap + 4, asset);
    const base = await send(id, 0x413, count, bitmap);
    assert.equal(base, r.windows.windows.get(id).toolbar.images.length - count);
    assert.equal(r.windows.windows.get(id).toolbar.images[base].width, size);
  }
  const bits = r.allocate(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) r.data.set([30, 40, 220, 0], bits + i * 4);
  const borrowed = (await call('gdi32.dll!CreateBitmap', 16, 16, 1, 32, bits)).result;
  assert.ok(borrowed);
  r.write32(bitmap, 0);
  r.write32(bitmap + 4, borrowed);
  const borrowedIndex = await send(id, 0x413, 1, bitmap);
  assert.notEqual(borrowedIndex, -1 >>> 0);
  await call('gdi32.dll!DeleteObject', borrowed);
  assert.deepEqual(
    [...r.windows.windows.get(id).toolbar.images[borrowedIndex].pixels.slice(0, 4)],
    [220, 40, 30, 255],
  );
  const before = await send(id, 0x418);
  assert.equal(await send(id, 0x414, 1, buttons([{ id: 302, style: 8 }])), 0);
  assert.equal(await send(id, 0x418), before);
  const count = r.windows.windows.size;
  const invalid = await call(
    'comctl32.dll!CreateToolbarEx',
    owner,
    0x50000000,
    56,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    24,
  );
  assert.equal(invalid.result, 0);
  assert.equal(r.windows.windows.size, count);
  const empty = await call(
    'comctl32.dll!CreateToolbarEx',
    owner,
    0x50000000,
    57,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    24,
    0,
    20,
  );
  assert.ok(empty.result);
  assert.equal(await send(empty.result, 0x418), 0);
  assert.equal(r.windows.windows.get(empty.result).toolbar.bitmapWidth, 24);
  assert.equal(r.windows.windows.get(empty.result).toolbar.bitmapHeight, 16);
  const badSize = await call(
    'comctl32.dll!CreateToolbarEx',
    owner,
    0x50000000,
    58,
    0,
    0,
    0,
    0,
    0,
    8192,
    24,
    16,
    16,
    20,
  );
  assert.equal(badSize.result, 0);
  assert.equal(r.windows.windows.size, count + 1);
  r.write32(bitmap, 0xffffffff);
  r.write32(bitmap + 4, 99);
  assert.equal(await send(id, 0x413, 1, bitmap), -1 >>> 0);
  assert.equal(r.lastError, 120);
});
