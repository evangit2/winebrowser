import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { iconForHandle } from '../src/win32-icons.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const oracle = JSON.parse(await readFile('tests/fixtures/icon-bitmap/wine-oracle.json', 'utf8'));
const bitmapOracle = JSON.parse(
  await readFile('tests/fixtures/icon-bitmap/bitmap-oracle.json', 'utf8'),
);

function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) =>
      r.apiProvider.get(name.includes('!') ? name : 'gdi32.dll!' + name)(r, (i) => args[i] >>> 0),
    call = (name, ...args) => api(name, ...args).result;
  const display = call('user32.dll!GetDC', 0),
    dc = call('CreateCompatibleDC', display),
    bitmap = call('CreateCompatibleBitmap', display, 4, 4);
  call('SelectObject', dc, bitmap);
  const make = (type) => {
    const bits = r.allocate(8);
    r.data.set(type === 'mono' ? [0x80, 0, 0x40, 0, 0xc0, 0, 0x40, 0] : [0x80, 0, 0x40, 0], bits);
    const mask = call('CreateBitmap', 2, type === 'mono' ? 4 : 2, 1, 1, bits),
      info = r.allocate(20);
    r.data.fill(0, info, info + 20);
    r.write32(info, 1);
    r.write32(info + 4, 20);
    r.write32(info + 8, 30);
    r.write32(info + 12, mask);
    let color = 0;
    if (type !== 'mono') {
      const bmi = r.allocate(40),
        out = r.allocate(4);
      r.data.fill(0, bmi, bmi + 40);
      r.write32(bmi, 40);
      r.write32(bmi + 4, 2);
      r.write32(bmi + 8, -2);
      r.view.setUint16(bmi + 12, 1, true);
      r.view.setUint16(bmi + 14, 32, true);
      color = call('CreateDIBSection', display, bmi, 0, out, 0, 0);
      const p = r.read32(out),
        values =
          type === 'alpha'
            ? [0x80102030, 0x80405060, 0x80708090, 0xffa0b0c0]
            : [0x102030, 0x405060, 0x708090, 0xa0b0c0];
      values.forEach((v, i) => r.write32(p + i * 4, v));
      r.write32(info + 16, color);
    }
    const icon = call('user32.dll!CreateIconIndirect', info);
    assert.ok(icon);
    call('DeleteObject', mask);
    if (color) call('DeleteObject', color);
    return icon;
  };
  return { r, api, call, dc, make };
}
test('native bitmap icon ownership, mask/image channels, alpha and destination inversion match actual desktop Wine pixels', (t) => {
  const { r, api, call, dc, make } = setup(t),
    brush = call('CreateSolidBrush', 0xb49678),
    rect = r.allocate(16);
  [0, 0, 4, 4].forEach((v, i) => r.write32(rect + i * 4, v));
  const icons = { color: make('color'), alpha: make('alpha'), mono: make('mono') };
  const copied = call('user32.dll!CopyIcon', icons.color);
  assert.ok(copied);
  call('user32.dll!DestroyIcon', icons.color);
  icons.color = call('user32.dll!CopyIcon', copied);
  icons['copy-after-delete'] = copied;
  icons['scaled-after-delete'] = call('user32.dll!CopyImage', copied, 1, 4, 4, 0);
  assert.ok(icons['scaled-after-delete']);
  const info = r.allocate(20);
  call('user32.dll!GetIconInfo', icons.alpha, info);
  icons['alpha-roundtrip'] = call('user32.dll!CreateIconIndirect', info);
  call('DeleteObject', r.read32(info + 12));
  call('DeleteObject', r.read32(info + 16));
  icons['draw-default'] = icons.color;
  for (const c of oracle.cases) {
    call('user32.dll!FillRect', dc, rect, brush);
    r.lastError = 777;
    const icon = icons[c.name] || icons[c.name.split('-')[0]];
    const response =
      c.name === 'draw-default'
        ? api('user32.dll!DrawIcon', dc, 0, 0, icon)
        : api('user32.dll!DrawIconEx', dc, 0, 0, icon, 4, 4, 0, 0, c.flags);
    assert.deepEqual(response, { result: c.result, argc: c.name === 'draw-default' ? 4 : 9 });
    assert.equal(r.lastError, c.error);
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++)
        assert.equal(call('GetPixel', dc, x, y), c.pixels[y * 4 + x], `${c.name}/${x},${y}`);
  }
});
test('GetIconInfo owns distinct native DDB planes, normalized icon hotspots and guarded PE32 outputs; roundtrip source can be deleted', (t) => {
  const { r, api, call, dc, make } = setup(t),
    query = r.allocate(28),
    bm = r.allocate(24);
  for (const type of ['color', 'alpha', 'mono']) {
    const icon = make(type);
    r.data.fill(0xcc, query, query + 28);
    r.lastError = 777;
    assert.deepEqual(api('user32.dll!GetIconInfo', icon, query), { result: 1, argc: 2 });
    assert.equal(r.lastError, 777);
    const first = [0, 4, 8, 12, 16].map((i) => r.read32(query + i));
    assert.deepEqual(first.slice(0, 3), [1, 1, 1]);
    assert.ok(first[3]);
    assert.equal(!!first[4], type !== 'mono');
    assert.ok(r.data.subarray(query + 20, query + 28).every((v) => v === 0xcc));
    call('GetObjectW', first[3], 24, bm);
    assert.equal(r.read32(bm + 4), 2);
    assert.equal(r.read32(bm + 8), type === 'mono' ? 4 : 2);
    assert.equal(r.view.getUint16(bm + 18, true), 1);
    assert.equal(r.read32(bm + 20), 0);
    if (type === 'alpha') {
      const bmi = r.allocate(40),
        raw = r.allocate(16);
      r.data.fill(0, bmi, bmi + 40);
      r.write32(bmi, 40);
      r.write32(bmi + 4, 2);
      r.write32(bmi + 8, -2);
      r.view.setUint16(bmi + 12, 1, true);
      r.view.setUint16(bmi + 14, 32, true);
      assert.equal(call('GetDIBits', dc, first[4], 0, 2, raw, bmi, 0), 2);
      assert.deepEqual(
        [0, 1, 2, 3].map((i) => r.read32(raw + i * 4)),
        [0x80102030, 0x80405060, 0x80708090, 0xffa0b0c0],
      );
    }
    const round = call('user32.dll!CreateIconIndirect', query);
    assert.ok(round);
    call('DeleteObject', first[3]);
    if (first[4]) call('DeleteObject', first[4]);
    call('user32.dll!DestroyIcon', icon);
    assert.ok(iconForHandle(r, round));
    assert.equal(call('user32.dll!DrawIconEx', dc, 0, 0, round, 4, 4, 0, 0, 3), 1);
    call('user32.dll!DestroyIcon', round);
  }
});
test('bitmap icon failures and copies preserve native input data and independently own resized planes', (t) => {
  const { r, api, call, make } = setup(t),
    icon = make('color'),
    copy = call('user32.dll!CopyImage', icon, 1, 4, 4, 8);
  assert.ok(copy);
  assert.equal(iconForHandle(r, icon), null);
  assert.equal(iconForHandle(r, copy).width, 4);
  const exposed = iconForHandle(r, copy);
  exposed.native.mask.fill(0);
  exposed.pixels.fill(0);
  assert.equal(iconForHandle(r, copy).native.mask[0], 255);
  const same = call('user32.dll!CopyImage', copy, 1, 4, 4, 0x4);
  assert.ok(same && same !== copy, 'native icon RETURNORG still creates an independent handle');
  assert.equal(call('user32.dll!DestroyIcon', same), 1);
  for (const [name, args, error, argc] of [
    ['user32.dll!CopyIcon', [0xdead], 1402, 1],
    ['user32.dll!GetIconInfo', [copy, 0], 87, 2],
    ['user32.dll!CreateIconIndirect', [0], 87, 1],
    ['user32.dll!CopyImage', [copy, 1, 0xffffffff, 4, 0], 87, 5],
  ]) {
    assert.deepEqual(api(name, ...args), { result: 0, argc });
    assert.equal(r.lastError, error);
  }
});

test('bitmap CopyImage uses native true-color resampling, preserves same-size alpha, clears resized alpha, and ignores bitmap RETURNORG', (t) => {
  const { r, call, dc } = setup(t),
    bits = r.allocate(16),
    input = bitmapOracle.cases[0].pixels;
  input.forEach((v, i) => r.write32(bits + i * 4, v));
  const src = call('CreateBitmap', 2, 2, 1, 32, bits),
    bmi = r.allocate(40),
    out = r.allocate(64);
  r.data.fill(0, bmi, bmi + 40);
  r.write32(bmi, 40);
  r.view.setUint16(bmi + 12, 1, true);
  r.view.setUint16(bmi + 14, 32, true);
  const cases = bitmapOracle.cases
    .slice(1, 4)
    .map((row) => ({ size: row.width, pixels: row.pixels }));
  for (const c of cases) {
    const copy = call('user32.dll!CopyImage', src, 0, c.size, c.size, 0);
    assert.ok(copy);
    r.write32(bmi + 4, c.size);
    r.write32(bmi + 8, -c.size);
    assert.equal(call('GetDIBits', dc, copy, 0, c.size, out, bmi, 0), c.size);
    assert.deepEqual(
      c.pixels.map((_, i) => r.read32(out + i * 4)),
      c.pixels,
    );
    call('DeleteObject', copy);
  }
  const same = call('user32.dll!CopyImage', src, 0, 0, 0, 0x4);
  assert.ok(same && same !== src);
  call('DeleteObject', same);
  call('DeleteObject', src);
});
