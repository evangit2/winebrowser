import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime, inspect } from '../src/runtime.js';
import { API_NAMES } from '../src/win32.js';
import { canonicalHostSymbol } from '../src/host-export-ordinals.js';
import { expandSZDD } from '../src/win32-lz.js';
import { readDialogTemplate } from '../src/win32-dialogs.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup(t, files = new Map()) {
  const r = new Runtime(iced, {
    files: new Map([['console.exe', exe], ...files]),
    exe: 'console.exe',
  });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  return { r, call: (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] >>> 0) };
}
function szdd() {
  return Uint8Array.from([
    0x53, 0x5a, 0x44, 0x44, 0x88, 0xf0, 0x27, 0x33, 0x41, 0x74, 9, 0, 0, 0, 7, 65, 66, 67, 0xf0,
    0xf3,
  ]);
}
function template(extended = false) {
  const bytes = new Uint8Array(256),
    v = new DataView(bytes.buffer);
  let at = 0;
  const word = (n) => {
    v.setUint16(at, n, true);
    at += 2;
  };
  const dword = (n) => {
    v.setUint32(at, n, true);
    at += 4;
  };
  const text = (s) => {
    for (const c of s) word(c.charCodeAt(0));
    word(0);
  };
  const align = () => {
    at = (at + 3) & ~3;
  };
  if (extended) {
    word(1);
    word(0xffff);
    dword(0);
    dword(0);
    dword(0x90c80000);
  } else {
    dword(0x90c80000);
    dword(0);
  }
  word(2);
  [0, 0, 180, 100].forEach(word);
  word(0);
  word(0);
  text('Installer');
  for (let i = 0; i < 2; i++) {
    align();
    if (extended) {
      dword(0);
      dword(0);
      dword(0x50010000);
    } else {
      dword(0x50010000);
      dword(0);
    }
    [10 + i * 40, 10, 30, 15].forEach(word);
    if (extended) dword(10 + i);
    else word(10 + i);
    word(0xffff);
    word(0x80);
    text(i ? 'Cancel' : 'Next');
    word(0);
  }
  return bytes.subarray(0, at);
}
test('reported installer imports have providers and comctl32 ordinal 17 resolves to its real initializer', (t) => {
  const { r } = setup(t);
  for (const [dll, names] of Object.entries({
    'user32.dll': [
      'CharNextA',
      'GetWindow',
      'GetNextDlgTabItem',
      'SetParent',
      'CreateDialogIndirectParamA',
    ],
    'gdi32.dll': ['CreateDIBitmap', 'EnumFontFamiliesExA'],
    'shell32.dll': ['SHBrowseForFolderA', 'SHGetPathFromIDListA', 'SHGetMalloc'],
    'lz32.dll': ['LZOpenFileA', 'LZCopy', 'LZClose'],
  }))
    for (const name of names) {
      assert.ok(API_NAMES[dll].includes(name));
      assert.equal(typeof r.apiProvider.get(dll + '!' + name), 'function');
    }
  assert.equal(
    canonicalHostSymbol('comctl32.dll', 17, API_NAMES['comctl32.dll']),
    'InitCommonControls',
  );
  const resolved = r.graph.resolve(r.graph.hostProxy('comctl32.dll'), 17);
  assert.equal(resolved.symbol, 'InitCommonControls');
});
test('CharNext preserves the terminator and advances ANSI bytes or UTF-16 code units', (t) => {
  const { r, call } = setup(t);
  const a = r.allocString('a'),
    w = r.allocString('😀', true);
  assert.equal(call('user32.dll!CharNextA', a).result, a + 1);
  assert.equal(call('user32.dll!CharNextA', a + 1).result, a + 1);
  assert.equal(call('user32.dll!CharNextW', w).result, w + 2);
  assert.equal(call('user32.dll!CharNextW', w + 4).result, w + 4);
});
for (const extended of [false, true])
  test(`modeless ${extended ? 'extended' : 'standard'} dialog creates owned windows, controls and dispatches callbacks`, async (t) => {
    const { r, call } = setup(t);
    const bytes = template(extended),
      p = r.allocate(bytes.length);
    r.data.set(bytes, p);
    assert.equal(readDialogTemplate(bytes).items[0].className, 'button');
    assert.equal(readDialogTemplate(bytes.subarray(0, bytes.length - 1)), null);
    const events = [];
    r.callGuest = async (proc, args) => {
      events.push({ proc, args });
      return args[1] === 0x110 ? 1 : 0;
    };
    const dialog = (
      await call('user32.dll!CreateDialogIndirectParamA', r.pe.imageBase, p, 0, 0x401000, 123)
    ).result;
    assert.ok(dialog);
    const initialized = events.find((event) => event.args[1] === 0x110);
    assert.ok(initialized);
    assert.equal(initialized.args[3], 123);
    assert.equal(r.windows.windows.get(dialog).width, 360);
    assert.equal(r.windows.windows.get(dialog).height, 200);
    const children = [...r.windows.windows.values()].filter((w) => w.parentId === dialog);
    assert.equal(children.length, 2);
    assert.equal(call('user32.dll!GetWindow', dialog, 5).result, children[0].id);
    assert.equal(call('user32.dll!GetWindow', children[0].id, 2).result, children[1].id);
    assert.equal(
      call('user32.dll!GetNextDlgTabItem', dialog, children[1].id, 0).result,
      children[0].id,
    );
    children[1].enabled = false;
    assert.equal(
      call('user32.dll!GetNextDlgTabItem', dialog, children[0].id, 0).result,
      children[0].id,
    );
    await r.windows.send(dialog, 0x111, 10, children[0].id);
    assert.equal(events.at(-1).args[1], 0x111);
    const owned = (
      await call('user32.dll!CreateDialogIndirectParamA', r.pe.imageBase, p, dialog, 0x401000, 0)
    ).result;
    assert.ok(owned);
    assert.equal(r.windows.windows.get(owned).parentId, 0);
    assert.equal(call('user32.dll!GetWindow', owned, 4).result, dialog);
    assert.equal(call('user32.dll!SetParent', children[0].id, owned).result, dialog);
    assert.equal(r.windows.windows.get(children[0].id).parentId, owned);
    assert.equal(call('user32.dll!SetParent', owned, children[0].id).result, 0);
    assert.equal(r.lastError, 87);
  });
test('LZ32 expands overlapping SZDD references, reads/seeks and copies into actual virtual files', (t) => {
  const bytes = szdd();
  assert.equal(new TextDecoder().decode(expandSZDD(bytes)), 'ABCABCABC');
  assert.throws(() => expandSZDD(bytes.subarray(0, 18)), /Truncated/);
  const { r, call } = setup(
    t,
    new Map([
      ['payload.da_', bytes],
      ['plain.dat', Uint8Array.of(1, 2, 3)],
    ]),
  );
  const ofs = r.allocate(136),
    input = r.allocString('payload.dat'),
    output = r.allocString('expanded.dat'),
    buffer = r.allocate(20);
  const source = call('lz32.dll!LZOpenFileA', input, ofs, 0).result;
  assert.ok(source >= 0x400 && source < 0x410);
  assert.equal(call('lz32.dll!LZRead', source, buffer, 4).result, 4);
  assert.equal(r.string(buffer), 'ABCA');
  assert.equal(call('lz32.dll!LZSeek', source, 3, 2).result, 6);
  assert.equal(call('lz32.dll!LZRead', source, buffer, 20).result, 3);
  assert.deepEqual([...r.data.slice(buffer, buffer + 3)], [65, 66, 67]);
  assert.equal(call('lz32.dll!LZSeek', source, -1, 0).result, 0xfffffff9);
  call('lz32.dll!LZSeek', source, 0, 0);
  const dest = call('lz32.dll!LZOpenFileA', output, ofs, 0x1001).result;
  assert.equal(call('lz32.dll!LZCopy', source, dest).result, 9);
  assert.equal(new TextDecoder().decode(r.files.get('expanded.dat')), 'ABCABCABC');
  assert.ok(r.dirty.has('expanded.dat'));
  call('lz32.dll!LZClose', source);
  call('lz32.dll!LZClose', dest);
  assert.equal(call('lz32.dll!LZRead', source, buffer, 1).result, 0xffffffff);
  const name = r.allocString('payload.da_'),
    expanded = r.allocate(260);
  assert.equal(call('lz32.dll!GetExpandedNameA', name, expanded).result, 1);
  assert.equal(r.string(expanded), 'payload.dat');
  const plain = call('lz32.dll!LZOpenFileA', r.allocString('plain.dat'), ofs, 0).result;
  assert.equal(call('lz32.dll!LZRead', plain, buffer, 20).result, 3);
});
test('shell folder chooser callbacks, copied PIDLs and IMalloc ownership round trip', async (t) => {
  const { r, call } = setup(t, new Map([['assets/data.bin', Uint8Array.of(1)]]));
  const info = r.allocate(32),
    name = r.allocate(260),
    out = r.allocate(4);
  r.write32(info + 8, name);
  r.write32(info + 20, 0x401000);
  r.write32(info + 24, 987);
  const events = [];
  r.callGuest = async (_proc, args) => {
    events.push(args);
    if (args[1] === 1)
      await r.windows.send(args[0], 0x466, 1, r.allocString('C:\\winebrowser\\assets'));
    return 0;
  };
  r.request = async (kind, detail) => {
    assert.equal(kind, 'browse-folder');
    assert.equal(detail.selected, 'assets');
    assert.ok(detail.folders.some((f) => f.path === 'assets'));
    return detail.selected;
  };
  const item = (await call('shell32.dll!SHBrowseForFolderA', info)).result;
  assert.ok(item);
  assert.equal(r.string(name), 'assets');
  assert.deepEqual(
    events.map((e) => e[1]),
    [1, 2],
  );
  assert.equal(events[0][3], 987);
  const path = r.allocate(260);
  assert.equal(call('shell32.dll!SHGetPathFromIDListA', item, path).result, 1);
  assert.equal(r.string(path), 'C:\\winebrowser\\assets');
  const count = r.view.getUint16(item, true) + 2,
    copy = r.allocate(count);
  r.data.set(r.data.slice(item, item + count), copy);
  assert.equal(call('shell32.dll!SHGetPathFromIDListA', copy, path).result, 1);
  assert.equal(call('shell32.dll!SHGetMalloc', out).result, 0);
  const object = r.read32(out),
    vtable = r.read32(object);
  const invoke = async (slot, ...args) =>
    r.thunks.get(r.read32(vtable + slot * 4)).invoke(r, (i) => [object, ...args][i] >>> 0);
  assert.equal((await invoke(7, item)).result, 1);
  await invoke(5, item);
  assert.equal((await invoke(7, item)).result, 0);
  const allocated = (await invoke(3, 80)).result;
  assert.equal((await invoke(6, allocated)).result, 80);
  await invoke(5, allocated);
  await invoke(2);
  r.request = async () => null;
  assert.equal((await call('shell32.dll!SHBrowseForFolderA', info)).result, 0);
});
test('CreateDIBitmap honours palette indexes, bottom-up rows and top-down RGB565 bitfields', (t) => {
  const { r, call } = setup(t),
    dc = call('gdi32.dll!CreateCompatibleDC', 0).result;
  const info = r.allocate(52),
    bits = r.allocate(8);
  r.write32(info, 40);
  r.write32(info + 4, 2);
  r.write32(info + 8, 2);
  r.view.setUint16(info + 12, 1, true);
  r.view.setUint16(info + 14, 8, true);
  r.write32(info + 32, 2);
  r.data.set([0, 0, 255, 0, 0, 255, 0, 0], info + 40);
  r.data.set([1, 0, 0, 0, 0, 1, 0, 0], bits);
  const bitmap = call('gdi32.dll!CreateDIBitmap', dc, info, 4, bits, info, 0).result;
  assert.ok(bitmap);
  call('gdi32.dll!SelectObject', dc, bitmap);
  assert.equal(call('gdi32.dll!GetPixel', dc, 0, 0).result, 0x0000ff);
  assert.equal(call('gdi32.dll!GetPixel', dc, 0, 1).result, 0x00ff00);
  r.write32(info + 8, -2);
  r.view.setUint16(info + 14, 16, true);
  r.write32(info + 16, 3);
  [0xf800, 0x7e0, 0x1f].forEach((m, i) => r.write32(info + 40 + i * 4, m));
  r.view.setUint16(bits, 0x1f, true);
  r.view.setUint16(bits + 2, 0xf800, true);
  r.view.setUint16(bits + 4, 0x7e0, true);
  const rgb = call('gdi32.dll!CreateDIBitmap', dc, info, 4, bits, info, 0).result;
  assert.ok(rgb);
  call('gdi32.dll!SelectObject', dc, rgb);
  assert.equal(call('gdi32.dll!GetPixel', dc, 0, 0).result, 0xff0000);
  assert.equal(call('gdi32.dll!GetPixel', dc, 0, 1).result, 0xff00);
});
test('font enumeration returns real callback records and stops at the caller request', async (t) => {
  const { r, call } = setup(t),
    dc = call('gdi32.dll!CreateCompatibleDC', 0).result,
    info = r.allocate(60);
  r.data[info + 23] = 1;
  r.gdiTextRasterizer = {
    rasterize: () => ({ width: 9, height: 16, ascent: 12, alpha: new Uint8Array(144) }),
  };
  const records = [];
  r.callGuest = async (_p, args) => {
    records.push({
      face: r.string(args[0] + 28),
      height: r.read32(args[1]),
      type: args[2],
      param: args[3],
    });
    return records.length === 2 ? 0 : 1;
  };
  assert.equal((await call('gdi32.dll!EnumFontFamiliesExA', dc, info, 0x401000, 123, 0)).result, 0);
  assert.deepEqual(
    records.map((r) => r.face),
    ['Arial', 'Times New Roman'],
  );
  assert.equal(records[0].height, 16);
  assert.equal(records[0].param, 123);
  assert.equal(records[0].type, 2);
});

test('modal dialogs disable their owner, wake on EndDialog and restore owner state', async (t) => {
  const { r, call } = setup(t);
  const bytes = template(),
    p = r.allocate(bytes.length);
  r.data.set(bytes, p);
  r.callGuest = async () => 1;
  const owner = (
    await call('user32.dll!CreateDialogIndirectParamA', r.pe.imageBase, p, 0, 0x401000, 0)
  ).result;
  const window = r.windows.windows.get(owner);
  r.callGuest = async (_proc, args) => {
    if (args[1] === 0x110) {
      assert.equal(window.enabled, false);
      setTimeout(() => call('user32.dll!EndDialog', args[0], 42), 5);
    }
    // WM_PAINT must be handled so the synthetic update is consumed.
    if (args[1] === 0xf) await call('user32.dll!DefWindowProcA', ...args);
    return 1;
  };
  const result = await Promise.race([
    call('user32.dll!DialogBoxIndirectParamA', r.pe.imageBase, p, owner, 0x401000, 123),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(Error('modal wake timed out')), 2000);
      timer.unref();
    }),
  ]);
  assert.equal(result.result, 42);
  assert.equal(window.enabled, true);
  assert.equal(r.dialogs.byWindow.size, 1);
});
