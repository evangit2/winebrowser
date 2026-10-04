import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { parseMenuResource, menuApis, describeMenuItems } from '../src/win32-menus.js';
import { gdiApis } from '../src/win32-gdi.js';
import { windowApis } from '../src/win32-windows.js';
import { registryApis } from '../src/win32-registry.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const runtime = () =>
  new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
const call = (r, name, ...args) =>
  (gdiApis[name] ?? windowApis[name] ?? menuApis[name] ?? registryApis[name])(
    r,
    (i) => args[i] >>> 0,
  );
const words = (...values) => Uint8Array.from(values.flatMap((v) => [v & 255, v >>> 8]));
const text = (value) => [...value].map((c) => c.charCodeAt(0)).concat(0);

test('standard menu templates handle zero flags, nested popups, separators, header extras and MF_END', () => {
  const bytes = words(
    0,
    2,
    0xabcd,
    0x10,
    ...text('&Game'),
    0,
    101,
    ...text('&New'),
    0x800,
    0,
    0,
    0x80 | 8,
    102,
    ...text('&Checked'),
    0x90,
    ...text('&Help'),
    0x80,
    201,
    ...text('About'),
  );
  const parsed = parseMenuResource(bytes);
  assert.equal(parsed.end, bytes.length);
  assert.equal(parsed.items.length, 2);
  const game = parsed.items[0].submenu.items;
  assert.deepEqual(
    game.map((i) => i.id),
    [101, 0, 102],
  );
  assert.equal(game[1].separator, true);
  assert.equal(describeMenuItems(game)[2].checked, true);
  assert.equal(parsed.items[1].submenu.items[0].text, 'About');
  for (let i = 0; i < bytes.length; i++) assert.equal(parseMenuResource(bytes.slice(0, i)), null);
  assert.equal(parseMenuResource(words(1, 0, 0, 0)), null);
});

test('dynamic menu APIs use the PE32 parameter counts and update nested command state', () => {
  const r = runtime();
  const root = call(r, 'user32.dll!CreateMenu').result;
  const popup = call(r, 'user32.dll!CreatePopupMenu').result;
  const label = r.allocString('&Run && Go');
  assert.deepEqual(call(r, 'user32.dll!AppendMenuA', popup, 0, 15, label), { result: 1, argc: 4 });
  assert.equal(call(r, 'user32.dll!AppendMenuA', root, 0x10, popup, label).result, 1);
  assert.deepEqual(call(r, 'user32.dll!GetSubMenu', root, 0), { result: popup, argc: 2 });
  assert.equal(call(r, 'user32.dll!GetMenuItemID', root, 0).result, 0xffffffff);
  assert.equal(call(r, 'user32.dll!GetMenuItemID', popup, 0).result, 15);
  assert.equal(call(r, 'user32.dll!CheckMenuItem', root, 15, 8).result, 0);
  assert.equal(call(r, 'user32.dll!GetMenuState', root, 15, 0).result, 8);
  assert.equal(call(r, 'user32.dll!CheckMenuItem', root, 15, 0).result, 8);
  assert.equal(call(r, 'user32.dll!EnableMenuItem', root, 15, 1).result, 0);
  assert.equal(call(r, 'user32.dll!GetMenuState', root, 15, 0).result, 1);
  assert.equal(call(r, 'user32.dll!InsertMenuA', popup, 0, 0x400, 16, label).result, 1);
  assert.equal(call(r, 'user32.dll!GetMenuItemCount', popup).result, 2);
  assert.equal(call(r, 'user32.dll!DeleteMenu', popup, 0, 0x400).result, 1);
  assert.equal(call(r, 'user32.dll!GetMenuState', root, 16, 0).result, 0xffffffff);
  assert.equal(call(r, 'user32.dll!AppendMenuA', popup, 0x10, root, label).result, 0);
});

test('resource submenus have stable handles; RemoveMenu retains them and DeleteMenu destroys them', () => {
  const r = runtime();
  const bytes = words(
    0,
    0,
    0x90,
    ...text('&Root'),
    0x90,
    ...text('&Nested'),
    0x80,
    7,
    ...text('&Run'),
  );
  const template = r.allocate(bytes.length);
  r.data.set(bytes, template);
  const root = call(r, 'user32.dll!LoadMenuIndirectW', template).result;
  assert.ok(root);
  const child = call(r, 'user32.dll!GetSubMenu', root, 0).result;
  const nested = call(r, 'user32.dll!GetSubMenu', child, 0).result;
  assert.ok(child && nested);
  assert.equal(call(r, 'user32.dll!GetSubMenu', root, 0).result, child);
  assert.equal(call(r, 'user32.dll!GetMenuItemID', nested, 0).result, 7);
  assert.equal(call(r, 'user32.dll!GetSubMenu', nested, 0).result, 0);
  assert.equal(call(r, 'user32.dll!GetSubMenu', root, 99).result, 0);
  assert.equal(call(r, 'user32.dll!RemoveMenu', root, 0, 0x400).result, 1);
  assert.equal(call(r, 'user32.dll!GetMenuItemCount', root).result, 0);
  assert.equal(call(r, 'user32.dll!GetMenuItemCount', nested).result, 1);
  const label = r.allocString('&Reattached');
  assert.equal(call(r, 'user32.dll!AppendMenuA', root, 0x10, child, label).result, 1);
  assert.equal(call(r, 'user32.dll!DeleteMenu', root, 0, 0x400).result, 1);
  assert.equal(r.menus.byHandle.has(child), false);
  assert.equal(r.menus.byHandle.has(nested), false);
  assert.equal(call(r, 'user32.dll!DestroyMenu', root).result, 1);
  assert.equal(r.menus.byHandle.size, 0);
});

test('MENUITEMINFO updates nested commands atomically and queries bounded ANSI/Unicode data', () => {
  const r = runtime(),
    root = call(r, 'user32.dll!CreateMenu').result,
    sub = call(r, 'user32.dll!CreatePopupMenu').result,
    info = r.allocate(48);
  const set = (offset, value) => r.write32(info + offset, value);
  const api = (name, menu = root, id = 20, position = 0) =>
    call(r, `user32.dll!${name}`, menu, id, position, info);
  call(r, 'user32.dll!AppendMenuA', root, 0x10, sub, r.allocString('Sub'));
  set(0, 48);
  set(4, 0x163);
  set(8, 0x200);
  set(12, 0x1000);
  set(16, 20);
  set(32, 0xfedcba98);
  set(36, r.allocString('\x80 café')); // allocString writes raw single-byte units.
  assert.deepEqual(api('InsertMenuItemA', sub, 0, 1), { result: 1, argc: 4 });
  set(4, 0x1ef);
  set(36, 0);
  set(40, 0);
  assert.deepEqual(api('GetMenuItemInfoA'), { result: 1, argc: 4 });
  assert.equal(r.read32(info + 16), 20);
  assert.equal(r.read32(info + 32), 0xfedcba98);
  assert.equal(r.read32(info + 40), 6);
  assert.equal(r.read32(info + 8), 0x200);
  assert.equal(r.read32(info + 12), 0x1000);
  const output = r.allocate(16);
  r.data.fill(0xcc, output, output + 16);
  set(4, 0x40);
  set(36, output);
  set(40, 3);
  assert.equal(api('GetMenuItemInfoA').result, 1);
  assert.deepEqual([...r.data.subarray(output, output + 4)], [0x80, 32, 0, 0xcc]);
  assert.equal(r.read32(info + 40), 2);
  set(36, output);
  set(40, 16);
  assert.equal(api('GetMenuItemInfoW').result, 1);
  assert.equal(r.wideString(output), '€ café');
  const original = { ...r.menus.byHandle.get(sub).items[0] };
  set(4, 0x66);
  set(16, 21);
  set(20, root);
  set(32, 0);
  set(36, r.allocString('Changed'));
  assert.equal(api('SetMenuItemInfoA').result, 0);
  assert.equal(r.lastError, 87);
  assert.deepEqual(r.menus.byHandle.get(sub).items[0], original);
  set(4, 0x102);
  set(8, 0x100);
  set(16, 21);
  assert.equal(api('SetMenuItemInfoA').result, 0);
  assert.equal(r.lastError, 120);
  assert.deepEqual(r.menus.byHandle.get(sub).items[0], original);
  set(0, 44);
  set(4, 0x22);
  assert.equal(api('GetMenuItemInfoA').result, 1);
  set(4, 0x80);
  assert.equal(api('GetMenuItemInfoA').result, 0);
  set(0, 48);
  set(4, 0x50);
  assert.equal(api('GetMenuItemInfoA').result, 0);
  set(0, 43);
  set(4, 2);
  assert.equal(api('GetMenuItemInfoA').result, 0);
  set(0, 48);
  set(4, 2);
  set(16, 22);
  assert.equal(api('InsertMenuItemA', sub, 0xffffffff, 1).result, 1);
  assert.equal(r.menus.byHandle.get(sub).items[1].separator, true);
});

test('menu radio ranges stay in one parent and handle UINT bounds without range iteration', () => {
  const r = runtime(),
    root = call(r, 'user32.dll!CreateMenu').result,
    first = call(r, 'user32.dll!CreatePopupMenu').result,
    second = call(r, 'user32.dll!CreatePopupMenu').result,
    text = r.allocString('Choice');
  call(r, 'user32.dll!AppendMenuA', root, 0x10, first, text);
  call(r, 'user32.dll!AppendMenuA', root, 0x10, second, text);
  for (const [menu, id] of [
    [first, 10],
    [first, 12],
    [second, 11],
  ])
    call(r, 'user32.dll!AppendMenuA', menu, 8, id, text);
  assert.deepEqual(call(r, 'user32.dll!CheckMenuRadioItem', root, 10, 12, 12, 0), {
    result: 1,
    argc: 5,
  });
  assert.equal(call(r, 'user32.dll!GetMenuState', root, 10, 0).result, 0);
  assert.equal(call(r, 'user32.dll!GetMenuState', root, 11, 0).result, 8);
  assert.equal(call(r, 'user32.dll!GetMenuState', root, 12, 0).result, 0x208);
  assert.equal(call(r, 'user32.dll!CheckMenuRadioItem', first, 0, 0xffffffff, 0, 0x400).result, 1);
  assert.equal(call(r, 'user32.dll!GetMenuState', first, 12, 0).result, 0x200);
  assert.equal(
    call(r, 'user32.dll!CheckMenuRadioItem', first, 0, 0xffffffff, 0xffffffff, 0x400).result,
    0,
  );
  assert.equal(call(r, 'user32.dll!GetMenuState', first, 10, 0).result, 0x200);
});

test('PtInRect reads a full signed POINT passed by value, with exclusive bottom/right', () => {
  const r = runtime(),
    rect = r.allocate(16);
  [-70000, -4, 90000, 10].forEach((v, i) => r.write32(rect + i * 4, v));
  for (const [x, y, expected] of [
    [80000, 0, 1],
    [-70000, -4, 1],
    [-70001, 0, 0],
    [90000, 0, 0],
    [0, 10, 0],
  ])
    assert.deepEqual(call(r, 'user32.dll!PtInRect', rect, x, y), { result: expected, argc: 3 });
});

test('GetUserName uses BOOL/LastError and counts ANSI bytes or UTF-16 units including the terminator', () => {
  const r = runtime(),
    size = r.allocate(4),
    buffer = r.allocate(64);
  for (const wide of [false, true]) {
    const name = `advapi32.dll!GetUserName${wide ? 'W' : 'A'}`;
    r.write32(size, 0);
    assert.deepEqual(call(r, name, 0, size), { result: 0, argc: 2 });
    assert.equal(r.lastError, 122);
    assert.equal(r.read32(size), 12);
    r.data.fill(0xcc, buffer, buffer + 64);
    r.write32(size, 11);
    assert.equal(call(r, name, buffer, size).result, 0);
    assert.equal(r.read32(size), 12);
    assert.ok(r.data.subarray(buffer, buffer + 64).every((b) => b === 0xcc));
    r.lastError = 12345;
    assert.deepEqual(call(r, name, buffer, size), { result: 1, argc: 2 });
    assert.equal(r.read32(size), 12);
    assert.equal(wide ? r.wideString(buffer) : r.string(buffer), 'WineBrowser');
    assert.equal(r.data[buffer + (wide ? 24 : 12)], 0xcc);
    assert.equal(r.lastError, 12345);
    assert.equal(call(r, name, buffer, 0).result, 0);
    assert.equal(r.lastError, 87);
  }
});

test('SaveDC/RestoreDC restore nested attributes and retain saved bitmap selections', () => {
  const r = runtime(),
    dc = call(r, 'gdi32.dll!CreateCompatibleDC', 0).result;
  const other = call(r, 'gdi32.dll!CreateCompatibleDC', 0).result;
  const bitmap = call(r, 'gdi32.dll!CreateCompatibleBitmap', dc, 12, 12).result;
  const stock = call(r, 'gdi32.dll!SelectObject', dc, bitmap).result;
  call(r, 'gdi32.dll!SetTextColor', dc, 0x332211);
  assert.equal(call(r, 'gdi32.dll!SaveDC', dc).result, 1);
  call(r, 'gdi32.dll!SelectObject', dc, stock);
  assert.equal(call(r, 'gdi32.dll!DeleteObject', bitmap).result, 0);
  assert.equal(call(r, 'gdi32.dll!SelectObject', other, bitmap).result, 0);
  call(r, 'gdi32.dll!SetTextColor', dc, 0xff);
  assert.equal(call(r, 'gdi32.dll!SaveDC', dc).result, 2);
  call(r, 'gdi32.dll!SetTextColor', dc, 0xff00);
  assert.equal(call(r, 'gdi32.dll!RestoreDC', dc, -1).result, 1);
  assert.equal(call(r, 'gdi32.dll!GetTextColor', dc).result, 0xff);
  assert.equal(call(r, 'gdi32.dll!RestoreDC', dc, 1).result, 1);
  assert.equal(call(r, 'gdi32.dll!GetTextColor', dc).result, 0x332211);
  assert.equal(call(r, 'gdi32.dll!GetCurrentObject', dc, 7).result, bitmap);
  assert.equal(call(r, 'gdi32.dll!RestoreDC', dc, -1).result, 0);
  call(r, 'gdi32.dll!SelectObject', dc, stock);
  assert.equal(call(r, 'gdi32.dll!DeleteObject', bitmap).result, 1);
});

test('DrawEdge uses the supplied memory HDC, restores selection/position and adjusts only requested edges', () => {
  const r = runtime(),
    dc = call(r, 'gdi32.dll!CreateCompatibleDC', 0).result;
  const bitmap = call(
    r,
    'gdi32.dll!CreateCompatibleBitmap',
    call(r, 'user32.dll!GetDC', 0).result,
    10,
    10,
  ).result;
  call(r, 'gdi32.dll!SelectObject', dc, bitmap);
  const pen = call(r, 'gdi32.dll!GetCurrentObject', dc, 1).result;
  call(r, 'gdi32.dll!MoveToEx', dc, 7, 8, 0);
  const rect = r.allocate(16);
  [1, 1, 9, 9].forEach((v, i) => r.write32(rect + i * 4, v));
  assert.equal(call(r, 'user32.dll!DrawEdge', dc, rect, 5, 15 | 0x2000).result, 1);
  assert.deepEqual(
    [0, 4, 8, 12].map((i) => r.read32(rect + i)),
    [3, 3, 7, 7],
  );
  assert.equal(call(r, 'gdi32.dll!GetPixel', dc, 2, 2).result, 0xffffff);
  assert.equal(call(r, 'gdi32.dll!GetPixel', dc, 7, 7).result, 0x808080);
  assert.equal(call(r, 'gdi32.dll!GetCurrentObject', dc, 1).result, pen);
  const point = r.allocate(8);
  call(r, 'gdi32.dll!GetCurrentPositionEx', dc, point);
  assert.deepEqual([r.read32(point), r.read32(point + 4)], [7, 8]);
  // Repeat enough to catch leaked temporary pens against the 4096-object bound.
  for (let i = 0; i < 1050; i++)
    assert.equal(call(r, 'user32.dll!DrawEdge', dc, rect, 10, 15).result, 1);
});

test('GetDlgItemInt writes lpTranslated and parses bounded decimal edit text with the PE32 ABI', async () => {
  const r = runtime(),
    translated = r.allocate(4),
    control = { id: 20, parentId: 10, controlId: 141, title: '12' };
  r.windows.windows.set(20, control);
  for (const [text, signed, expected, valid] of [
    ['12', 0, 12, 1],
    ['  +20 trailing', 0, 20, 1],
    ['-24', 1, -24 >>> 0, 1],
    ['-24', 0, 0, 0],
    ['4294967295', 0, 0xffffffff, 1],
    ['4294967296', 0, 0, 0],
    ['2147483648', 1, 0, 0],
    ['abc', 0, 0, 0],
  ]) {
    control.title = text;
    r.write32(translated, 123);
    assert.deepEqual(await call(r, 'user32.dll!GetDlgItemInt', 10, 141, translated, signed), {
      result: expected,
      argc: 4,
    });
    assert.equal(r.read32(translated), valid);
  }
});

test('popup menu return-command, WM_COMMAND, cancellation and disabled items follow the actual selection', async () => {
  const r = runtime(),
    popup = call(r, 'user32.dll!CreatePopupMenu').result;
  const text = r.allocString('Run');
  call(r, 'user32.dll!AppendMenuA', popup, 0, 7, text);
  call(r, 'user32.dll!AppendMenuA', popup, 1, 8, text);
  const sent = [],
    posted = [];
  r.windows.windows.set(10, { id: 10 });
  r.windows.send = async (...args) => {
    sent.push(args);
    return 0;
  };
  r.windows.post = (...args) => posted.push(args);
  let chosen = 7;
  r.request = async (kind, detail) => {
    assert.equal(kind, 'popup-menu');
    assert.equal(detail.owner, 10);
    assert.equal(detail.items[1].enabled, false);
    return chosen;
  };
  assert.deepEqual(await call(r, 'user32.dll!TrackPopupMenu', popup, 0x100, 30, 40, 0, 10, 0), {
    result: 7,
    argc: 7,
  });
  assert.deepEqual(posted, []);
  assert.deepEqual(await call(r, 'user32.dll!TrackPopupMenuEx', popup, 0, 30, 40, 10, 0), {
    result: 1,
    argc: 6,
  });
  assert.deepEqual(posted, [[10, 0x111, 7, 0]]);
  posted.length = 0;
  chosen = 0;
  assert.equal((await call(r, 'user32.dll!TrackPopupMenu', popup, 0, 30, 40, 0, 10, 0)).result, 0);
  assert.deepEqual(posted, []);
  chosen = 8;
  assert.equal(
    (await call(r, 'user32.dll!TrackPopupMenu', popup, 0x100, 30, 40, 0, 10, 0)).result,
    0,
  );
  assert.deepEqual(posted, []);
  assert.deepEqual(sent.slice(-3), [
    [10, 0x211, 1, 0],
    [10, 0x117, popup, 0],
    [10, 0x212, 1, 0],
  ]);
});
