import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const capture = JSON.parse(await readFile('tests/fixtures/scroll-state/wine-oracle.json')).cases;
const extra = JSON.parse(
  await readFile('tests/fixtures/scroll-state/extra-wine-oracle.json'),
).cases;
const callbacks = JSON.parse(
  await readFile('tests/fixtures/scroll-state/callback-wine-oracle.json'),
).cases;
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = async (name, ...args) =>
    await r.apiProvider.get('user32.dll!' + name)(r, (i) => args[i] >>> 0);
  const call = async (name, ...args) => (await api(name, ...args)).result | 0;
  const info = r.allocate(28),
    outputs = r.allocate(8);
  const write = (values) => values.forEach((v, i) => r.write32(info + i * 4, v));
  const read = () =>
    [0, 1, 2, 3, 4, 5, 6].map((i) =>
      [2, 3, 5, 6].includes(i) ? r.read32(info + i * 4) | 0 : r.read32(info + i * 4),
    );
  const make = (style) =>
    r.windows.windows.set(100, {
      id: 100,
      parentId: 0,
      style,
      width: 200,
      height: 120,
      visible: false,
      cls: { wide: true, proc: 0 },
    });
  r.windows.send = async (hwnd) => {
    if (!r.windows.windows.has(hwnd)) r.lastError = 1400;
    return 0;
  };
  return { r, api, call, info, outputs, write, read, make };
}
test('six scrollbar APIs match 860 native SDK state, clamp, mask, legacy-size and return-value captures', async (t) => {
  const { r, call, info, outputs, write, read, make } = setup(t);
  const styles = [0x80000000, 0x00cf0000 | 0x100000, 0x00cf0000 | 0x200000, 0x00cf0000 | 0x300000];
  const set = async (bar, mask, min, max, page, pos, track, size = 28) => {
    write([size, mask, min, max, page, pos, track]);
    return await call('SetScrollInfo', 100, bar, info, 0);
  };
  for (const c of capture) {
    const style = Number(c.name[0]),
      name = c.name.slice(2),
      bar = c.bar;
    let returned = 0,
      queryResult,
      queryError,
      query;
    r.lastError = 777;
    if (name === 'initial') make(styles[style]);
    else if (name === 'range-page-pos') returned = await set(bar, 7, 10, 40, 8, 50, 999);
    else if (name === 'set-pos') returned = await call('SetScrollPos', 100, bar, 31, 0);
    else if (name === 'track-only') returned = await set(bar, 16, 100, 200, 10, 18, 456);
    else if (name === 'page-large') returned = await set(bar, 2, 0, 0, 100, 0, 0);
    else if (name === 'reversed-range') returned = await set(bar, 1, 40, 10, 0, 0, 0);
    else if (name === 'range-extremes')
      returned = await set(bar, 7, -2147483648, 2147483647, 0, 2147483647, 0);
    else if (name === 'old-size') returned = await set(bar, 5, -20, 200, 0, 42, 0, 24);
    else if (name === 'bad-size') returned = await set(bar, 5, -20, 200, 0, 42, 0, 20);
    else if (name === 'bad-mask') returned = await set(bar, 32, -20, 200, 0, 42, 0);
    else if (name.startsWith('get-mask-')) {
      write([28, Number(name.slice(9)), 0x13579, 0x2468, 0x3579, 0x468a, 0x579b]);
      queryResult = await call('GetScrollInfo', 100, bar, info);
      queryError = r.lastError;
      query = read();
      r.lastError = 777;
    } else if (name === 'set-range') returned = await call('SetScrollRange', 100, bar, -30, 90, 0);
    else assert.fail(name);
    assert.equal(returned, c.returned, c.name + '/' + bar + ' return');
    assert.equal(r.lastError, c.error, c.name + '/' + bar + ' error');
    if (c.query) {
      assert.equal(queryResult, c.queryResult, c.name);
      assert.equal(queryError, c.queryError, c.name);
      assert.deepEqual(query, c.query, c.name);
    }
    write([28, 23, 0x13579, 0x2468, 0x3579, 0x468a, 0x579b]);
    r.lastError = 777;
    assert.equal(await call('GetScrollInfo', 100, bar, info), c.getResult, c.name + ' get');
    assert.equal(r.lastError, c.getError);
    assert.deepEqual(read(), c.state, c.name + ' state');
    r.write32(outputs, 0x1234);
    r.write32(outputs + 4, 0x5678);
    r.lastError = 777;
    assert.equal(
      await call('GetScrollRange', 100, bar, outputs, outputs + 4),
      c.rangeResult,
      c.name + ' range',
    );
    assert.equal(r.lastError, c.rangeError);
    assert.deepEqual(
      [r.read32(outputs) | 0, r.read32(outputs + 4) | 0],
      c.range,
      c.name + ' range values',
    );
    r.lastError = 777;
    assert.equal(await call('GetScrollPos', 100, bar), c.pos, c.name + ' pos');
    assert.equal(r.lastError, c.posError);
  }
});
test('scrollbar validation and selected output writes match 170 independent native captures', async (t) => {
  const { r, call, info, outputs, write, read, make } = setup(t);
  make(0x80000000);
  write([28, 23, 10, 40, 8, 33, 999]);
  await call('SetScrollInfo', 100, 0, info, 0);
  for (const c of extra) {
    r.lastError = 777;
    let returned;
    if (c.kind === 'get') {
      write([c.size, c.mask, 1, 2, 3, 4, 5]);
      returned = await call('GetScrollInfo', 100, c.bar, info);
      assert.deepEqual(read(), c.out, JSON.stringify(c));
    } else if (c.kind === 'set-null')
      returned = await call('SetScrollInfo', c.valid ? 100 : 0x1234, c.bar, 0, 0);
    else if (c.kind === 'get-null')
      returned = await call('GetScrollInfo', c.valid ? 100 : 0x1234, c.bar, 0);
    else if (c.kind === 'get-range') {
      r.write32(outputs, 1);
      r.write32(outputs + 4, 2);
      returned = await call('GetScrollRange', c.valid ? 100 : 0x1234, c.bar, outputs, outputs + 4);
      assert.deepEqual([r.read32(outputs) | 0, r.read32(outputs + 4) | 0], c.range);
    } else if (c.kind === 'set-range-extreme') {
      returned = await call('SetScrollRange', 100, c.bar, -2147483648, 2147483647, 0);
      const error = r.lastError;
      r.write32(outputs, 1);
      r.write32(outputs + 4, 2);
      await call('GetScrollRange', 100, c.bar, outputs, outputs + 4);
      assert.deepEqual([r.read32(outputs) | 0, r.read32(outputs + 4) | 0], c.range);
      r.lastError = error;
    } else if (c.kind === 'invalid-get') {
      write([28, 23, 1, 2, 3, 4, 5]);
      returned = await call('GetScrollInfo', 0x1234, c.bar, info);
      assert.deepEqual(read(), c.out);
    } else if (c.kind === 'invalid-set') {
      write([28, 23, 1, 2, 3, 4, 5]);
      returned = await call('SetScrollInfo', 0x1234, c.bar, info, 0);
    } else assert.fail(c.kind);
    assert.equal(returned, c.result, JSON.stringify(c));
    assert.equal(r.lastError, c.error, JSON.stringify(c));
  }
});
test('SB_CTL APIs forward the native messages and honor guest callback writes and signed replies', async (t) => {
  const { r, call, info, outputs, write, read, make } = setup(t);
  make(0x80000000);
  const messages = [];
  r.windows.send = async (hwnd, message, wp, lp) => {
    const row = { message, wp, lp };
    if (message === 0xe9) {
      row.values = [0, 4, 8, 12, 16, 20, 24].map((o) => r.read32(lp + o) | 0);
    }
    messages.push(row);
    if (message === 0xe1) return -15;
    if (message === 0xe3) {
      r.write32(wp, -7);
      r.write32(lp, 33);
      return 0;
    }
    if (message === 0xea) {
      [-7, 33, 4, 15, 9].forEach((v, i) => r.write32(lp + 8 + i * 4, v));
      return 0;
    }
    return -5;
  };
  const expected = (name) => callbacks.find((c) => c.name === name);
  const check = async (name, fn) => {
    r.lastError = 777;
    const value = await fn(),
      row = messages.at(-1),
      c = expected(name);
    assert.equal(value, c.result, name);
    assert.equal(r.lastError, c.error);
    assert.equal(row.message, c.message, name);
    if (!['get-range'].includes(name)) assert.equal(row.wp, c.wp);
    return row;
  };
  write([28, 23, -10, 50, 8, 30, 20]);
  await check('set-info', () => call('SetScrollInfo', 100, 2, info, 0));
  await check('get-info', () => call('GetScrollInfo', 100, 2, info));
  assert.deepEqual(read(), expected('query').out);
  const pos = await check('set-pos', () => call('SetScrollPos', 100, 2, -12, 1));
  assert.equal(pos.values[0], 28);
  assert.equal(pos.values[1], 4);
  assert.equal(pos.values[5], -12);
  await check('get-pos', () => call('GetScrollPos', 100, 2));
  for (const [name, repaint] of [
    ['set-range', 0],
    ['set-range-redraw', 1],
  ]) {
    const range = await check(name, () => call('SetScrollRange', 100, 2, -20, 60, repaint));
    assert.equal(range.values[0], 28);
    assert.equal(range.values[1], 1);
    assert.deepEqual(range.values.slice(2, 4), [-20, 60]);
  }
  await check('get-range', () => call('GetScrollRange', 100, 2, outputs, outputs + 4));
  assert.deepEqual([r.read32(outputs) | 0, r.read32(outputs + 4) | 0], expected('range').out);
});
