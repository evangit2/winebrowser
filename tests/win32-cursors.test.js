import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { cursorApis } from '../src/win32-cursors.js';
import { windowApis } from '../src/win32-windows.js';
const bytes = new Uint8Array(
  await readFile(new URL('./fixtures/cursors/cursors.exe', import.meta.url)),
);
const call = (r, name, args = []) => cursorApis['user32.dll!' + name](r, (i) => args[i] ?? 0);
const setup = (emit = () => {}) =>
  new Runtime(iced, { files: new Map([['cursors.exe', bytes]]), exe: 'cursors.exe', emit });

test('native cursor client executes standard handles, hide counts, class callbacks and key changes', async () => {
  const css = [];
  let queued = false;
  const r = setup((event) => {
    if (event.type === 'cursor') css.push(event.css);
    if (event.type === 'window' && event.window.visible && !queued) {
      queued = true;
      const windowId = event.window.id;
      r.windows.input({ windowId, type: 'mousemove', x: 10, y: 10, buttons: 0 });
      for (const key of ['W', 'H', 'H', 'S', 'S', 'N', 'R'])
        r.windows.input({ windowId, type: 'keydown', key, keyCode: key.charCodeAt(0) });
      r.windows.input({ windowId, type: 'close' });
    }
  });
  const result = await r.run();
  assert.equal(result.exitCode, 0, 'native cursor fixture C line ' + result.exitCode);
  assert.deepEqual(css, [
    'pointer',
    'wait',
    'none',
    'wait',
    'none',
    'default',
    'pointer',
    'wait',
    'none',
    'wait',
    'none',
    'pointer',
  ]);
  assert.equal(r.windows.windows.size, 0);
});

test('failed resource/handle operations preserve cursor and display state; runtimes are independent', () => {
  const events = [],
    r = setup((e) => events.push(e)),
    other = setup();
  try {
    call(r, 'SetCursor', [32649]);
    assert.equal(call(other, 'GetCursor').result, 32512);
    assert.equal(call(r, 'LoadCursorA', [0, 12345]).result, 0);
    assert.equal(r.lastError, 1814);
    assert.equal(call(r, 'LoadCursorA', [0x400000, 123]).result, 0);
    assert.equal(r.lastError, 1814);
    assert.throws(() => call(r, 'LoadCursorW', [0, 0x3000000]), /Named system cursor/);
    assert.equal(call(r, 'SetCursor', [12345]).result, 0);
    assert.equal(r.lastError, 1402);
    assert.equal(call(r, 'GetCursor').result, 32649);
    assert.equal(call(r, 'ShowCursor', [0]).result, 0xffffffff);
    assert.equal(call(r, 'GetCursor').result, 32649);
    assert.deepEqual(
      events.map((e) => e.css),
      ['pointer', 'none'],
    );
  } finally {
    r.cpu.dispose();
    other.cpu.dispose();
  }
});

test('default cursor handling honors parent overrides and uses the actual target child class', async () => {
  const r = setup(),
    w = r.windows;
  try {
    w.windows.set(1, { id: 1, cls: { cursor: 32512 }, parentId: 0, proc: 1 });
    w.windows.set(2, { id: 2, cls: { cursor: 32513 }, parentId: 1, proc: 2 });
    const args = [2, 0x20, 2, (0x200 << 16) | 1];
    let override = true;
    r.callGuest = async (_addr, values) => {
      assert.deepEqual(values, [1, 0x20, 2, (0x200 << 16) | 1]);
      if (override) {
        call(r, 'SetCursor', [32514]);
        return 1;
      }
      return 0;
    };
    const def = () => windowApis['user32.dll!DefWindowProcW'](r, (i) => args[i]);
    assert.equal((await def()).result, 1);
    assert.equal(call(r, 'GetCursor').result, 32514);
    override = false;
    assert.equal((await def()).result, 0);
    assert.equal(call(r, 'GetCursor').result, 32513);
    args[3] = (0x200 << 16) | 13; // HTTOPLEFT skips the parent's client override.
    await def();
    assert.equal(call(r, 'GetCursor').result, 32642);
  } finally {
    r.cpu.dispose();
  }
});

test('only browser mouse retrieval sends WM_SETCURSOR and mouse capture suppresses it', async () => {
  const r = setup(),
    seen = [];
  try {
    r.windows.windows.set(1, {
      id: 1,
      cls: { cursor: 32649 },
      proc: 1,
      visible: true,
      enabled: true,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    r.callGuest = async (_addr, args) => {
      seen.push(args);
      return 0;
    };
    const buffer = r.allocate(28);
    const peek = () => r.windows.message((i) => [buffer, 0, 0, 0, 1][i], true);
    r.windows.input({ windowId: 1, type: 'mousemove', x: 1, y: 1, buttons: 0 });
    await peek();
    assert.deepEqual(seen, [[1, 0x20, 1, 0x2000001]]);
    r.windows.capture = 1;
    r.windows.input({ windowId: 1, type: 'mousemove', x: 2, y: 2, buttons: 0 });
    await peek();
    r.windows.capture = 0;
    r.windows.post(1, 0x200, 0, 0); // Application-posted mouse messages do not move the hardware cursor.
    await peek();
    assert.equal(seen.length, 1);
  } finally {
    r.cpu.dispose();
  }
});
