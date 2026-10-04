import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
test('display/bitmap DC printing uses Wine null-device returns and genuine abort callbacks without jobs', async (t) => {
  const bytes = new Uint8Array(await readFile('public/demos/console/console.exe'));
  const r = new Runtime(iced, { files: new Map([['console.exe', bytes]]), exe: 'console.exe' });
  t.after(() => r.windows.dispose());
  const call = (name, ...args) => r.apiProvider.get('gdi32.dll!' + name)(r, (i) => args[i] ?? 0);
  assert.equal(call('SetAbortProc', 0xdead, 0).result, 0);
  for (const name of ['StartPage', 'EndPage', 'EndDoc', 'AbortDoc'])
    assert.equal(call(name, 0xdead).result, 0xffffffff);
  assert.equal((await call('StartDocW', 0xdead, 0)).result, 0xffffffff);
  const dc = call('CreateCompatibleDC', 0).result,
    callbacks = [];
  r.callGuest = async (p, a) => {
    callbacks.push({ p, a });
    return 1;
  };
  assert.equal(call('SetAbortProc', dc, 0x12345678).result, 1);
  const doc = r.allocate(20);
  r.data.fill(0, doc, doc + 20);
  r.write32(doc, 20);
  r.write32(doc + 4, r.allocString('Test document'));
  assert.equal((await call('StartDocA', dc, doc)).result, 0);
  assert.deepEqual(callbacks, [{ p: 0x12345678, a: [dc, 0] }]);
  assert.equal(call('StartPage', dc).result, 1);
  for (const name of ['EndPage', 'EndDoc', 'AbortDoc']) assert.equal(call(name, dc).result, 0);
  call('SetAbortProc', dc, 0);
  assert.equal((await call('StartDocW', dc, 0)).result, 0);
  assert.equal(callbacks.length, 1);
  call('DeleteDC', dc);
  assert.equal(call('SetAbortProc', dc, 0).result, 0);
  assert.equal(call('StartPage', dc).result, 0xffffffff);
  assert.equal(r.dirty.size, 0);
});
