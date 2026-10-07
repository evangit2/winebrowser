import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const oracle = async (name) =>
  JSON.parse(await readFile('tests/fixtures/scroll-controls/' + name + '-wine-oracle.json')).cases;
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const parent = 990;
  r.windows.windows.set(parent, {
    id: parent,
    parentId: 0,
    x: 10,
    y: 20,
    width: 300,
    height: 300,
    style: 0x90000000,
    exStyle: 0,
    visible: true,
    enabled: true,
    cls: { wide: true, proc: 0 },
    controlBorder: 0,
    invalid: null,
  });
  const call = async (name, ...args) =>
    (await r.apiProvider.get('user32.dll!' + name)(r, (i) => args[i] >>> 0)).result;
  const name = r.allocString('SCROLLBAR', true),
    info = r.allocate(60),
    state = r.allocate(28);
  const fill = (size) => {
    r.data.fill(0x55, info, info + 60);
    r.write32(info, size);
  };
  const read = () => Array.from({ length: 15 }, (_, i) => r.read32(info + 4 * i) | 0);
  const setState = async (hwnd, large = false) => {
    [28, 23, large ? -20 : 10, large ? 200000 : 40, large ? 64 : 8, large ? 80000 : 20, 0].forEach(
      (v, i) => r.write32(state + 4 * i, v),
    );
    await call('SetScrollInfo', hwnd, 2, state, 0);
  };
  return { r, parent, call, name, info, state, fill, read, setState };
}
test('SCROLLBARINFO structure, rectangles, standard object IDs and enabled states match 720 native captures', async (t) => {
  const { r, parent, call, name, info, state, fill, read, setState } = setup(t);
  const rows = await oracle('info');
  for (const vertical of [0, 1])
    for (const visible of [0, 1]) {
      const hwnd = await call(
        'CreateWindowExW',
        0,
        name,
        0,
        0x40000000 | (visible ? 0x10000000 : 0) | vertical,
        30,
        40,
        vertical ? 17 : 180,
        vertical ? 180 : 17,
        parent,
        0,
        0,
        0,
      );
      assert.ok(hwnd);
      await setState(hwnd);
      for (let stage = 0; stage < 6; stage++) {
        await call('EnableScrollBar', hwnd, 2, stage < 4 ? stage : 0);
        await call('EnableWindow', hwnd, stage !== 4);
        if (stage === 5) {
          [28, 23, 10, 40, 100, 20, 0].forEach((v, i) => r.write32(state + 4 * i, v));
          await call('SetScrollInfo', hwnd, 2, state, 0);
        }
        for (const row of rows.filter(
          (c) => c.vertical === vertical && c.visible === visible && c.stage === stage,
        )) {
          fill(row.size);
          r.lastError = 777;
          assert.equal(
            await call('GetScrollBarInfo', hwnd, row.object, info),
            row.result,
            JSON.stringify(row),
          );
          assert.equal(r.lastError, row.error);
          assert.deepEqual(read(), row.out, JSON.stringify(row));
          assert.equal(await call('GetWindowLongW', hwnd, -16), row.flags);
          assert.equal(await call('IsWindowEnabled', hwnd), row.enabled);
        }
      }
      await call('DestroyWindow', hwnd);
    }
});
test('geometry and pressed states during actual control callbacks match 36 native pointer captures', async (t) => {
  const { r, parent, call, name, info, fill, read, setState } = setup(t),
    rows = await oracle('info-pointer');
  r.windows.windows.get(parent).y = 60;
  for (const style of [0, 1]) {
    const hwnd = await call(
      'CreateWindowExW',
      0,
      name,
      0,
      0x50000000 | style,
      10,
      20,
      style ? 17 : 180,
      style ? 180 : 17,
      parent,
      0,
      0,
      0,
    );
    await setState(hwnd);
    const original = r.windows.send.bind(r.windows),
      notifications = [];
    r.windows.send = async (id, m, wp = 0, lp = 0, ...args) => {
      if (id === parent && (m === 0x114 || m === 0x115)) {
        fill(60);
        r.lastError = 777;
        const result = await call('GetScrollBarInfo', hwnd, -4, info);
        notifications.push({
          style,
          gesture,
          command: wp & 65535,
          result,
          error: r.lastError,
          out: read(),
        });
        return 0;
      }
      return original(id, m, wp, lp, ...args);
    };
    let gesture;
    const coordinate = (n) => (style ? ((n << 16) | 8) >>> 0 : ((8 << 16) | n) >>> 0);
    for (gesture = 0; gesture < 7; gesture++) {
      if (gesture === 5) await call('EnableScrollBar', hwnd, 2, 3);
      if (gesture === 6) {
        await setState(hwnd, true);
        await call('EnableScrollBar', hwnd, 2, 0);
      }
      const start = gesture === 6 ? 76 : [8, 171, 40, 104, 83, 83][gesture],
        end = gesture === 6 ? 106 : gesture === 4 ? start + 40 : start;
      await r.windows.send(hwnd, 0x201, 1, coordinate(start));
      await r.windows.send(hwnd, 0x200, 1, coordinate(end));
      await r.windows.send(hwnd, 0x202, 0, coordinate(end));
    }
    assert.deepEqual(
      notifications,
      rows.filter((c) => c.style === style),
    );
    r.windows.send = original;
    await call('DestroyWindow', hwnd);
  }
});
test('client queries forward the original SBM message to application procedures', async (t) => {
  const { r, parent, call, info, fill, read } = setup(t);
  fill(60);
  const before = read(),
    messages = [];
  r.windows.send = async (...args) => {
    messages.push(args);
    return 91;
  };
  r.lastError = 777;
  assert.equal(await call('GetScrollBarInfo', parent, -4, info), 91);
  assert.deepEqual(messages, [[parent, 0xeb, 0, info]]);
  assert.deepEqual(read(), before);
  assert.equal(r.lastError, 777);
});
