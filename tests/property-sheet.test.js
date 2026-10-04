import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
async function setup(t) {
  const bytes = new Uint8Array(await readFile('public/demos/console/console.exe'));
  const r = new Runtime(iced, {
    files: new Map([['console.exe', bytes]]),
    exe: 'console.exe',
    emit: () => {},
  });
  t.after(() => r.windows.dispose());
  const call = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] ?? 0);
  const send = (id, msg, wp = 0, lp = 0) => r.windows.send(id, msg, wp, lp);
  const callbacks = [],
    notifications = [];
  let veto = 0;
  r.callGuest = async (address, args) => {
    const host = r.thunks.get(address);
    if (host?.invoke) return (await host.invoke(r, (i) => args[i] ?? 0)).result;
    const [hwnd, msg, wp, lp] = args;
    if (address === 0x12345670) {
      callbacks.push(args);
      return 1;
    }
    if (address === 0x12345671) {
      callbacks.push(args);
      return 1;
    }
    assert.equal(address, 0x12345678);
    if (msg === 0x110) notifications.push({ init: hwnd, param: r.read32(lp + 28), pointer: lp });
    if (msg === 0x4e) {
      const code = r.read32(lp + 8) | 0;
      notifications.push({ hwnd, code, close: r.read32(lp + 12) });
      r.windows.windows.get(hwnd).extra.setUint32(0, code === veto ? 1 : 0, true);
      return 1;
    }
    return 0;
  };
  const template = (caption = 'Page') => {
    const p = r.allocate(100);
    r.data.fill(0, p, p + 100);
    r.write32(p, 0x40000400);
    r.view.setUint16(p + 14, 120, true);
    r.view.setUint16(p + 16, 70, true);
    for (let i = 0; i < caption.length; i++)
      r.view.setUint16(p + 22 + i * 2, caption.charCodeAt(i), true);
    return p;
  };
  const descriptor = (wide = false, param = 7) => {
    const p = r.allocate(40);
    r.data.fill(0, p, p + 40);
    r.write32(p, 40);
    r.write32(p + 4, 1 | 8 | 0x80);
    r.write32(p + 12, template());
    r.write32(p + 20, r.allocString(wide ? 'Page Ω' : 'Page ANSI', wide));
    r.write32(p + 24, 0x12345678);
    r.write32(p + 28, param);
    r.write32(p + 32, 0x12345670);
    return p;
  };
  const header = (pages, wide = false, flags = 0x400) => {
    const p = r.allocate(40);
    r.data.fill(0, p, p + 40);
    r.write32(p, 40);
    r.write32(p + 4, flags);
    r.write32(p + 20, r.allocString(wide ? 'Settings Ω' : 'Settings', wide));
    r.write32(p + 24, pages.length);
    const array = r.allocate(pages.length * 4);
    pages.forEach((h, i) => r.write32(array + 4 * i, h));
    r.write32(p + 32, array);
    return p;
  };
  return {
    r,
    call,
    send,
    callbacks,
    notifications,
    descriptor,
    header,
    setVeto: (c) => {
      veto = c;
    },
  };
}
test('property sheet descriptors copy A/W strings, callback data and reference counters', async (t) => {
  const { r, call, callbacks, descriptor } = await setup(t);
  for (const wide of [false, true]) {
    const p = descriptor(wide),
      ref = r.allocate(4);
    r.write32(ref, 10);
    r.write32(p + 4, r.read32(p + 4) | 0x40);
    r.write32(p + 36, ref);
    const result = await call(`comctl32.dll!CreatePropertySheetPage${wide ? 'W' : 'A'}`, p);
    assert.equal(result.argc, 1);
    assert.ok(result.result);
    assert.equal(r.read32(ref), 11);
    const copy = callbacks.at(-1)[2];
    assert.notEqual(copy, p);
    assert.equal(r.read32(copy + 28), 7);
    const original = r.read32(p + 20);
    r.data.fill(0, original, original + 8);
    assert.equal(
      wide ? r.wideString(r.read32(copy + 20)) : r.string(r.read32(copy + 20)),
      wide ? 'Page Ω' : 'Page ANSI',
    );
    assert.equal((await call('comctl32.dll!DestroyPropertySheetPage', result.result)).result, 1);
    assert.equal(callbacks.at(-1)[1], 1);
    assert.equal(r.read32(ref), 10);
    assert.equal((await call('comctl32.dll!DestroyPropertySheetPage', result.result)).result, 0);
  }
});
test('modeless property sheets initialize lazily, honor validation and retain native results until destruction', async (t) => {
  const { r, call, send, notifications, callbacks, descriptor, header, setVeto } = await setup(t);
  const handles = [];
  for (const wide of [false, true])
    handles.push(
      (
        await call(
          `comctl32.dll!CreatePropertySheetPage${wide ? 'W' : 'A'}`,
          descriptor(wide, wide ? 9 : 7),
        )
      ).result,
    );
  const sheet = (await call('comctl32.dll!PropertySheetA', header(handles))).result;
  assert.ok(r.windows.windows.has(sheet));
  assert.equal(notifications.filter((n) => n.init).length, 1);
  const page1 = await send(sheet, 0x476);
  assert.ok(page1);
  assert.equal((await call('comctl32.dll!DestroyPropertySheetPage', handles[0])).result, 0);
  setVeto(-201);
  assert.equal(await send(sheet, 0x465, 1), 0);
  assert.equal(await send(sheet, 0x476), page1);
  setVeto(0);
  assert.equal(await send(sheet, 0x465, 1), 1);
  const page2 = await send(sheet, 0x476);
  assert.notEqual(page1, page2);
  assert.equal(notifications.filter((n) => n.init).length, 2);
  assert.equal(await send(sheet, 0x481, page2), 1);
  assert.equal(await send(sheet, 0x484, 1), handles[1]);
  assert.equal(r.windows.windows.get(page1).visible, false);
  assert.equal(r.windows.windows.get(page2).visible, true);
  await send(sheet, 0x468, page2);
  setVeto(-202);
  assert.equal(await send(sheet, 0x46e), 0);
  assert.ok(r.windows.windows.has(sheet));
  setVeto(0);
  assert.equal(await send(sheet, 0x46e), 1);
  assert.equal(await send(sheet, 0x476), page1);
  assert.ok(notifications.some((n) => n.code === -202 && n.close === 0));
  await send(sheet, 0x465, 1);
  setVeto(-209);
  await send(sheet, 0x111, 2);
  assert.equal(await send(sheet, 0x476), page2);
  setVeto(0);
  await send(sheet, 0x111, 2);
  assert.equal(await send(sheet, 0x476), 0);
  assert.equal(await send(sheet, 0x487), 0);
  assert.equal(notifications.filter((n) => n.code === -203).length, 2);
  assert.ok(notifications.filter((n) => n.code === -203).every((n) => n.close === 0));
  await call('user32.dll!DestroyWindow', sheet);
  assert.equal(callbacks.filter((n) => n[1] === 1).length, 2);
  assert.equal(r.propertySheets.pages.size, 0);
});
test('property sheet rejects wizard and malformed descriptors instead of pretending they work', async (t) => {
  const { r, call, descriptor, header } = await setup(t);
  const p = descriptor();
  r.write32(p + 4, 0x1000);
  assert.equal((await call('comctl32.dll!CreatePropertySheetPageA', p)).result, 0);
  assert.equal(r.lastError, 120);
  r.write32(p, 36);
  assert.equal((await call('comctl32.dll!CreatePropertySheetPageA', p)).result, 0);
  const h = header([0], false, 0x20);
  assert.equal((await call('comctl32.dll!PropertySheetA', h)).result, 0xffffffff);
  assert.equal(r.lastError, 120);
  assert.equal(r.windows.windows.size, 0);
});
