import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
function setup() {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  const call = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] ?? 0);
  return { r, call };
}
test('MultiByteToWideChar handles CP1252, embedded nulls, size queries and short buffers', () => {
  const { r, call } = setup(),
    input = r.allocate(4),
    output = r.allocate(12);
  r.data.set([0x80, 0, 0xe9, 0], input);
  const api = (...args) => call('kernel32.dll!MultiByteToWideChar', ...args).result;
  assert.equal(api(0, 0, input, -1, 0, 0), 2);
  assert.equal(api(1252, 0, input, 3, output, 6), 3);
  assert.deepEqual(
    [0, 2, 4].map((i) => r.guestMemory.read(output + i, 2)),
    [0x20ac, 0, 0xe9],
  );
  r.data.fill(0xcc, output, output + 12);
  assert.equal(api(1252, 0, input, 3, output, 2), 0);
  assert.equal(r.lastError, 122);
  assert.ok(r.data.subarray(output, output + 12).every((b) => b === 0xcc));
  assert.equal(call('kernel32.dll!IsDBCSLeadByte', 0x81).result, 0);
});
test('UTF-8 conversion preserves surrogate pairs/BOM and rejects invalid input with MB_ERR_INVALID_CHARS', () => {
  const { r, call } = setup(),
    input = r.allocate(8),
    output = r.allocate(16);
  r.data.set([0xef, 0xbb, 0xbf, 0xf0, 0x9f, 0x98, 0x80, 0], input);
  assert.equal(call('kernel32.dll!MultiByteToWideChar', 65001, 8, input, -1, output, 8).result, 4);
  assert.equal(r.wideString(output), '\ufeff😀');
  r.data[input] = 0xff;
  assert.equal(call('kernel32.dll!MultiByteToWideChar', 65001, 8, input, 1, output, 8).result, 0);
  assert.equal(r.lastError, 1113);
});
test('Get/SetWindowText cross the ANSI WndProc boundary without corrupting UTF-16 buffers', async () => {
  const { r, call } = setup(),
    hwnd = 0x20000,
    output = r.allocate(20);
  r.windows.windows.set(hwnd, { id: hwnd, cls: { wide: false }, proc: 0x401000, title: '€ café' });
  r.callGuest = async (_proc, args) => (await call('user32.dll!DefWindowProcA', ...args)).result;
  assert.equal((await call('user32.dll!GetWindowTextW', hwnd, output, 10)).result, 6);
  assert.equal(r.wideString(output), '€ café');
  const title = r.allocString('New €', true);
  assert.equal((await call('user32.dll!SetWindowTextW', hwnd, title)).result, 1);
  assert.equal(r.windows.windows.get(hwnd).title, 'New €');
  assert.equal((await call('user32.dll!GetWindowTextW', hwnd, output, 4)).result, 3);
  assert.equal(r.wideString(output), 'New');
  r.windows.dispose();
});
