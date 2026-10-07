import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { destroyClipboardOwner } from '../src/win32-clipboard.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
async function setup(t) {
  const r = new Runtime(iced, {
    files: new Map([['console.exe', exe]]),
    exe: 'console.exe',
    emit() {},
  });
  t.after(() => r.windows.dispose());
  const call = async (name, ...args) =>
    (await r.apiProvider.get('user32.dll!' + name)(r, (i) => args[i] ?? 0)).result;
  const put = (bytes) => {
    const p = r.allocate(bytes.length);
    r.data.set(bytes, p);
    return p;
  };
  return { r, call, put };
}
test('clipboard persists across read-only reopen and reports native formats and errors', async (t) => {
  const { r, call, put } = await setup(t);
  for (const name of [
    'GetClipboardData',
    'EmptyClipboard',
    'CloseClipboard',
    'EnumClipboardFormats',
  ]) {
    assert.equal(await call(name, 1), 0);
    assert.equal(r.lastError, 1418);
  }
  r.lastError = 0x1234;
  assert.equal(await call('OpenClipboard', 0), 1);
  assert.equal(await call('OpenClipboard', 0), 1); // same thread is allowed
  assert.equal(await call('EmptyClipboard'), 1);
  const h = put(Uint8Array.of(0x63, 0x61, 0x66, 0xe9, 13, 10, 0));
  assert.equal(await call('SetClipboardData', 1, h), h);
  assert.equal(r.lastError, 0);
  assert.equal(await call('CountClipboardFormats'), 1);
  assert.equal(await call('CloseClipboard'), 1);
  assert.equal(await call('CountClipboardFormats'), 4);
  assert.equal(await call('IsClipboardFormatAvailable', 13), 1);
  await call('OpenClipboard', 0);
  assert.equal(await call('GetClipboardData', 1), h);
  const formats = [];
  let f = 0;
  while ((f = await call('EnumClipboardFormats', f))) formats.push(f);
  assert.deepEqual(formats, [1, 16, 7, 13]); // independently recorded native Wine order
  assert.equal(r.lastError, 0);
  const unicode = await call('GetClipboardData', 13),
    oem = await call('GetClipboardData', 7);
  assert.equal(r.wideString(unicode), 'café\r\n');
  assert.deepEqual([...r.data.slice(oem, oem + 7)], [99, 97, 102, 130, 13, 10, 0]);
  assert.equal(await call('GetClipboardData', 13), unicode);
  const priority = put(Uint8Array.of(99, 0, 0, 0, 13, 0, 0, 0));
  assert.equal(await call('GetPriorityClipboardFormat', priority, 2), 13);
  assert.equal(await call('GetPriorityClipboardFormat', priority, 1), 0xffffffff);
  await call('CloseClipboard');
  await call('OpenClipboard', 0);
  assert.equal(await call('GetClipboardData', 13), unicode);
  await call('SetClipboardData', 1, put(Uint8Array.of(66, 0)));
  assert.equal(r.allocationSize(h), null);
  assert.equal(r.allocationSize(unicode), null);
  assert.equal(r.allocationSize(oem), null);
  const refreshed = await call('GetClipboardData', 13);
  assert.equal(r.wideString(refreshed), 'B');
  await call('EmptyClipboard');
  assert.equal(r.allocationSize(h), null);
  assert.equal(r.allocationSize(unicode), null);
  assert.equal(r.allocationSize(oem), null);
  assert.equal(r.allocationSize(refreshed), null);
  assert.equal(await call('GetPriorityClipboardFormat', priority, 2), 0);
});
test('clipboard Unicode/OEM conversions and custom binary formats retain bounded bytes', async (t) => {
  const { r, call, put } = await setup(t);
  for (const [format, bytes, order] of [
    [13, Uint8Array.of(99, 0, 97, 0, 102, 0, 233, 0, 13, 0, 10, 0, 0, 0), [13, 16, 1, 7]],
    [7, Uint8Array.of(99, 97, 102, 130, 13, 10, 0), [7, 16, 1, 13]],
  ]) {
    await call('OpenClipboard', 0);
    await call('EmptyClipboard');
    await call('SetClipboardData', format, put(bytes));
    await call('CloseClipboard');
    await call('OpenClipboard', 0);
    const formats = [];
    let f = 0;
    while ((f = await call('EnumClipboardFormats', f))) formats.push(f);
    assert.deepEqual(formats, order);
    assert.equal(r.wideString(await call('GetClipboardData', 13)), 'café\r\n');
    const ansi = await call('GetClipboardData', 1);
    assert.deepEqual([...r.data.slice(ansi, ansi + 7)], [99, 97, 102, 233, 13, 10, 0]);
    await call('CloseClipboard');
  }
  await call('OpenClipboard', 0);
  await call('EmptyClipboard');
  const binary = put(Uint8Array.of(0, 255, 1, 0, 3));
  await call('SetClipboardData', 0xc000, binary);
  await call('CloseClipboard');
  assert.equal(await call('CountClipboardFormats'), 1);
  await call('OpenClipboard', 0);
  assert.equal(await call('GetClipboardData', 0xc000), binary);
  assert.equal(await call('SetClipboardData', 1, 0xdeadbeef), 0);
  assert.equal(r.lastError, 6);
  assert.equal(await call('CountClipboardFormats'), 1);
});
test('clipboard locking uses guest thread identity and owner is assigned by EmptyClipboard', async (t) => {
  const { r, call } = await setup(t);
  r.windows.windows.set(123, { id: 123 });
  await call('OpenClipboard', 123);
  assert.equal(await call('GetOpenClipboardWindow'), 123);
  assert.equal(await call('GetClipboardOwner'), 0);
  await call('EmptyClipboard');
  assert.equal(await call('GetClipboardOwner'), 123);
  const first = r.threads.current;
  r.threads.current = { id: 987 };
  assert.equal(await call('OpenClipboard', 0), 0);
  assert.equal(r.lastError, 5);
  assert.equal(await call('CloseClipboard'), 0);
  assert.equal(r.lastError, 1418);
  r.threads.current = first;
  await call('CloseClipboard');
  await call('OpenClipboard', 0);
  assert.equal(await call('GetClipboardOwner'), 123);
  const messages = [];
  r.windows.send = async (...args) => messages.push(args);
  await call('EmptyClipboard');
  assert.deepEqual(messages, [[123, 0x307]]);
  assert.equal(await call('GetClipboardOwner'), 0);
});
test('delayed text rendering calls the real owner once and prevents recursive resolution', async (t) => {
  const { r, call, put } = await setup(t);
  r.windows.windows.set(123, { id: 123 });
  await call('OpenClipboard', 123);
  await call('EmptyClipboard');
  await call('SetClipboardData', 1, 0);
  await call('CloseClipboard');
  let calls = 0;
  r.windows.send = async (hwnd, message, format) => {
    assert.equal(hwnd, 123);
    assert.equal(message, 0x305);
    assert.equal(format, 1);
    calls++;
    assert.equal(
      await call('GetClipboardData', 1),
      0,
      'recursive delayed reads do not recurse into the owner',
    );
    await call('SetClipboardData', 1, put(Uint8Array.of(65, 233, 0)));
  };
  await call('OpenClipboard', 0);
  const h = await call('GetClipboardData', 13);
  assert.equal(r.wideString(h), 'Aé');
  assert.equal(calls, 1);
  assert.equal(await call('GetClipboardData', 13), h);
  assert.equal(calls, 1);
});

test('clipboard owner destruction renders pending formats and removes unresolved conversions', async (t) => {
  const { r, call, put } = await setup(t);
  r.windows.windows.set(123, { id: 123 });
  await call('OpenClipboard', 123);
  await call('EmptyClipboard');
  await call('SetClipboardData', 1, 0);
  await call('CloseClipboard');
  const messages = [];
  r.windows.send = async (...args) => messages.push(args);
  await destroyClipboardOwner(r, 123);
  assert.deepEqual(messages, [[123, 0x306]]);
  assert.equal(await call('GetClipboardOwner'), 0);
  assert.equal(await call('IsClipboardFormatAvailable', 13), 0);
  await call('OpenClipboard', 123);
  await call('EmptyClipboard');
  await call('SetClipboardData', 1, 0);
  await call('CloseClipboard');
  r.windows.send = async (_hwnd, message) => {
    if (message !== 0x306) return;
    await call('OpenClipboard', 123);
    await call('SetClipboardData', 1, put(Uint8Array.of(65, 0)));
    await call('CloseClipboard');
  };
  await destroyClipboardOwner(r, 123);
  await call('OpenClipboard', 0);
  assert.equal(r.wideString(await call('GetClipboardData', 13)), 'A');
});
