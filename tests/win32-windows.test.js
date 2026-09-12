import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { flushGdi } from '../src/win32-gdi.js';

const executableUrl = new URL('../public/demos/console/console.exe', import.meta.url);

async function makeRuntime(t) {
  const executable = new Uint8Array(await readFile(executableUrl));
  const events = [];
  const runtime = new Runtime(iced, {
    files: new Map([['console.exe', executable]]),
    exe: 'console.exe',
    emit: (event) => events.push(event),
  });
  t.after(() => runtime.windows.dispose());
  return { runtime, events };
}

function api(runtime, name) {
  const handler = runtime.apiProvider.get(name);
  assert.ok(handler, `API is registered: ${name}`);
  return handler;
}

function call(runtime, name, args) {
  return api(runtime, name)(runtime, (index) => args[index] ?? 0);
}

function installGuestWindowProc(runtime, rejectNccreate = false) {
  const memory = runtime.allocate(4 + 64 * 4);
  const counter = memory;
  const log = memory + 4;
  const codeSection = runtime.pe.sections.find((section) => section.characteristics & 0x20000000);
  assert.ok(codeSection, 'console fixture provides executable code for a test callback');
  const codeAddress = runtime.pe.imageBase + codeSection.rva + codeSection.rawSize - 64;
  const cmpImmediate = rejectNccreate ? 0x81 : 1;
  const code = Uint8Array.from([
    0xa1,
    ...dword(counter), // mov eax,[counter]
    0x8b,
    0x54,
    0x24,
    0x08, // mov edx,[esp+8] (message)
    0x89,
    0x14,
    0x85,
    ...dword(log), // mov [log+eax*4],edx
    0xff,
    0x05,
    ...dword(counter), // inc dword [counter]
    0xb8,
    1,
    0,
    0,
    0, // mov eax,1
    0x81,
    0xfa,
    ...dword(cmpImmediate), // cmp edx, either WM_CREATE or WM_NCCREATE
    0x75,
    0x02, // jne past xor eax,eax
    0x31,
    0xc0, // xor eax,eax
    0xc2,
    0x10,
    0x00, // ret 16
  ]);
  runtime.data.set(code, codeAddress);
  runtime.cpu.cache.clear();
  // The compact synthetic WNDPROC handles create messages only; like a real
  // WNDPROC, it delegates non-client geometry to DefWindowProc.
  const callGuest = runtime.callGuest.bind(runtime);
  runtime.callGuest = async (address, args, convention) => {
    if (address === codeAddress && args[1] === 0x83)
      return api(runtime, 'user32.dll!DefWindowProcA')(runtime, (index) => args[index] ?? 0);
    return callGuest(address, args, convention);
  };
  return {
    address: codeAddress,
    messages() {
      return Array.from({ length: runtime.read32(counter) }, (_, i) => runtime.read32(log + i * 4));
    },
  };
}

function dword(value) {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

async function registerClass(
  runtime,
  proc,
  { name = 'WindowProbe', wide = false, background = 0 } = {},
) {
  const namePtr = runtime.allocString(name, wide);
  const cls = runtime.allocate(40);
  runtime.write32(cls, 0);
  runtime.write32(cls + 4, proc);
  runtime.write32(cls + 8, 0);
  runtime.write32(cls + 12, 0);
  runtime.write32(cls + 16, runtime.pe.imageBase);
  runtime.write32(cls + 20, 0);
  runtime.write32(cls + 24, 0);
  runtime.write32(cls + 28, background);
  runtime.write32(cls + 32, 0);
  runtime.write32(cls + 36, namePtr);
  const registered = await call(runtime, `user32.dll!RegisterClass${wide ? 'W' : 'A'}`, [cls]);
  assert.notEqual(registered.result, 0, 'window class registration succeeds');
  return { atom: registered.result, namePtr };
}

async function createWindow(
  runtime,
  atom,
  { title = 'probe', style = 0, width = 160, height = 120 } = {},
) {
  const titlePtr = runtime.allocString(title);
  const args = [0, atom, titlePtr, style, 11, 23, width, height, 0, 0, runtime.pe.imageBase, 0];
  const created = await call(runtime, 'user32.dll!CreateWindowExA', args);
  return { ...created, titlePtr, args };
}

test('registers a class and delivers real guest WM_NCCREATE then WM_CREATE with a valid CREATESTRUCT', async (t) => {
  const { runtime } = await makeRuntime(t);
  const proc = installGuestWindowProc(runtime);
  const callbacks = [];
  const guestCall = runtime.callGuest.bind(runtime);
  runtime.callGuest = async (address, args, convention) => {
    if (address === proc.address) callbacks.push([...args]);
    return guestCall(address, args, convention);
  };
  const { atom } = await registerClass(runtime, proc.address);
  const created = await createWindow(runtime, atom);

  assert.ok(created.result);
  assert.deepEqual(proc.messages(), [0x81, 1]);
  assert.deepEqual(
    callbacks.map((args) => args.slice(1, 3)),
    [
      [0x81, 0],
      [0x83, 0],
      [1, 0],
    ],
  );
  const createStruct = callbacks[0][3];
  assert.ok(createStruct, 'WM_NCCREATE gets a guest CREATESTRUCT pointer');
  assert.deepEqual(
    Array.from({ length: 12 }, (_, i) => runtime.read32(createStruct + i * 4)),
    [0, runtime.pe.imageBase, 0, 0, 120, 160, 23, 11, 0, created.args[2], atom, 0],
  );
  assert.equal(runtime.windows.windows.get(created.result).title, 'probe');
  assert.equal(runtime.windows.windows.get(created.result).visible, false);
});

test('a guest WM_NCCREATE rejection leaves no window, surface, or live GDI handle', async (t) => {
  const { runtime, events } = await makeRuntime(t);
  const proc = installGuestWindowProc(runtime, true);
  const { atom } = await registerClass(runtime, proc.address);
  const created = await createWindow(runtime, atom);

  assert.equal(created.result, 0);
  assert.equal(runtime.lastError, 1407);
  assert.deepEqual(proc.messages(), [0x81], 'WM_CREATE is not sent after rejection');
  assert.equal(runtime.windows.windows.size, 0);
  assert.equal(runtime.windows.windows.has(0x20000), false);
  const dc = await call(runtime, 'user32.dll!GetDC', [0x20000]);
  assert.equal(dc.result, 0);
  assert.equal(runtime.lastError, 1400);
  assert.equal(
    events.some((event) => event.type === 'window'),
    false,
  );
  assert.equal(
    await call(runtime, 'user32.dll!DestroyWindow', [0x20000]).then((value) => value.result),
    0,
  );
});

test('window DCs, invalid regions, and paint structures remain isolated per HWND', async (t) => {
  const { runtime, events } = await makeRuntime(t);
  const proc = installGuestWindowProc(runtime);
  const { atom } = await registerClass(runtime, proc.address);
  const first = await createWindow(runtime, atom, { title: 'first' });
  const second = await createWindow(runtime, atom, { title: 'second' });
  const dc1 = await call(runtime, 'user32.dll!GetDC', [first.result]);
  const dc2 = await call(runtime, 'user32.dll!GetDC', [second.result]);
  assert.ok(dc1.result && dc2.result && dc1.result !== dc2.result);

  assert.equal(
    (await call(runtime, 'gdi32.dll!SetPixel', [dc1.result, 3, 4, 0x00030201])).result,
    0x00030201,
  );
  assert.equal(
    (await call(runtime, 'gdi32.dll!SetPixel', [dc2.result, 3, 4, 0x00060504])).result,
    0x00060504,
  );
  assert.equal((await call(runtime, 'gdi32.dll!GetPixel', [dc1.result, 3, 4])).result, 0x00030201);
  assert.equal((await call(runtime, 'gdi32.dll!GetPixel', [dc2.result, 3, 4])).result, 0x00060504);

  assert.equal((await call(runtime, 'user32.dll!InvalidateRect', [first.result, 0, 1])).result, 1);
  assert.equal((await call(runtime, 'user32.dll!InvalidateRect', [second.result, 0, 1])).result, 1);
  const paint = runtime.allocate(64);
  const paintDc = await call(runtime, 'user32.dll!BeginPaint', [first.result, paint]);
  assert.ok(paintDc.result);
  assert.equal(runtime.windows.windows.get(first.result).invalid, null);
  assert.notEqual(runtime.windows.windows.get(second.result).invalid, null);
  assert.equal(runtime.read32(paint), paintDc.result);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, i) => runtime.read32(paint + 8 + i * 4)),
    [0, 0, 158, 90],
  );
  assert.equal((await call(runtime, 'user32.dll!EndPaint', [first.result, paint])).result, 1);

  await call(runtime, 'user32.dll!ReleaseDC', [first.result, dc1.result]);
  await call(runtime, 'user32.dll!ReleaseDC', [second.result, dc2.result]);
  flushGdi(runtime);
  const emitted = events.filter((event) => event.type === 'frame');
  const byWindow = new Map(emitted.map((frame) => [frame.windowId, frame]));
  assert.ok(byWindow.has(first.result) && byWindow.has(second.result));
  assert.deepEqual(
    [...byWindow.get(first.result).pixels.slice((4 * 158 + 3) * 4, (4 * 158 + 3) * 4 + 4)],
    [1, 2, 3, 255],
  );
  assert.deepEqual(
    [...byWindow.get(second.result).pixels.slice((4 * 158 + 3) * 4, (4 * 158 + 3) * 4 + 4)],
    [4, 5, 6, 255],
  );
  assert.ok(emitted.length >= 2, 'EndPaint/flush emitted dirty client surfaces');
  assert.equal(runtime.windows.windows.get(second.result).invalid !== null, true);
});

test('PeekMessage removal, filtering, blocking GetMessage wakeup, and WM_QUIT semantics', async (t) => {
  const { runtime } = await makeRuntime(t);
  const proc = installGuestWindowProc(runtime);
  const { atom } = await registerClass(runtime, proc.address);
  const window = await createWindow(runtime, atom);
  const other = await createWindow(runtime, atom);
  const msg = runtime.allocate(28);
  assert.equal(
    (await call(runtime, 'user32.dll!PostMessageA', [window.result, 0x400, 7, 9])).result,
    1,
  );
  assert.equal(
    (await call(runtime, 'user32.dll!PostMessageA', [other.result, 0x401, 8, 10])).result,
    1,
  );

  const peek = [msg, window.result, 0x400, 0x400, 0];
  assert.equal((await call(runtime, 'user32.dll!PeekMessageA', peek)).result, 1);
  assert.equal(runtime.read32(msg + 4), 0x400);
  assert.equal(
    (await call(runtime, 'user32.dll!PeekMessageA', peek)).result,
    1,
    'PM_NOREMOVE leaves the message queued',
  );
  assert.equal(
    (await call(runtime, 'user32.dll!PeekMessageA', [...peek.slice(0, 4), 1])).result,
    1,
  );
  assert.equal(
    runtime.windows.queue.length,
    1,
    'removing the filtered message keeps the other HWND message',
  );

  const pending = call(runtime, 'user32.dll!GetMessageA', [msg, other.result, 0x402, 0x402]);
  setTimeout(() => runtime.windows.post(other.result, 0x402, 11, 12), 0);
  assert.equal(
    (await pending).result,
    1,
    'blocking GetMessage wakes when a matching message is posted',
  );
  assert.equal(runtime.read32(msg + 4), 0x402);
  assert.equal(runtime.read32(msg + 8), 11);

  await call(runtime, 'user32.dll!PostQuitMessage', [7]);
  assert.equal(
    (await call(runtime, 'user32.dll!GetMessageA', [msg, window.result, 0x500, 0x501])).result,
    0,
  );
  assert.deepEqual(
    [runtime.read32(msg), runtime.read32(msg + 4), runtime.read32(msg + 8)],
    [0, 0x12, 7],
  );
});

test('SetTimer captures its callback argument; KillTimer and manager disposal stop future ticks', async (t) => {
  const { runtime } = await makeRuntime(t);
  const proc = installGuestWindowProc(runtime);
  const { atom } = await registerClass(runtime, proc.address);
  const window = await createWindow(runtime, atom);
  let callback = 0x12345678;
  const timerArgs = [window.result, 37, 10, callback];
  const timer = await api(runtime, 'user32.dll!SetTimer')(
    runtime,
    (index) => timerArgs[index] ?? 0,
  );
  assert.equal(timer.result, 37);
  timerArgs[3] = 0x87654321;

  for (
    let attempt = 0;
    attempt < 20 && !runtime.windows.queue.some((message) => message.message === 0x113);
    attempt++
  )
    await new Promise((resolve) => setTimeout(resolve, 5));
  const posted = runtime.windows.queue.find((message) => message.message === 0x113);
  assert.ok(posted, 'timer posts WM_TIMER');
  assert.equal(posted.wParam, 37);
  assert.equal(
    posted.lParam,
    0x12345678,
    'timer uses the callback value captured when SetTimer was called',
  );

  runtime.windows.queue.length = 0;
  assert.equal((await call(runtime, 'user32.dll!KillTimer', [window.result, 37])).result, 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(runtime.windows.queue.length, 0, 'no ticks are posted after KillTimer');

  await call(runtime, 'user32.dll!SetTimer', [window.result, 38, 10, 0]);
  runtime.windows.queue.length = 0;
  runtime.windows.dispose();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(runtime.windows.timers.size, 0);
  assert.equal(runtime.windows.windows.size, 0);
  assert.equal(
    runtime.windows.queue.length,
    0,
    'dispose clears timer sources before they can post',
  );
});

test('process exit releases its virtual windows and timers for direct Runtime consumers', async (t) => {
  const { runtime, events } = await makeRuntime(t);
  const proc = installGuestWindowProc(runtime);
  const { atom } = await registerClass(runtime, proc.address);
  const window = await createWindow(runtime, atom);
  await call(runtime, 'user32.dll!SetTimer', [window.result, 50, 10, 0]);
  const outcome = await runtime.run();
  assert.equal(outcome.exitCode, 0);
  assert.equal(runtime.windows.windows.size, 0);
  assert.equal(runtime.windows.timers.size, 0);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'window' &&
        event.operation === 'destroy' &&
        event.window.id === window.result,
    ),
  );
});
