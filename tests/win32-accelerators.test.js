import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => r.windows.dispose());
  const hwnd = 0x20000,
    calls = [];
  r.windows.windows.set(hwnd, {
    id: hwnd,
    proc: 0x401000,
    visible: true,
    width: 100,
    height: 100,
    x: 0,
    y: 0,
  });
  r.callGuest = async (proc, args) => {
    calls.push({ proc, args });
    return 27;
  };
  const call = (name, ...args) => r.apiProvider.get(`user32.dll!${name}`)(r, (i) => args[i] ?? 0);
  const entry = r.allocate(6),
    msg = r.allocate(28);
  r.guestMemory.write(entry, 0x11, 1); // FVIRTKEY | FALT
  r.guestMemory.write(entry + 2, 80, 2);
  r.guestMemory.write(entry + 4, 2001, 2);
  return { r, hwnd, calls, call, entry, msg };
}
test('accelerators copy ACCEL records, use dequeued modifiers, and synchronously deliver WM_COMMAND', async (t) => {
  const { r, hwnd, calls, call, entry, msg } = setup(t);
  const table = call('CreateAcceleratorTableA', entry, 1).result;
  r.guestMemory.write(entry + 4, 999, 2); // caller may reuse the array
  r.windows.input({ type: 'keydown', windowId: hwnd, keyCode: 80, key: 'p', altKey: true });
  r.windows.input({ type: 'keyup', windowId: hwnd, keyCode: 80, key: 'p', altKey: false });
  await call('PeekMessageA', msg, 0, 0, 0, 1);
  assert.equal(r.read32(msg + 4), 0x104);
  assert.equal(call('GetKeyState', 18).result, 0xffff8000);
  assert.equal((await call('TranslateAccelerator', hwnd, table, msg)).result, 1);
  assert.deepEqual(calls, [{ proc: 0x401000, args: [hwnd, 0x111, 0x10000 | 2001, 0] }]);
  await call('PeekMessageA', msg, 0, 0, 0, 1);
  assert.equal(call('GetKeyState', 18).result, 0);
  assert.equal((await call('TranslateAcceleratorA', hwnd, table, msg)).result, 0);
});
test('nonmatching modifiers and destroyed tables cannot dispatch commands', async (t) => {
  const { r, hwnd, calls, call, entry, msg } = setup(t);
  const table = call('CreateAcceleratorTableW', entry, 1).result;
  r.windows.input({ type: 'keydown', windowId: hwnd, keyCode: 80, key: 'p' });
  await call('PeekMessageW', msg, 0, 0, 0, 1);
  assert.equal((await call('TranslateAcceleratorW', hwnd, table, msg)).result, 0);
  assert.equal(call('DestroyAcceleratorTable', table).result, 1);
  assert.equal((await call('TranslateAcceleratorW', hwnd, table, msg)).result, 0);
  assert.equal(r.lastError, 1403);
  assert.deepEqual(calls, []);
  assert.equal(call('CreateAcceleratorTableA', entry, 0).result, 0);
  r.windows.dispose();
  assert.equal(r.windows.accelerators.size, 0);
});
test('character accelerators consume translated characters, not their keydown', async (t) => {
  const { r, hwnd, calls, call, entry, msg } = setup(t);
  r.guestMemory.write(entry, 0, 1);
  r.guestMemory.write(entry + 2, 112, 2);
  const table = call('CreateAcceleratorTableA', entry, 1).result;
  r.windows.input({ type: 'keydown', windowId: hwnd, keyCode: 80, key: 'p' });
  await call('PeekMessageA', msg, 0, 0, 0, 1);
  assert.equal((await call('TranslateAcceleratorA', hwnd, table, msg)).result, 0);
  call('TranslateMessage', msg);
  await call('PeekMessageA', msg, 0, 0, 0, 1);
  assert.equal((await call('TranslateAcceleratorA', hwnd, table, msg)).result, 1);
  assert.equal(calls.length, 1);
});

test('non-virtual Alt accelerators consume ordinary context-marked keydown before character translation', async (t) => {
  const { r, hwnd, calls, call, entry, msg } = setup(t);
  r.guestMemory.write(entry, 16, 1);
  const table = call('CreateAcceleratorTableA', entry, 1).result;
  [hwnd, 0x104, 80, 0x21000001, 0, 0, 0].forEach((v, i) => r.write32(msg + i * 4, v));
  assert.equal(
    (await call('TranslateAcceleratorA', hwnd, table, msg)).result,
    0,
    'extended key does not match',
  );
  r.write32(msg + 12, 0x20000001);
  assert.equal((await call('TranslateAcceleratorA', hwnd, table, msg)).result, 1);
  assert.equal(calls.length, 1);
});

test('compiler-generated PE tables load zero-flag first records and retain the final marked record', async (t) => {
  const bytes = new Uint8Array(
    await readFile('tests/fixtures/accelerator-resources/accelerator-resources.exe'),
  );
  const r = new Runtime(iced, {
    files: new Map([['accelerator-resources.exe', bytes]]),
    exe: 'accelerator-resources.exe',
  });
  t.after(() => r.windows.dispose());
  const call = (name, ...args) => r.apiProvider.get('user32.dll!' + name)(r, (i) => args[i] ?? 0);
  const a = call('LoadAcceleratorsA', r.pe.imageBase, 201).result;
  assert.ok(a);
  assert.equal(call('LoadAcceleratorsW', r.pe.imageBase, 201).result, a);
  assert.deepEqual(r.windows.accelerators.get(a), [
    { flags: 0, key: 120, command: 10 },
    { flags: 11, key: 65, command: 11 },
    { flags: 23, key: 90, command: 12 },
  ]);
  assert.equal(call('LoadAcceleratorsA', r.pe.imageBase, 999).result, 0);
  assert.equal(r.lastError, 1414);
});
