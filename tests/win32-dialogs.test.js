import test from 'node:test';
import assert from 'node:assert/strict';
import { createWin32ApiProvider } from '../src/win32.js';

function dialogRuntime() {
  const events = [],
    messages = [];
  const parent = { id: 1, enabled: true },
    child = { id: 2, parentId: 1 };
  const windows = new Map([
    [1, parent],
    [2, child],
  ]);
  const runtime = {
    lastError: 0,
    string: (p) => ({ 10: 'ANSI body', 20: 'Title' })[p],
    wideString: (p) => ({ 10: 'Unicode body Ω', 20: 'Title Ω' })[p],
    emit: (event) => events.push(event),
    windows: {
      windows,
      emit: (window) => events.push({ enabled: window.enabled }),
      send: async (...args) => messages.push(args),
    },
  };
  return { runtime, parent, events, messages };
}
const api = createWin32ApiProvider();
const invoke = (runtime, suffix, args) =>
  api.get(`user32.dll!MessageBox${suffix}`)(runtime, (i) => args[i] ?? 0);

test('owned MessageBox disables its owner during the request and restores it after IDOK', async () => {
  const { runtime, parent, events, messages } = dialogRuntime();
  runtime.request = async (kind, detail) => {
    assert.equal(kind, 'messagebox');
    assert.equal(parent.enabled, false);
    assert.deepEqual(detail, { owner: 1, icon: 'information', text: 'ANSI body', title: 'Title' });
    assert.deepEqual(messages, [[1, 0xa, 0]]);
    return 1;
  };
  assert.deepEqual(await invoke(runtime, 'A', [1, 10, 20, 0x40]), { result: 1, argc: 4 });
  assert.equal(parent.enabled, true);
  assert.deepEqual(messages, [
    [1, 0xa, 0],
    [1, 0xa, 1],
  ]);
  assert.deepEqual(events.at(-1), { type: 'window-focus', windowId: 1 });
});

test('MessageBoxW shares owner validation, Unicode text and default caption behavior', async () => {
  const { runtime } = dialogRuntime();
  runtime.request = async (kind, detail) => {
    assert.deepEqual(detail, { owner: 0, icon: null, text: 'Unicode body Ω', title: 'Error' });
    return 1;
  };
  assert.equal((await invoke(runtime, 'W', [0, 10, 0, 0])).result, 1);
  assert.equal((await invoke(runtime, 'W', [99, 10, 20, 0])).result, 0);
  assert.equal(runtime.lastError, 1400);
  await assert.rejects(invoke(runtime, 'A', [0, 10, 20, 1]), /MB_OK/);
});

test('dialog errors restore enabled owners and initially disabled owners stay disabled', async () => {
  const { runtime, parent, messages } = dialogRuntime();
  runtime.request = async () => {
    throw Error('dialog closed by host');
  };
  await assert.rejects(invoke(runtime, 'A', [1, 10, 20, 0]), /closed by host/);
  assert.equal(parent.enabled, true);
  messages.length = 0;
  parent.enabled = false;
  runtime.request = async () => 1;
  await invoke(runtime, 'A', [1, 10, 20, 0]);
  assert.equal(parent.enabled, false);
  assert.deepEqual(messages, []);
});
