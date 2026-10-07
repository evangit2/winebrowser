import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { iconForHandle } from '../src/win32-icons.js';
import { cursorPresentation } from '../src/desktop-cursor.js';

const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const capture = JSON.parse(await readFile('tests/fixtures/owned-cursors/wine-oracle.json', 'utf8'));
function setup(t) {
  const events = [];
  const r = new Runtime(iced, {
    files: new Map([['console.exe', exe]]),
    exe: 'console.exe',
    emit: (event) => events.push(event),
  });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] >>> 0);
  const call = (name, ...args) => api(name, ...args).result;
  const dc = call('gdi32.dll!CreateCompatibleDC', 0);
  const make = (
    isIcon,
    hotX,
    hotY,
    mono,
    colors = [0x80102030, 0x00405060, 0x80708090, 0xffa0b0c0],
  ) => {
    const bytes = r.allocate(8),
      info = r.allocate(20);
    r.data.set([0x80, 0, 0x40, 0, 0xc0, 0, 0x40, 0], bytes);
    const mask = call('gdi32.dll!CreateBitmap', 2, mono ? 4 : 2, 1, 1, bytes);
    r.data.fill(0, info, info + 20);
    [isIcon, hotX, hotY, mask].forEach((value, i) => r.write32(info + i * 4, value));
    let color = 0;
    if (!mono) {
      const bmi = r.allocate(40),
        out = r.allocate(4);
      r.data.fill(0, bmi, bmi + 40);
      r.write32(bmi, 40);
      r.write32(bmi + 4, 2);
      r.write32(bmi + 8, -2);
      r.view.setUint16(bmi + 12, 1, true);
      r.view.setUint16(bmi + 14, 32, true);
      color = call('gdi32.dll!CreateDIBSection', dc, bmi, 0, out, 0, 0);
      colors.forEach((value, i) => r.write32(r.read32(out) + i * 4, value));
      r.write32(info + 16, color);
    }
    r.lastError = 777;
    const handle = call('user32.dll!CreateIconIndirect', info),
      error = r.lastError;
    assert.equal(call('gdi32.dll!DeleteObject', mask), 1);
    if (color) assert.equal(call('gdi32.dll!DeleteObject', color), 1);
    return { handle, error };
  };
  const observe = (name, result, error, handle) => {
    const info = r.allocate(20);
    r.data.fill(0, info, info + 20);
    r.lastError = 888;
    const valid = call('user32.dll!GetIconInfo', handle, info),
      infoError = r.lastError;
    const actual = {
      name,
      result,
      error,
      valid,
      infoError,
      icon: r.read32(info),
      hotX: r.read32(info + 4),
      hotY: r.read32(info + 8),
      color: r.read32(info + 16) ? 1 : 0,
    };
    assert.deepEqual(
      actual,
      capture.cases.find((c) => c.name === name),
    );
    if (valid) {
      assert.equal(call('gdi32.dll!DeleteObject', r.read32(info + 12)), 1);
      if (r.read32(info + 16)) assert.equal(call('gdi32.dll!DeleteObject', r.read32(info + 16)), 1);
    }
  };
  return { r, call, api, make, observe, events };
}

test('native bitmap cursor creation, copies and ownership match captured metadata and destruction results', (t) => {
  const { r, call, make, observe } = setup(t);
  const handles = [];
  for (const [isIcon, x, y, mono] of [
    [0, 1, 0, 0],
    [0, 0, 1, 1],
    [0, 19, 31, 0],
    [1, 19, 31, 0],
  ]) {
    const { handle, error } = make(isIcon, x, y, mono);
    observe(`create-${isIcon}-${x}-${y}-${mono}`, handle ? 1 : 0, error, handle);
    handles.push(handle);
  }
  const [color, mono, outside, icon] = handles;
  r.lastError = 777;
  const previous = call('user32.dll!SetCursor', icon);
  observe(
    'select-icon-as-cursor',
    call('user32.dll!GetCursor') === icon ? 1 : 0,
    r.lastError,
    icon,
  );
  call('user32.dll!SetCursor', previous);
  r.lastError = 777;
  const iconCopy = call('user32.dll!CopyImage', icon, 1, 2, 2, 4);
  observe('same-icon-copy-return', iconCopy === icon ? 1 : 0, r.lastError, iconCopy);
  r.lastError = 777;
  const copy = call('user32.dll!CopyIcon', color);
  observe('copy-cursor', copy ? 1 : 0, r.lastError, copy);
  r.lastError = 777;
  const scaled = call('user32.dll!CopyImage', color, 2, 4, 4, 0);
  observe('scale-cursor', scaled ? 1 : 0, r.lastError, scaled);
  r.lastError = 777;
  const shared = call('user32.dll!CopyImage', color, 2, 2, 2, 4);
  observe('same-copy-return', shared === color ? 1 : 0, r.lastError, shared);
  for (const [name, api, handle] of [
    ['destroy-cursor-of-icon', 'DestroyCursor', icon],
    ['destroy-icon-of-cursor', 'DestroyIcon', mono],
  ]) {
    r.lastError = 777;
    const result = call('user32.dll!' + api, handle);
    observe(name, result, r.lastError, handle);
  }
  call('user32.dll!SetCursor', color);
  r.lastError = 777;
  const destroyed = call('user32.dll!DestroyCursor', color);
  observe('destroy-active-cursor', destroyed, r.lastError, color);
  r.lastError = 777;
  observe(
    'get-destroyed-active',
    call('user32.dll!GetCursor') === color ? 1 : 0,
    r.lastError,
    color,
  );
  call('user32.dll!SetCursor', 0);
  for (const [name, handle] of [
    ['destroy-twice', color],
    ['destroy-null', 0],
  ]) {
    r.lastError = 777;
    const result = call('user32.dll!DestroyCursor', handle);
    observe(name, result, r.lastError, handle);
  }
  r.lastError = 777;
  const nullIcon = call('user32.dll!DestroyIcon', 0);
  observe('destroy-icon-null', nullIcon, r.lastError, 0);
  assert.equal(call('user32.dll!DestroyIcon', iconCopy), 1);
  for (const handle of [copy, scaled, shared, outside])
    assert.equal(call('user32.dll!DestroyCursor', handle), 1);
});

test('cursor drawing and straight-alpha/inverting presentation match 256 independently captured native pixels before and after resizing', async (t) => {
  const { r, call, make } = setup(t);
  const captured = JSON.parse(
    await readFile('tests/fixtures/owned-cursors/draw-wine-oracle.json', 'utf8'),
  );
  const alpha = make(0, 1, 0, 0, [0x80102030, 0x00405060, 0x80706050, 0xffa0b0c0]).handle;
  const mono = make(0, 1, 0, 1).handle;
  const handles = [
    alpha,
    mono,
    call('user32.dll!CopyImage', alpha, 2, 4, 4, 0),
    call('user32.dll!CopyImage', mono, 2, 4, 4, 0),
  ];
  const dc = call('gdi32.dll!CreateCompatibleDC', 0),
    bmi = r.allocate(40),
    out = r.allocate(4);
  r.data.fill(0, bmi, bmi + 40);
  r.write32(bmi, 40);
  r.write32(bmi + 4, 8);
  r.write32(bmi + 8, -8);
  r.view.setUint16(bmi + 12, 1, true);
  r.view.setUint16(bmi + 14, 32, true);
  const bitmap = call('gdi32.dll!CreateDIBSection', dc, bmi, 0, out, 0, 0);
  call('gdi32.dll!SelectObject', dc, bitmap);
  for (const c of captured.cases) {
    const handle = handles[c.type],
      image = iconForHandle(r, handle),
      shown = cursorPresentation(image);
    for (let i = 0; i < 64; i++) r.write32(r.read32(out) + i * 4, 0x00406080);
    r.lastError = 777;
    assert.equal(
      call('user32.dll!DrawIconEx', dc, 2, 2, handle, image.width, image.height, 0, 0, 3),
      c.result,
    );
    assert.equal(r.lastError, c.error);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        assert.equal(call('gdi32.dll!GetPixel', dc, x, y), c.pixels[y * 8 + x]);
        const rgb = [64, 96, 128];
        if (x >= 2 && y >= 2 && x < 2 + image.width && y < 2 + image.height) {
          const at = ((y - 2) * image.width + x - 2) * 4,
            alpha = shown.normal[at + 3] / 255;
          for (let n = 0; n < 3; n++) {
            rgb[n] = Math.round(shown.normal[at + n] * alpha + rgb[n] * (1 - alpha));
            if (shown.inverse[at + 3]) rgb[n] = Math.abs(rgb[n] - shown.inverse[at + n]);
          }
        }
        assert.equal(
          rgb[0] | (rgb[1] << 8) | (rgb[2] << 16),
          c.pixels[y * 8 + x],
          `${c.type}/${x},${y}/presentation`,
        );
      }
  }
  for (const handle of handles) call('user32.dll!DestroyCursor', handle);
});

test('retired active cursors retain visible pixels for visibility changes; copied images and metadata stay independent', (t) => {
  const { r, call, api, make, events } = setup(t);
  const { handle } = make(0, 1, 0, 0);
  assert.deepEqual(api('user32.dll!SetCursor', handle), { result: 32512, argc: 1 });
  const image = events.at(-1).image;
  assert.deepEqual([image.width, image.height, image.hotX, image.hotY], [2, 2, 1, 0]);
  assert.deepEqual([...image.pixels.slice(0, 4)], [16, 32, 48, 128]);
  const pixels = image.pixels.slice();
  image.pixels.fill(0);
  assert.equal(call('user32.dll!DestroyCursor', handle), 0);
  assert.equal(call('user32.dll!ShowCursor', 0), 0xffffffff);
  assert.equal(events.at(-1).css, 'none');
  assert.equal(call('user32.dll!ShowCursor', 1), 0);
  assert.deepEqual(events.at(-1).image.pixels, pixels);
  assert.equal(call('user32.dll!SetCursor', 32512), handle);
  assert.equal(events.at(-1).css, 'default');
  r.lastError = 777;
  assert.equal(call('user32.dll!SetCursor', handle), 0);
  assert.equal(r.lastError, 1402);
  assert.equal(call('user32.dll!GetCursor'), 32512);
});

test('shared system cursor destruction preserves the handle and LastError', (t) => {
  const { r, call } = setup(t);
  const shared = call('user32.dll!LoadCursorW', 0, 32512);
  r.lastError = 777;
  assert.equal(call('user32.dll!DestroyCursor', shared), 1);
  assert.equal(r.lastError, 777);
  assert.equal(call('user32.dll!LoadCursorW', 0, 32512), shared);
  assert.equal(call('user32.dll!SetCursor', shared), shared);
});

test('authored resource DLL cursor metadata and shared lifetime reproduce eight native monochrome/color cases', async (t) => {
  const { r, api, call } = setup(t);
  r.files.set(
    'cursors.dll',
    new Uint8Array(await readFile('tests/fixtures/custom-cursors/cursors.dll')),
  );
  const name = r.allocate(32);
  r.data.set(new TextEncoder().encode('cursors.dll\0'), name);
  const module = (await api('kernel32.dll!LoadLibraryA', name)).result;
  assert.ok(module);
  const captured = JSON.parse(
    await readFile('tests/fixtures/owned-cursors/resource-wine-oracle.json', 'utf8'),
  );
  const names = [101, 'FOUR', 'EIGHT', 'TRUECOLOR', 'ALPHA', 'MULTI', 'BLANK', 'SMALL'];
  const info = r.allocate(20),
    bitmap = r.allocate(24);
  for (const c of captured.cases) {
    let resource = names[c.type];
    if (typeof resource === 'string') {
      r.data.set(new TextEncoder().encode(resource + '\0'), name);
      resource = name;
    }
    const cursor = call('user32.dll!LoadCursorA', module, resource);
    assert.ok(cursor);
    r.lastError = 777;
    const valid = call('user32.dll!GetIconInfo', cursor, info),
      error = r.lastError;
    call('gdi32.dll!GetObjectW', r.read32(info + 12), 24, bitmap);
    const maskWidth = r.read32(bitmap + 4),
      maskHeight = r.read32(bitmap + 8);
    r.data.fill(0, bitmap, bitmap + 24);
    if (r.read32(info + 16)) call('gdi32.dll!GetObjectW', r.read32(info + 16), 24, bitmap);
    assert.deepEqual(
      {
        type: c.type,
        valid,
        error,
        icon: r.read32(info),
        hotX: r.read32(info + 4),
        hotY: r.read32(info + 8),
        maskWidth,
        maskHeight,
        colorDepth: r.view.getUint16(bitmap + 18, true),
      },
      c,
    );
    call('gdi32.dll!DeleteObject', r.read32(info + 12));
    if (r.read32(info + 16)) call('gdi32.dll!DeleteObject', r.read32(info + 16));
    const copy = call('user32.dll!CopyIcon', cursor);
    assert.ok(copy && copy !== cursor);
    r.lastError = 777;
    assert.equal(call('user32.dll!DestroyCursor', cursor), 1);
    assert.equal(r.lastError, 777);
    assert.equal(call('user32.dll!LoadCursorA', module, resource), cursor);
    assert.equal(call('user32.dll!DestroyCursor', copy), 1);
    assert.equal(call('user32.dll!GetIconInfo', copy, info), 0);
    assert.equal(r.lastError, 1402);
  }
});
