import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { activeGdiDC } from '../src/win32-gdi.js';
async function setup(t) {
  const bytes = new Uint8Array(
    await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
  );
  const events = [],
    r = new Runtime(iced, {
      files: new Map([['console.exe', bytes]]),
      exe: 'console.exe',
      emit: (e) => events.push(e),
    });
  t.after(() => r.windows.dispose());
  const call = async (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] ?? 0);
  const proc = 0x12345678,
    messages = [];
  let brushKind = 'solid',
    destroyOnColor = false,
    brush,
    dc;
  r.callGuest = async (p, args) => {
    const entry = r.thunks.get(p);
    if (entry?.invoke) return (await entry.invoke(r, (i) => args[i] ?? 0)).result;
    assert.equal(p, proc);
    if (args[1] === 0x81) return 1;
    if (args[1] >= 0x133 && args[1] <= 0x138) {
      messages.push(args);
      dc = args[2];
      assert.ok(activeGdiDC(r, dc));
      await call('gdi32.dll!SetTextColor', dc, 0xa05014);
      await call('gdi32.dll!SetBkColor', dc, 0x554433);
      if (brushKind === 'pattern') {
        const bits = r.allocate(16);
        [0xff0000, 0xff00, 0xff, 0xffff00].forEach((value, i) => r.write32(bits + i * 4, value));
        const bitmap = (await call('gdi32.dll!CreateBitmap', 2, 2, 1, 32, bits)).result;
        brush = (await call('gdi32.dll!CreatePatternBrush', bitmap)).result;
        assert.equal((await call('gdi32.dll!DeleteObject', bitmap)).result, 1);
        await call('gdi32.dll!SetBrushOrgEx', dc, 3, -5, 0);
      } else
        brush =
          brushKind === 'hatch'
            ? (await call('gdi32.dll!CreateHatchBrush', 4, 0xfff0e8)).result
            : brushKind === 'null'
              ? (await call('gdi32.dll!GetStockObject', 5)).result
              : (await call('gdi32.dll!CreateSolidBrush', 0xfff0e8)).result;
      if (destroyOnColor) await r.windows.destroy(args[3]);
      return brush;
    }
    return (await call('user32.dll!DefWindowProcA', ...args)).result;
  };
  const cls = r.allocate(40),
    name = r.allocString('ColorCallbackOwner');
  r.data.fill(0, cls, cls + 40);
  r.write32(cls + 4, proc);
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
      300,
      200,
      0,
      0,
      r.pe.imageBase,
      0,
    )
  ).result;
  const make = async (kind, id) =>
    (
      await call(
        'user32.dll!CreateWindowExA',
        0,
        r.allocString(kind),
        r.allocString('native text'),
        0x50000000,
        8,
        8,
        100,
        20,
        owner,
        id,
        r.pe.imageBase,
        0,
      )
    ).result;
  return {
    r,
    call,
    owner,
    make,
    messages,
    events,
    getBrush: () => brush,
    getDc: () => dc,
    setDestroy: () => (destroyOnColor = true),
    setBrush: (value) => {
      brushKind = value;
    },
  };
}
test('native control color callbacks use live HDCs and copy borrowed brush/text state without retaining ownership', async (t) => {
  const { r, call, make, messages, getBrush, getDc } = await setup(t);
  for (const [kind, message] of [
    ['EDIT', 0x133],
    ['STATIC', 0x138],
    ['BUTTON', 0x135],
    ['LISTBOX', 0x134],
  ]) {
    const hwnd = await make(kind, 10);
    await r.windows.send(hwnd, 0xf);
    assert.equal(messages.at(-1)[1], message);
    assert.equal(messages.at(-1)[3], hwnd);
    assert.deepEqual(r.windows.windows.get(hwnd).controlColors, {
      text: 0xa05014,
      background: 0xfff0e8,
      transparent: false,
      hatch: undefined,
      hatchBackground: 0x554433,
      backgroundMode: 2,
      pattern: undefined,
      brushOriginX: 0,
      brushOriginY: 0,
    });
    assert.equal(activeGdiDC(r, getDc()), null);
    assert.equal((await call('gdi32.dll!DeleteObject', getBrush())).result, 1);
    assert.equal(r.windows.windows.get(hwnd).invalid, null);
    if (kind === 'EDIT') {
      await r.windows.send(hwnd, 0xcf, 1, 0);
      await r.windows.send(hwnd, 0xf);
      assert.equal(messages.at(-1)[1], 0x138);
      await r.windows.send(hwnd, 0xcf, 0, 0);
      await call('user32.dll!EnableWindow', hwnd, 0);
      await r.windows.send(hwnd, 0xf);
      assert.equal(messages.at(-1)[1], 0x138);
    }
    await r.windows.destroy(hwnd);
  }
});
test('standard controls copy patterned brush pixels and origins before native source/brush/DC release', async (t) => {
  const { r, call, make, setBrush, getBrush } = await setup(t);
  setBrush('pattern');
  const hwnd = await make('STATIC', 10);
  await r.windows.send(hwnd, 0xf);
  const colors = r.windows.windows.get(hwnd).controlColors;
  assert.deepEqual(
    [colors.pattern.width, colors.pattern.height, colors.brushOriginX, colors.brushOriginY],
    [2, 2, 3, -5],
  );
  assert.deepEqual(
    [...colors.pattern.pixels],
    [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255],
  );
  assert.equal((await call('gdi32.dll!DeleteObject', getBrush())).result, 1);
  assert.equal(colors.pattern.pixels[0], 255);
});
test('parent may destroy a control during its color callback without a stale browser update', async (t) => {
  const { r, make, setDestroy, events } = await setup(t);
  const hwnd = await make('EDIT', 10);
  setDestroy();
  const before = events.length;
  await r.windows.send(hwnd, 0xf);
  assert.equal(r.windows.windows.has(hwnd), false);
  assert.equal(
    events
      .slice(before)
      .filter((e) => e.type === 'window' && e.operation !== 'destroy' && e.window?.id === hwnd)
      .length,
    0,
  );
});

test('null and hatch control brushes preserve native transparency and background metadata', async (t) => {
  const { r, make, setBrush } = await setup(t);
  const hwnd = await make('STATIC', 10);
  setBrush('null');
  await r.windows.send(hwnd, 0xf);
  assert.equal(r.windows.windows.get(hwnd).controlColors.transparent, true);
  setBrush('hatch');
  await r.windows.send(hwnd, 0xf);
  assert.equal(r.windows.windows.get(hwnd).controlColors.hatch, 4);
  assert.equal(r.windows.windows.get(hwnd).controlColors.hatchBackground, 0x554433);
});
