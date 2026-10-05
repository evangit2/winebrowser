import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { createWindowFromHost } from '../src/win32-windows.js';
import { describeList, listInput } from '../src/win32-lists.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
async function setup(t, style = 0x809) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const parent = (
    await createWindowFromHost(r, {
      className: 'winebrowser-dialog',
      style: 0x10000000,
      width: 400,
      height: 300,
    })
  ).id;
  const events = [],
    original = r.windows.send.bind(r.windows);
  r.windows.send = async (hwnd, msg, wp, lp, ...extra) => {
    if (hwnd === parent && [0x2b, 0x2c, 0x2d, 0x111].includes(msg)) {
      if (msg === 0x2c) r.write32(lp + 16, 25);
      events.push({
        msg,
        wp,
        fields: msg === 0x2b ? Array.from({ length: 12 }, (_, i) => r.read32(lp + i * 4)) : null,
      });
      return 0;
    }
    return original(hwnd, msg, wp, lp, ...extra);
  };
  const hwnd = (
    await createWindowFromHost(r, {
      className: 'LISTBOX',
      style: 0x50010000 | style,
      parent,
      width: 160,
      height: 60,
      controlId: 70,
      wide: true,
    })
  ).id;
  const w = r.windows.windows.get(hwnd);
  const send = async (msg, wp = 0, lp = 0) =>
    (await r.apiProvider.get('user32.dll!SendMessageW')(r, (i) => [hwnd, msg, wp, lp][i] >>> 0))
      .result;
  for (const text of ['A λ', 'B Ω', 'C €', 'D', 'E', 'F'])
    await send(0x180, 0, r.allocString(text, true));
  return {
    r,
    w,
    hwnd,
    events,
    send,
    selected: () => w.list.items.flatMap((item, i) => (item.selected ? [i] : [])),
  };
}
test('native multi-list queries and ranges respect selection/caret independence and bounded output', async (t) => {
  const { r, send, selected, events } = await setup(t);
  assert.equal(await send(0x186, 2), 0xffffffff);
  await send(0x185, 1, 1);
  await send(0x185, 1, 4);
  assert.deepEqual(selected(), [1, 4]);
  assert.equal(await send(0x188), 4);
  assert.equal(await send(0x190), 2);
  const out = r.allocate(16);
  r.data.fill(0x77, out, out + 16);
  assert.equal(await send(0x191, 1, out), 1);
  assert.equal(r.read32(out), 1);
  assert.equal(r.read32(out + 4), 0x77777777);
  assert.equal(await send(0x191, 20, out), 2);
  assert.equal(r.read32(out + 4), 4);
  assert.equal(r.read32(out + 8), 0x77777777);
  assert.equal(await send(0x191, -1, 0), 0);
  assert.equal(await send(0x185, 1, 99), 0xffffffff);
  assert.equal(await send(0x187, 99), 0xffffffff);
  await send(0x19b, 1, (2 << 16) | 4);
  assert.deepEqual(selected(), [1, 2, 3, 4]);
  await send(0x183, 4, 2);
  assert.deepEqual(selected(), [1]);
  await send(0x185, 1, -1);
  assert.equal(await send(0x190), 6);
  await send(0x185, 0, -1);
  assert.deepEqual(selected(), []);
  await send(0x19c, 2);
  await send(0x19e, 5);
  assert.equal(await send(0x19d), 2);
  assert.equal(await send(0x19f), 5);
  assert.deepEqual(selected(), []);
  assert.equal(await send(0x19c, -2), 0xffffffff);
  assert.equal(r.lastError, 1413);
  assert.equal(events.filter((e) => e.msg === 0x111 && e.wp >>> 16 === 1).length, 0);
  await send(7);
  await send(8);
  assert.deepEqual(
    events.filter((e) => e.msg === 0x111).map((e) => e.wp >>> 16),
    [4, 5],
  );
});
test('selected item identities, anchor and caret survive insertion, deletion, sorting and reset', async (t) => {
  const { r, w, send, selected } = await setup(t, 0x80b);
  await send(0x185, 1, 1);
  await send(0x185, 1, 3);
  await send(0x19e, 1);
  await send(0x19c, 3);
  await send(0x181, 0, r.allocString('0 first', true));
  assert.deepEqual(selected(), [2, 4]);
  assert.equal(await send(0x19f), 2);
  assert.equal(await send(0x19d), 4);
  await send(0x182, 0);
  assert.deepEqual(selected(), [1, 3]);
  assert.equal(await send(0x19f), 1);
  assert.equal(await send(0x19d), 3);
  await send(0x180, 0, r.allocString('0 sorted', true));
  assert.deepEqual(selected(), [2, 4]);
  await send(0x182, 4);
  assert.deepEqual(selected(), [2]);
  assert.equal(await send(0x19d), 0xffffffff);
  assert.equal(describeList(w).items[2].selected, true);
  assert.equal(describeList(w).multiple, true);
  await send(0x184);
  assert.equal(await send(0x190), 0);
  assert.equal(await send(0x188), 0xffffffff);
  assert.equal(await send(0x19d), 0xffffffff);
});
test('extended clicks, Shift shrink/expand, Control caret and Space toggle selection through native messages', async (t) => {
  const { r, w, send, selected, events } = await setup(t);
  const click = async (index, shiftKey = false, ctrlKey = false) => {
    listInput(r, w, { type: 'list-select', index, shiftKey, ctrlKey });
    const m = r.windows.queue.findLast((m) => m.message === 0x7fe0);
    assert.ok(m);
    await r.windows.send(m.hwnd, m.message, m.wParam, m.lParam);
  };
  await click(0);
  await click(4, false, true);
  assert.deepEqual(selected(), [0, 4]);
  await click(2, true);
  assert.deepEqual(selected(), [2, 3, 4]);
  r.windows.keyboardState.set(16, 0x8000);
  await send(0x100, 0x28);
  assert.deepEqual(selected(), [3, 4]);
  r.windows.keyboardState.set(16, 0);
  r.windows.keyboardState.set(17, 0x8000);
  await send(0x100, 0x24);
  assert.deepEqual(selected(), [3, 4]);
  assert.equal(await send(0x19f), 0);
  await send(0x100, 0x20);
  assert.deepEqual(selected(), [0, 3, 4]);
  r.windows.keyboardState.set(17, 0);
  await send(0x100, 0x20);
  assert.deepEqual(selected(), [0], 'unmodified Space selects the caret in an extended list');
  assert.ok(events.filter((e) => e.msg === 0x111 && e.wp >>> 16 === 1).length >= 4);
});
test('simple multiple lists toggle independently while owner callbacks report each row independently of caret', async (t) => {
  const { r, w, send, selected, events } = await setup(t, 0x59);
  await send(0x185, 1, 1);
  await send(0x185, 1, 3);
  await send(0x19e, 2);
  await send(0x100, 0x28);
  assert.deepEqual(selected(), [1, 3]);
  await send(0x100, 0x20);
  assert.deepEqual(selected(), [1]);
  const paints = events.filter((e) => e.msg === 0x2b && e.fields[2] < 6);
  assert.ok(paints.some((e) => e.fields[2] === 1 && e.fields[4] & 1));
  assert.ok(paints.some((e) => e.fields[2] === 2 && !(e.fields[4] & 1)));
  assert.equal(describeList(w).caret, 3);
  assert.equal(w.list.items[1].text, 'B Ω');
});
