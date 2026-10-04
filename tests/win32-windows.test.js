import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { flushGdi } from '../src/win32-gdi.js';

const executableUrl = new URL('../public/demos/console/console.exe', import.meta.url);

test('native window lookup fixture passes through the ordinary runtime', async () => {
  const bytes = new Uint8Array(await readFile('tests/fixtures/window-find/window-find.exe'));
  const runtime = new Runtime(iced, {
    files: new Map([['window-find.exe', bytes]]),
    exe: 'window-find.exe',
  });
  try {
    assert.equal((await runtime.run()).exitCode, 0);
  } finally {
    runtime.windows.dispose();
  }
});

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

test('foreground queries track visible top-level windows independently of keyboard focus', async (t) => {
  const { runtime } = await makeRuntime(t);
  const proc = installGuestWindowProc(runtime);
  const { atom } = await registerClass(runtime, proc.address);
  const first = (await createWindow(runtime, atom)).result;
  const second = (await createWindow(runtime, atom)).result;
  const foreground = async () => (await call(runtime, 'user32.dll!GetForegroundWindow', [])).result;
  assert.equal(await foreground(), 0);
  await call(runtime, 'user32.dll!ShowWindow', [first, 5]);
  assert.equal(await foreground(), first);
  await call(runtime, 'user32.dll!ShowWindow', [second, 8]);
  assert.equal(await foreground(), first, 'SW_SHOWNA does not activate');
  runtime.windows.input({ type: 'focus', windowId: second });
  assert.equal(await foreground(), second);
  await call(runtime, 'user32.dll!SetFocus', [0]);
  assert.equal(await foreground(), second, 'clearing keyboard focus retains the active window');
  assert.equal((await call(runtime, 'user32.dll!GetActiveWindow', [])).result, second);
  await call(runtime, 'user32.dll!DestroyWindow', [second]);
  assert.equal(await foreground(), 0);
  await call(runtime, 'user32.dll!ShowWindow', [first, 5]);
  await call(runtime, 'user32.dll!ShowWindow', [first, 0]);
  assert.equal(await foreground(), 0);
});

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
  { title = 'probe', style = 0, width = 160, height = 120, x = 11, y = 23 } = {},
) {
  const titlePtr = runtime.allocString(title);
  const args = [0, atom, titlePtr, style, x, y, width, height, 0, 0, runtime.pe.imageBase, 0];
  const created = await call(runtime, 'user32.dll!CreateWindowExA', args);
  return { ...created, titlePtr, args };
}

test('FindWindow A/W matches actual top-level classes, atoms and stored titles while preserving last error', async (t) => {
  const { runtime: r } = await makeRuntime(t),
    proc = installGuestWindowProc(r);
  const { atom } = await registerClass(r, proc.address, { name: 'LookupClass' });
  const first = (await createWindow(r, atom, { title: 'Caf\u00e9' })).result;
  const second = (await createWindow(r, atom, { title: '' })).result;
  const count = proc.messages().length;
  for (const wide of [false, true]) {
    const find = (cls, title) =>
      call(r, `user32.dll!FindWindow${wide ? 'W' : 'A'}`, [
        typeof cls === 'string' ? r.allocString(cls, wide) : cls,
        typeof title === 'string' ? r.allocString(title, wide) : title,
      ]);
    r.lastError = 0x11223344;
    assert.deepEqual(await find(null, null), { result: second, argc: 2 });
    assert.equal((await find('lookupCLASS', 'CAF\u00c9')).result, first);
    assert.equal((await find(atom, 'cAf\u00e9')).result, first);
    assert.equal((await find(0, '')).result, second);
    assert.equal((await find('', 0)).result, 0, 'empty class differs from wildcard');
    assert.equal((await find('absent', 0)).result, 0);
    assert.equal((await find(0xfffe, 0)).result, 0);
    assert.equal((await find(0, 'Caf')).result, 0, 'title length must match');
    assert.equal(r.lastError, 0x11223344);
  }
  assert.equal(proc.messages().length, count, 'native FindWindow does not send WM_GETTEXT');
  await call(r, 'user32.dll!DefWindowProcW', [first, 0xc, 0, r.allocString('\u00dfs', true)]);
  assert.equal(
    (await call(r, 'user32.dll!FindWindowW', [0, r.allocString('s\u00df', true)])).result,
    0,
    'full case expansions must not equate different code units',
  );
  await call(r, 'user32.dll!DestroyWindow', [second]);
  assert.equal((await call(r, 'user32.dll!FindWindowA', [atom, 0])).result, first);
});

test('FindWindowEx follows direct sibling order and FindWindow excludes child controls', async (t) => {
  const { runtime: r } = await makeRuntime(t),
    proc = installGuestWindowProc(r);
  const { atom } = await registerClass(r, proc.address);
  const first = (await createWindow(r, atom)).result,
    second = (await createWindow(r, atom)).result;
  const control = async (parent, title) =>
    (
      await call(r, 'user32.dll!CreateWindowExW', [
        0,
        r.allocString('STATIC', true),
        r.allocString(title, true),
        0x40000000,
        0,
        0,
        40,
        20,
        parent,
        1,
        r.pe.imageBase,
        0,
      ])
    ).result;
  const one = await control(first, 'Child'),
    two = await control(first, 'Child'),
    grandchild = await control(one, 'Nested');
  assert.ok(one && two && grandchild);
  const find = async (parent, after = 0, cls = 0, title = 0) =>
    (await call(r, 'user32.dll!FindWindowExW', [parent, after, cls, title])).result;
  assert.equal(await find(first), one, 'new child controls go to the bottom');
  assert.equal(await find(first, one), two);
  assert.equal(await find(first, two), 0);
  assert.equal(await find(one), grandchild);
  assert.equal(await find(first, 0, 0, r.allocString('Nested', true)), 0);
  assert.equal(await find(first, grandchild), 0, 'after must be a direct sibling');
  assert.equal(
    await find(second, one),
    0,
    'unrelated valid after window does not restart the search',
  );
  assert.equal(
    (await call(r, 'user32.dll!FindWindowW', [0, r.allocString('Child', true)])).result,
    0,
  );
  assert.equal(
    await find(first, 0, r.allocString('static', true), r.allocString('CHILD', true)),
    one,
  );
  assert.equal(await find(0xfffffffd), 0, 'no message-only windows exist in this runtime');
  assert.equal(await find(0, second), first);
  assert.equal(await find(0, first), 0);
  assert.equal(await find(0xdeadbeef), 0);
  assert.equal(r.lastError, 1400);
  assert.equal(await find(first, 0xdeadbeef), 0);
  assert.equal(r.lastError, 1400);
  await call(r, 'user32.dll!DestroyWindow', [one]);
  assert.equal(await find(first), two);
  assert.equal(r.windows.windows.has(grandchild), false);
});

test('window lookup tracks native activation and browser focus order, including focus inside a control', async (t) => {
  const { runtime: r } = await makeRuntime(t),
    proc = installGuestWindowProc(r);
  const { atom } = await registerClass(r, proc.address);
  const first = (await createWindow(r, atom)).result,
    second = (await createWindow(r, atom)).result;
  const top = async () => (await call(r, 'user32.dll!FindWindowA', [atom, 0])).result;
  assert.equal(await top(), second);
  await call(r, 'user32.dll!ShowWindow', [first, 5]);
  assert.equal(await top(), first);
  await call(r, 'user32.dll!ShowWindow', [second, 8]);
  assert.equal(await top(), first, 'show without activation retains order');
  r.windows.input({ type: 'focus', windowId: second });
  assert.equal(await top(), second);
  await call(r, 'user32.dll!SetFocus', [first]);
  assert.equal(await top(), first);
  const child = (
    await call(r, 'user32.dll!CreateWindowExW', [
      0,
      r.allocString('STATIC', true),
      0,
      0x50000000,
      0,
      0,
      40,
      20,
      second,
      1,
      r.pe.imageBase,
      0,
    ])
  ).result;
  r.windows.input({ type: 'focus', windowId: child });
  assert.equal(await top(), second);
});

test('topmost windows stay above ordinary windows across creation, activation and browser focus', async (t) => {
  const { runtime: r, events } = await makeRuntime(t),
    proc = installGuestWindowProc(r);
  const { atom } = await registerClass(r, proc.address);
  const make = async (extended) =>
    (
      await call(r, 'user32.dll!CreateWindowExA', [
        extended,
        atom,
        0,
        0x10000000,
        10,
        20,
        160,
        120,
        0,
        0,
        r.pe.imageBase,
        0,
      ])
    ).result;
  const top1 = await make(8),
    top2 = await make(8),
    normal = await make(0);
  const front = async () => (await call(r, 'user32.dll!FindWindowA', [0, 0])).result;
  assert.ok(top1 && top2 && normal);
  assert.equal(await front(), top2);
  await call(r, 'user32.dll!SetFocus', [normal]);
  assert.equal(await front(), top2);
  r.windows.input({ type: 'focus', windowId: top1 });
  assert.equal(await front(), top1);
  assert.equal((await call(r, 'user32.dll!FindWindowExA', [0, top1, 0, 0])).result, top2);
  assert.equal((await call(r, 'user32.dll!FindWindowExA', [0, top2, 0, 0])).result, normal);
  assert.equal(events.findLast((e) => e.type === 'window-stack').topmost, true);
  await call(r, 'user32.dll!DestroyWindow', [top1]);
  assert.equal(await front(), top2);
});

test('popup frame geometry agrees across creation, nonclient layout, rectangles, screen points and mouse messages', async (t) => {
  const { runtime: r, events } = await makeRuntime(t),
    proc = installGuestWindowProc(r);
  const { atom } = await registerClass(r, proc.address),
    rect = r.allocate(16),
    point = r.allocate(8);
  for (const [style, border, title] of [
    [0x90000000, 0, 0],
    [0x90800000, 1, 0],
    [0x90c40000, 1, 28],
  ]) {
    const hwnd = (
      await call(r, 'user32.dll!CreateWindowExA', [
        8,
        atom,
        0,
        style,
        10,
        20,
        160,
        120,
        0,
        0,
        r.pe.imageBase,
        0,
      ])
    ).result;
    assert.ok(hwnd);
    await call(r, 'user32.dll!GetClientRect', [hwnd, rect]);
    assert.deepEqual(
      [0, 4, 8, 12].map((i) => r.read32(rect + i)),
      [0, 0, 160 - 2 * border, 120 - 2 * border - title],
    );
    await call(r, 'user32.dll!GetWindowRect', [hwnd, rect]);
    assert.deepEqual(
      [0, 4, 8, 12].map((i) => r.read32(rect + i)),
      [10, 20, 170, 140],
    );
    [10 + border, 20 + border + title, 170 - border, 140 - border].forEach((n, i) =>
      r.write32(rect + i * 4, n),
    );
    assert.equal((await call(r, 'user32.dll!AdjustWindowRectEx', [rect, style, 0, 8])).result, 1);
    assert.deepEqual(
      [0, 4, 8, 12].map((i) => r.read32(rect + i)),
      [10, 20, 170, 140],
    );
    r.write32(point, 3);
    r.write32(point + 4, 5);
    await call(r, 'user32.dll!ClientToScreen', [hwnd, point]);
    assert.deepEqual([r.read32(point), r.read32(point + 4)], [13 + border, 25 + border + title]);
    r.windows.input({ type: 'mousemove', windowId: hwnd, x: 3, y: 5, buttons: 0 });
    const mouse = r.windows.queue.findLast((m) => m.hwnd === hwnd && m.message === 0x200);
    assert.deepEqual([mouse.x, mouse.y], [13 + border, 25 + border + title]);
    const emitted = events.findLast((e) => e.type === 'window' && e.window.id === hwnd).window;
    assert.equal(emitted.frame.border, border);
    assert.equal(emitted.frame.title, title);
    await call(r, 'user32.dll!DestroyWindow', [hwnd]);
  }
});

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

test('windows larger than the desktop retain client geometry through native and browser resizing', async (t) => {
  const { runtime: r } = await makeRuntime(t),
    proc = installGuestWindowProc(r);
  const { atom } = await registerClass(r, proc.address);
  const hwnd = (await createWindow(r, atom, { width: 1282, height: 750 })).result;
  assert.ok(hwnd);
  const window = r.windows.windows.get(hwnd);
  assert.deepEqual([window.width, window.height], [1280, 720]);
  const rect = r.allocate(16);
  assert.equal((await call(r, 'user32.dll!GetClientRect', [hwnd, rect])).result, 1);
  assert.deepEqual(
    [8, 12].map((i) => r.read32(rect + i)),
    [1280, 720],
  );
  assert.equal(
    (await call(r, 'user32.dll!SetWindowPos', [hwnd, 0, 0, 0, 1922, 1110, 4 | 16 | 1024])).result,
    1,
  );
  assert.deepEqual([window.width, window.height], [1920, 1080]);
  await call(r, 'user32.dll!ShowWindow', [hwnd, 5]);
  r.windows.input({ type: 'resize', windowId: hwnd, width: 1280, height: 720 });
  assert.deepEqual([window.width, window.height], [1280, 720]);
  const dc = (await call(r, 'user32.dll!GetDC', [hwnd])).result;
  assert.ok(dc);
  assert.equal((await call(r, 'gdi32.dll!SetPixel', [dc, 1279, 719, 0x123456])).result, 0x123456);
  assert.equal((await call(r, 'gdi32.dll!GetPixel', [dc, 1279, 719])).result, 0x123456);
  await call(r, 'user32.dll!ReleaseDC', [hwnd, dc]);
  assert.equal((await createWindow(r, atom, { width: 2051, height: 750 })).result, 0);
  assert.deepEqual([window.width, window.height], [1280, 720]);
});

test('pointer, window-from-point and enable state round-trip through the virtual desktop', async (t) => {
  const { runtime: r } = await makeRuntime(t);
  const proc = installGuestWindowProc(r);
  const { atom } = await registerClass(r, proc.address);
  const hwnd = (await createWindow(r, atom, { width: 160, height: 120 })).result;
  assert.ok(hwnd);
  await call(r, 'user32.dll!ShowWindow', [hwnd, 5]);
  const window = r.windows.windows.get(hwnd);
  const [clientX, clientY] = r.windows.clientPosition(window);

  // The pointer starts at the origin and is updated by browser mouse input.
  const point = r.allocate(8);
  assert.equal((await call(r, 'user32.dll!GetCursorPos', [point])).result, 1);
  assert.deepEqual(
    [0, 4].map((o) => r.read32(point + o)),
    [0, 0],
  );
  r.windows.input({ type: 'mousemove', windowId: hwnd, x: 3, y: 5, buttons: 0 });
  assert.equal((await call(r, 'user32.dll!GetCursorPos', [point])).result, 1);
  assert.deepEqual(
    [0, 4].map((o) => r.read32(point + o)),
    [clientX + 3, clientY + 5],
  );

  // SetCursorPos moves the virtual pointer; ScreenToClient converts back.
  assert.equal((await call(r, 'user32.dll!SetCursorPos', [clientX + 10, clientY + 7])).result, 1);
  assert.equal((await call(r, 'user32.dll!GetCursorPos', [point])).result, 1);
  assert.deepEqual(
    [0, 4].map((o) => r.read32(point + o)),
    [clientX + 10, clientY + 7],
  );
  assert.equal((await call(r, 'user32.dll!ScreenToClient', [hwnd, point])).result, 1);
  assert.deepEqual(
    [0, 4].map((o) => r.read32(point + o)),
    [10, 7],
  );
  // Rejecting an unknown window preserves the documented failure path.
  assert.equal((await call(r, 'user32.dll!ScreenToClient', [0xdead, point])).result, 0);
  assert.equal(r.lastError, 1400);

  // WindowFromPoint takes its POINT by value, as two packed stack arguments.
  assert.equal(
    (await call(r, 'user32.dll!WindowFromPoint', [clientX + 1, clientY + 1])).result,
    hwnd,
  );
  assert.equal((await call(r, 'user32.dll!WindowFromPoint', [0x7fff, 0x7fff])).result, 0);

  // EnableWindow reports whether the window was previously disabled.
  assert.equal((await call(r, 'user32.dll!IsWindowEnabled', [hwnd])).result, 1);
  assert.equal((await call(r, 'user32.dll!EnableWindow', [hwnd, 0])).result, 0);
  assert.equal((await call(r, 'user32.dll!IsWindowEnabled', [hwnd])).result, 0);
  assert.equal((await call(r, 'user32.dll!EnableWindow', [hwnd, 1])).result, 1);
  assert.equal((await call(r, 'user32.dll!IsWindowEnabled', [hwnd])).result, 1);
  assert.equal((await call(r, 'user32.dll!EnableWindow', [0xdead, 1])).result, 0);
  assert.equal(r.lastError, 1400);
  await call(r, 'user32.dll!DestroyWindow', [hwnd]);
});

test('captured pointer coordinates, double-click styles and wheel modifiers follow native message contracts', async (t) => {
  const { runtime: r } = await makeRuntime(t);
  const proc = installGuestWindowProc(r);
  const { atom } = await registerClass(r, proc.address);
  const first = (await createWindow(r, atom, { x: 20, y: 30 })).result;
  const second = (await createWindow(r, atom, { x: 200, y: 180 })).result;
  await call(r, 'user32.dll!ShowWindow', [first, 5]);
  await call(r, 'user32.dll!ShowWindow', [second, 5]);
  r.windows.queue = [];
  await call(r, 'user32.dll!SetCapture', [first]);
  r.windows.input({
    type: 'mouseup',
    windowId: second,
    x: 4,
    y: 8,
    button: 0,
    buttons: 0,
    shiftKey: true,
    ctrlKey: true,
  });
  let message = r.windows.queue.pop();
  assert.deepEqual(
    [message.hwnd, message.message, message.wParam, message.lParam],
    [first, 0x202, 12, (158 << 16) | 184],
  );
  assert.deepEqual([message.x, message.y], [205, 217]);
  await call(r, 'user32.dll!ReleaseCapture', []);
  r.windows.input({ type: 'dblclick', windowId: second, x: 4, y: 8, button: 0, buttons: 1 });
  assert.equal(
    r.windows.queue.pop().message,
    0x201,
    'a class without CS_DBLCLKS receives another button-down',
  );
  r.windows.windows.get(second).cls.style |= 8;
  r.windows.input({ type: 'dblclick', windowId: second, x: 4, y: 8, button: 2, buttons: 2 });
  assert.equal(r.windows.queue.pop().message, 0x206);
  r.windows.input({
    type: 'wheel',
    windowId: second,
    x: 4,
    y: 8,
    buttons: 0,
    shiftKey: true,
    wheelDelta: -120,
  });
  message = r.windows.queue.pop();
  assert.deepEqual(
    [message.hwnd, message.message, message.wParam, message.lParam],
    [second, 0x20a, 0xff880004, (217 << 16) | 205],
  );
  assert.deepEqual(r.windows.pointer, { x: 205, y: 217 });
});

test('window properties and registered messages round-trip through the window manager', async (t) => {
  const { runtime: r } = await makeRuntime(t);
  const proc = installGuestWindowProc(r);
  const { atom } = await registerClass(r, proc.address);
  const hwnd = (await createWindow(r, atom)).result;
  const other = (await createWindow(r, atom)).result;

  // SetProp stores a value under a per-window guest string key.
  const name = r.allocString('ProbeProp');
  assert.equal((await call(r, 'user32.dll!GetPropA', [hwnd, name])).result, 0);
  assert.equal((await call(r, 'user32.dll!SetPropA', [hwnd, name, 0x1234])).result, 1);
  assert.equal((await call(r, 'user32.dll!GetPropA', [hwnd, name])).result, 0x1234);
  // Property names are window-scoped.
  assert.equal((await call(r, 'user32.dll!GetPropA', [other, name])).result, 0);
  // RemoveProp returns the previous value and clears the entry.
  assert.equal((await call(r, 'user32.dll!RemovePropA', [hwnd, name])).result, 0x1234);
  assert.equal((await call(r, 'user32.dll!GetPropA', [hwnd, name])).result, 0);
  // Unknown windows and null names fail without a substitute value.
  assert.equal((await call(r, 'user32.dll!SetPropA', [0xdead, name, 1])).result, 0);
  assert.equal((await call(r, 'user32.dll!GetPropA', [hwnd, 0])).result, 0);

  // Wide property names round-trip through the same table.
  const wideName = r.allocString('WideProp', true);
  assert.equal((await call(r, 'user32.dll!SetPropW', [hwnd, wideName, 0x55])).result, 1);
  assert.equal((await call(r, 'user32.dll!GetPropW', [hwnd, wideName])).result, 0x55);

  // RegisterWindowMessage returns a stable, process-global id per name.
  const messageName = r.allocString('WineBrowser.Probe');
  const wideMessageName = r.allocString('WineBrowser.Probe', true);
  const first = (await call(r, 'user32.dll!RegisterWindowMessageA', [messageName])).result;
  assert.ok(first >= 0xc000, 'registered messages start above the WM_ range');
  assert.equal((await call(r, 'user32.dll!RegisterWindowMessageA', [messageName])).result, first);
  assert.equal(
    (await call(r, 'user32.dll!RegisterWindowMessageW', [wideMessageName])).result,
    first,
  );
  const secondName = r.allocString('WineBrowser.Other');
  const second = (await call(r, 'user32.dll!RegisterWindowMessageA', [secondName])).result;
  assert.notEqual(second, first);
  assert.equal((await call(r, 'user32.dll!RegisterWindowMessageA', [0])).result, 0);

  await call(r, 'user32.dll!DestroyWindow', [hwnd]);
  await call(r, 'user32.dll!DestroyWindow', [other]);
});

test('GetClassName preserves registered case, ANSI/Unicode conversion, truncation and buffer bounds', async (t) => {
  const { runtime: r } = await makeRuntime(t),
    proc = installGuestWindowProc(r);
  const { atom } = await registerClass(r, proc.address, { name: 'CaféΩClass', wide: true });
  const hwnd = (await createWindow(r, atom)).result,
    out = r.allocate(40);
  for (const wide of [false, true]) {
    const name = `user32.dll!GetClassName${wide ? 'W' : 'A'}`;
    r.data.fill(0x77, out, out + 40);
    assert.deepEqual(await call(r, name, [hwnd, out, 5]), { result: 4, argc: 3 });
    assert.equal(wide ? r.wideString(out) : r.string(out), 'Café');
    assert.equal(r.data[out + 5 * (wide ? 2 : 1)], 0x77);
    assert.deepEqual(await call(r, name, [hwnd, out, 1]), { result: 0, argc: 3 });
    assert.equal(r.data[out], 0);
    r.data[out] = 0x77;
    assert.deepEqual(await call(r, name, [hwnd, out, 0]), { result: 0, argc: 3 });
    assert.equal(r.data[out], 0x77);
    assert.deepEqual(await call(r, name, [hwnd, out, 20]), { result: 10, argc: 3 });
    assert.equal(wide ? r.wideString(out) : r.string(out), wide ? 'CaféΩClass' : 'Café?Class');
    assert.deepEqual(await call(r, name, [0, out, 20]), { result: 0, argc: 3 });
    assert.equal(r.lastError, 1400);
  }
});
