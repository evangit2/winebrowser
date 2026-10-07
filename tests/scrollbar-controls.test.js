import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { scrollbarMessage, controlScrollState } from '../src/win32-scrollbars.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const capture = async (name) =>
  JSON.parse(await readFile('tests/fixtures/scroll-controls/' + name + '-wine-oracle.json')).cases;
const states = JSON.parse(await readFile('tests/fixtures/scroll-controls/wine-oracle.json')).cases;
const messages = await capture('messages'),
  keys = await capture('keys'),
  pointers = await capture('pointer'),
  enabled = await capture('enable');
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const window = {
    id: 100,
    parentId: 101,
    controlType: 'scrollbar',
    style: 0,
    width: 180,
    height: 17,
    cls: { wide: true, proc: 0 },
    enabled: true,
  };
  r.windows.windows.set(100, window);
  r.windows.windows.set(101, { id: 101, style: 0, cls: { wide: true, proc: 0 }, enabled: true });
  r.windows.emit = () => {};
  r.windows.isEnabled = () => true;
  r.windows.setFocus = async () => 0;
  r.windows.changeCapture = async (id) => {
    r.windows.capture = id;
    return 0;
  };
  const notifications = [];
  r.windows.send = async (hwnd, m, wp, lp) => {
    if (hwnd === 100) return (await scrollbarMessage(r, window, m, wp, lp)) ?? 0;
    const s = controlScrollState(window);
    notifications.push({
      message: m,
      command: wp & 65535,
      positionWord: wp >>> 16,
      target: lp === 100 ? 1 : 0,
      pos: s.pos,
      track: s.tracking ? s.track : s.pos,
    });
    return 0;
  };
  const info = r.allocate(28),
    range = r.allocate(8);
  const write = (values) => values.forEach((v, i) => r.write32(info + i * 4, v));
  const read = () =>
    [0, 1, 2, 3, 4, 5, 6].map((i) =>
      [2, 3, 5, 6].includes(i) ? r.read32(info + i * 4) | 0 : r.read32(info + i * 4),
    );
  const call = async (name, ...args) =>
    (await r.apiProvider.get('user32.dll!' + name)(r, (i) => args[i] >>> 0)).result | 0;
  const reset = () => {
    window.scrollbar = { min: 10, max: 40, page: 8, pos: 20, disabled: 0 };
    delete window.scrollTracking;
    window.scrollPressed = -1;
    notifications.length = 0;
  };
  return { r, window, info, range, write, read, call, reset, notifications };
}
test('standalone scrollbar APIs match 282 actual native state/setter captures', async (t) => {
  const { r, window, info, range, write, read, call } = setup(t);
  for (const c of states) {
    window.style = c.style;
    let returned = 0;
    r.lastError = 777;
    if (c.step === 'initial') delete window.scrollbar;
    else if (c.step === 'set-info') {
      write([28, 23, 10, 40, 8, 50, 999]);
      returned = await call('SetScrollInfo', 100, 2, info, 0);
    } else if (c.step === 'set-pos') returned = await call('SetScrollPos', 100, 2, 31, 0);
    else if (c.step === 'set-range') returned = await call('SetScrollRange', 100, 2, -20, 60, 0);
    else if (c.step.startsWith('info-')) {
      const [, size, mask] = c.step.split('-').map(Number);
      write([size, mask, 10, 40, 8, 50, 999]);
      returned = await call('SetScrollInfo', 100, 2, info, 0);
    } else if (c.step.startsWith('enable-'))
      returned = await call('EnableScrollBar', 100, 2, Number(c.step.slice(7)));
    else assert.fail(c.step);
    assert.equal(returned, c.result, c.step);
    assert.equal(r.lastError, c.error);
    write([28, 23, 1, 2, 3, 4, 5]);
    r.lastError = 777;
    assert.equal(await call('GetScrollInfo', 100, 2, info), c.got);
    assert.equal(r.lastError, c.getError);
    assert.deepEqual(read(), c.state, c.step);
    r.write32(range, 1);
    r.write32(range + 4, 2);
    r.lastError = 777;
    assert.equal(await call('GetScrollRange', 100, 2, range, range + 4), c.rangeResult);
    assert.equal(r.lastError, c.rangeError);
    assert.deepEqual([r.read32(range) | 0, r.read32(range + 4) | 0], c.range);
    const disabled = controlScrollState(window).disabled;
    assert.deepEqual([disabled & 1 ? 1 : 0, disabled & 2 ? 1 : 0], c.arrows, c.step);
  }
});
test('direct native SBM getters, legacy sizes, selected writes and setter returns match 141 captures', async (t) => {
  const { r, window, info, write, read, reset } = setup(t);
  for (const c of messages) {
    reset();
    r.lastError = 777;
    let returned;
    if (c.kind === 'get') {
      write([c.size, c.mask, 1, 2, 3, 4, 5]);
      returned = await scrollbarMessage(r, window, 0xea, 0, info);
    } else {
      returned = await scrollbarMessage(r, window, c.message, c.wp >>> 0, c.lp >>> 0);
      write([28, 23, 1, 2, 3, 4, 5]);
      await scrollbarMessage(r, window, 0xea, 0, info);
    }
    assert.equal(returned, c.result, JSON.stringify(c));
    assert.equal(r.lastError, c.error);
    assert.deepEqual(read(), c.out);
  }
});
test('keyboard and pointer messages retain native parent notifications and separate thumb tracking', async (t) => {
  const { r, window, reset, notifications } = setup(t);
  for (const style of [0, 1]) {
    reset();
    window.style = style;
    window.width = style ? 17 : 180;
    window.height = style ? 180 : 17;
    for (const key of [37, 39, 38, 40, 36, 35, 33, 34, 32, 13, 65]) {
      await scrollbarMessage(r, window, 0x100, key, 1);
      await scrollbarMessage(r, window, 0x101, key, 0xc0000001);
    }
    assert.deepEqual(
      notifications,
      keys.filter((c) => c.style === style).map(({ style, key, phase, ...c }) => c),
    );
    reset();
    const point = (coordinate) =>
      style ? ((coordinate << 16) | 8) >>> 0 : ((8 << 16) | coordinate) >>> 0;
    const starts = [8, 171, 19, 104, 83, 83];
    for (let gesture = 0; gesture < 7; gesture++) {
      if (gesture === 5) await scrollbarMessage(r, window, 0xe4, 3, 0);
      if (gesture === 6)
        window.scrollbar = { min: -20, max: 200000, page: 64, pos: 80000, disabled: 0 };
      const from = gesture === 6 ? 76 : starts[gesture],
        to = gesture === 6 ? 106 : gesture === 4 ? from + 40 : from;
      const before = notifications.length;
      await scrollbarMessage(r, window, 0x201, 1, point(from));
      await scrollbarMessage(r, window, 0x200, 1, point(to));
      await scrollbarMessage(r, window, 0x202, 0, point(to));
      assert.deepEqual(
        notifications.slice(before),
        pointers
          .filter((c) => c.style === style && c.gesture === gesture)
          .map(({ style, gesture, ...c }) => c),
        'pointer ' + style + '/' + gesture,
      );
      assert.equal(controlScrollState(window).pos, gesture === 6 ? 80000 : 20);
      assert.equal(controlScrollState(window).tracking, false);
    }
  }
});
test('EnableScrollBar validation and standard state returns match 50 native captures', async (t) => {
  const { r, window, call } = setup(t);
  window.controlType = 'static';
  for (const c of enabled) {
    r.lastError = 777;
    assert.equal(
      await call('EnableScrollBar', c.valid ? 100 : 0x1234, c.bar, c.flag),
      c.result,
      JSON.stringify(c),
    );
    assert.equal(r.lastError, c.error);
  }
});
