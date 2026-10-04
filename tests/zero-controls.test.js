import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { flushGdi } from '../src/win32-gdi.js';
test('zero-size framed child HWNDs retain text/DCs, precise rectangles and border restoration through resizing', async (t) => {
  const bytes = new Uint8Array(await readFile('public/demos/console/console.exe')),
    events = [];
  const r = new Runtime(iced, {
    files: new Map([['console.exe', bytes]]),
    exe: 'console.exe',
    emit: (e) => events.push(e),
  });
  t.after(() => r.windows.dispose());
  const call = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] ?? 0);
  r.callGuest = async (_p, a) => (await call('user32.dll!DefWindowProcA', ...a)).result;
  const cls = r.allocate(40),
    name = r.allocString('ZeroOwner');
  r.data.fill(0, cls, cls + 40);
  r.write32(cls + 4, 0x12345678);
  r.write32(cls + 16, r.pe.imageBase);
  r.write32(cls + 36, name);
  call('user32.dll!RegisterClassA', cls);
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
  const edit = (
    await call(
      'user32.dll!CreateWindowExA',
      0x210,
      r.allocString('EDIT'),
      r.allocString('keep text'),
      0x40000004,
      8,
      9,
      0,
      0,
      owner,
      20,
      r.pe.imageBase,
      0,
    )
  ).result;
  assert.ok(edit);
  const rect = r.allocate(16);
  const size = (api) => {
    call('user32.dll!' + api, edit, rect);
    return [
      (r.read32(rect + 8) - r.read32(rect)) | 0,
      (r.read32(rect + 12) - r.read32(rect + 4)) | 0,
    ];
  };
  assert.deepEqual(size('GetWindowRect'), [0, 0]);
  assert.deepEqual(size('GetClientRect'), [0, 0]);
  const custom = (
    await call(
      'user32.dll!CreateWindowExA',
      0x200,
      name,
      r.allocString(''),
      0x40000000,
      8,
      9,
      0,
      0,
      owner,
      30,
      r.pe.imageBase,
      0,
    )
  ).result;
  const dc = call('user32.dll!GetDC', custom).result;
  assert.ok(dc);
  assert.equal(call('gdi32.dll!SetPixel', dc, 0, 0, 0xff).result, 0xffffffff);
  flushGdi(r);
  assert.ok(events.filter((e) => e.type === 'frame').every((e) => e.width > 0 && e.height > 0));
  assert.equal(
    (await call('user32.dll!SetWindowPos', edit, 0, 0, 0, 0, 0, 1 | 2 | 4 | 16)).result,
    1,
  );
  for (const [width, height, cw, ch] of [
    [2, 3, 2, 3],
    [320, 80, 316, 76],
    [0, 0, 0, 0],
  ]) {
    assert.equal((await call('user32.dll!MoveWindow', edit, 8, 9, width, height, 0)).result, 1);
    assert.deepEqual(size('GetWindowRect'), [width, height]);
    assert.deepEqual(size('GetClientRect'), [cw, ch]);
    assert.equal((await call('user32.dll!GetWindowTextA', edit, rect, 16)).result, 9);
    assert.equal(r.string(rect), 'keep text');
  }
  assert.equal((await call('user32.dll!MoveWindow', edit, 8, 9, 32, 24, 0)).result, 1);
  assert.equal((await call('user32.dll!MoveWindow', custom, 8, 9, 32, 24, 0)).result, 1);
  assert.equal(call('gdi32.dll!SetPixel', dc, 0, 0, 0xff).result, 0xff);
  call('user32.dll!ReleaseDC', custom, dc);
});
