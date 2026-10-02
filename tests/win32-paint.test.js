import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowManager } from '../src/win32-windows.js';
import { paintApis } from '../src/win32-paint.js';
function fixture() {
  const r = { directInput: null, threads: { block: (promise) => promise } };
  r.windows = new WindowManager(r);
  r.windows.windows.set(0x20000, { id: 0x20000, width: 500, height: 500, visible: true });
  return r;
}
test('internal redraw posts and coalesces paint without inventing an invalid region', async () => {
  const r = fixture(),
    a = (i) => [0x20000, 0, 0, 2][i];
  await paintApis['user32.dll!RedrawWindow'](r, a);
  await paintApis['user32.dll!RedrawWindow'](r, a);
  assert.equal(r.windows.queue.length, 0);
  assert.equal(r.windows.next(0, 0, 0, false).message, 0xf);
  assert.equal(r.windows.windows.get(0x20000).invalid, undefined);
  assert.equal(r.windows.next(0, 0, 0, true).message, 0xf);
  assert.equal(r.windows.queue.length, 0);
  assert.equal(r.windows.windows.get(0x20000).internalPaint, false);
});
test('WaitMessage blocks until an actual message arrives and leaves it available', async () => {
  const r = fixture();
  let resolved = false;
  const waiting = paintApis['user32.dll!WaitMessage'](r).then((result) => {
    resolved = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  r.windows.post(0x20000, 0x100, 32);
  assert.deepEqual(await waiting, { result: 1, argc: 0 });
  assert.equal(r.windows.queue.length, 1);
  assert.equal(r.windows.queue[0].wParam, 32);
});
test('internal paints are synthesized for PeekMessage without waking WaitMessage', async () => {
  const r = fixture();
  await paintApis['user32.dll!RedrawWindow'](r, (i) => [0x20000, 0, 0, 2][i]);
  let resolved = false;
  const waiting = paintApis['user32.dll!WaitMessage'](r).then(() => {
    resolved = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolved, false);
  r.windows.post(0x20000, 0x100, 32);
  await waiting;
  assert.equal(r.windows.next(0, 0, 0, true).message, 0x100);
  assert.equal(r.windows.next(0, 0, 0, true).message, 0xf);
  assert.equal(r.windows.next(0, 0, 0, false), null);
});
test('RedrawWindow validates flags and removes internal paints on request', async () => {
  const r = fixture();
  await assert.rejects(
    paintApis['user32.dll!RedrawWindow'](r, (i) => [0x20000, 0, 0, 0x800][i]),
    /flags/,
  );
  await paintApis['user32.dll!RedrawWindow'](r, (i) => [0x20000, 0, 0, 2][i]);
  await paintApis['user32.dll!RedrawWindow'](r, (i) => [0x20000, 0, 0, 0x10][i]);
  assert.equal(r.windows.queue.length, 0);
});
