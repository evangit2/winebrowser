import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

const executableUrl = new URL('../public/demos/console/console.exe', import.meta.url);
const WS_VISIBLE = 0x10000000;
const WS_CHILD = 0x40000000;
const WM_PARENTNOTIFY = 0x210;
const WM_COMMAND = 0x111;

async function makeHarness(t) {
  const executable = new Uint8Array(await readFile(executableUrl));
  const events = [];
  const runtime = new Runtime(iced, {
    files: new Map([['console.exe', executable]]),
    exe: 'console.exe',
    emit: (event) => events.push(event),
  });
  const parentProc = 0x12345678;
  const callbacks = [];
  let parentHook = () => {};
  let guestDepth = 0;
  let maximumGuestDepth = 0;
  const defProc = runtime.apiProvider.get('user32.dll!DefWindowProcA');
  runtime.callGuest = async (address, args) => {
    assert.equal(address, parentProc, 'only the synthetic parent WNDPROC is called');
    guestDepth++;
    maximumGuestDepth = Math.max(maximumGuestDepth, guestDepth);
    callbacks.push([...args]);
    try {
      const message = args[1];
      if (message === 0x83) return (await defProc(runtime, (index) => args[index] ?? 0)).result;
      if (message === 0x81) return 1;
      await parentHook(args);
      return 0;
    } finally {
      guestDepth--;
    }
  };
  t.after(() => runtime.windows.dispose());

  const className = runtime.allocString('ControlTestParent');
  const classPointer = runtime.allocate(40);
  runtime.data.fill(0, classPointer, classPointer + 40);
  runtime.write32(classPointer + 4, parentProc);
  runtime.write32(classPointer + 16, runtime.pe.imageBase);
  runtime.write32(classPointer + 36, className);
  const registered = await call(runtime, 'user32.dll!RegisterClassA', [classPointer]);
  assert.ok(registered.result, 'synthetic parent class registers');
  const parent = await call(runtime, 'user32.dll!CreateWindowExA', [
    0,
    className,
    runtime.allocString('Parent'),
    0,
    11,
    23,
    240,
    160,
    0,
    0,
    runtime.pe.imageBase,
    0,
  ]);
  assert.ok(parent.result, 'parent window creates');

  return {
    runtime,
    events,
    parentId: parent.result,
    callbacks,
    setParentHook(fn) {
      parentHook = fn;
    },
    get maximumGuestDepth() {
      return maximumGuestDepth;
    },
  };
}

function call(runtime, name, args) {
  const handler = runtime.apiProvider.get(name);
  assert.ok(handler, `API is registered: ${name}`);
  return handler(runtime, (index) => args[index] ?? 0);
}

async function createChild(runtime, parentId, options = {}) {
  const wide = options.wide ?? false;
  const suffix = wide ? 'W' : 'A';
  const alloc = (value) => runtime.allocString(value, wide);
  return call(runtime, `user32.dll!CreateWindowEx${suffix}`, [
    options.exStyle ?? 0,
    alloc(options.className ?? 'BUTTON'),
    alloc(options.title ?? 'OK'),
    options.style ?? WS_CHILD | WS_VISIBLE,
    options.x ?? 10,
    options.y ?? 12,
    options.width ?? 80,
    options.height ?? 24,
    parentId,
    options.controlId ?? 101,
    runtime.pe.imageBase,
    0,
  ]);
}

function commandWords(message) {
  return {
    notification: message.wParam >>> 16,
    controlId: message.wParam & 0xffff,
    childId: message.lParam,
  };
}

function parentNotifyWords(message) {
  return {
    event: message.wParam & 0xffff,
    controlId: message.wParam >>> 16,
    childId: message.lParam,
  };
}

test('built-in child controls preserve parent linkage, client geometry and WM_PARENTNOTIFY creation', async (t) => {
  const { runtime, events, parentId, callbacks } = await makeHarness(t);
  const button = await createChild(runtime, parentId, {
    className: 'BUTTON',
    title: 'Run',
    controlId: 77,
    x: 8,
    y: 13,
    width: 92,
    height: 28,
  });
  assert.ok(button.result);

  const child = runtime.windows.windows.get(button.result);
  assert.equal(child.parentId, parentId);
  assert.equal(child.controlId, 77);
  assert.equal(child.controlType, 'button');
  assert.equal(child.width, 92);
  assert.equal(child.height, 28);
  assert.equal(runtime.windows.screenPosition(child)[0], 20);
  assert.equal(runtime.windows.screenPosition(child)[1], 65);
  assert.equal((await call(runtime, 'user32.dll!GetParent', [child.id])).result, parentId);
  assert.equal((await call(runtime, 'user32.dll!GetDlgCtrlID', [child.id])).result, 77);
  assert.equal((await call(runtime, 'user32.dll!GetDlgItem', [parentId, 77])).result, child.id);

  const rect = runtime.allocate(16);
  assert.equal((await call(runtime, 'user32.dll!GetClientRect', [child.id, rect])).result, 1);
  assert.deepEqual(
    [0, 4, 8, 12].map((offset) => runtime.read32(rect + offset)),
    [0, 0, 92, 28],
  );
  assert.equal((await call(runtime, 'user32.dll!GetWindowRect', [child.id, rect])).result, 1);
  assert.deepEqual(
    [0, 4, 8, 12].map((offset) => runtime.read32(rect + offset)),
    [20, 65, 112, 93],
  );

  const creation = callbacks.find(
    (args) => args[1] === WM_PARENTNOTIFY && parentNotifyWords({ wParam: args[2] }).event === 1,
  );
  assert.ok(creation, 'parent WNDPROC receives WM_PARENTNOTIFY/WM_CREATE');
  assert.deepEqual(parentNotifyWords({ wParam: creation[2], lParam: creation[3] }), {
    event: 1,
    controlId: 77,
    childId: child.id,
  });
  const emitted = events.find(
    (event) =>
      event.type === 'window' && event.operation === 'create' && event.window.id === child.id,
  );
  assert.deepEqual(
    {
      parentId: emitted.window.parentId,
      controlType: emitted.window.controlType,
      x: emitted.window.x,
      y: emitted.window.y,
      width: emitted.window.width,
      height: emitted.window.height,
      enabled: emitted.window.enabled,
    },
    { parentId, controlType: 'button', x: 8, y: 13, width: 92, height: 28, enabled: true },
  );
});

test('WM_SETTEXT A/W stores edit text and notifies parent with EN_UPDATE then EN_CHANGE', async (t) => {
  const { runtime, parentId, callbacks } = await makeHarness(t);
  const ansi = await createChild(runtime, parentId, {
    className: 'EDIT',
    title: '',
    controlId: 31,
    style: WS_CHILD | WS_VISIBLE,
  });
  const wide = await createChild(runtime, parentId, {
    className: 'EDIT',
    title: '',
    controlId: 32,
    wide: true,
    style: WS_CHILD | WS_VISIBLE,
    x: 10,
  });
  assert.ok(ansi.result && wide.result);
  callbacks.length = 0;

  const ansiText = runtime.allocString('ANSI value');
  assert.equal(
    (await call(runtime, 'user32.dll!SetWindowTextA', [ansi.result, ansiText])).result,
    1,
  );
  const wideText = runtime.allocString('wide café €', true);
  assert.equal(
    (await call(runtime, 'user32.dll!SetWindowTextW', [wide.result, wideText])).result,
    1,
  );
  assert.equal(runtime.windows.windows.get(ansi.result).title, 'ANSI value');
  assert.equal(runtime.windows.windows.get(wide.result).title, 'wide café €');

  const commands = callbacks
    .filter((args) => args[1] === WM_COMMAND)
    .map((args) => commandWords({ wParam: args[2], lParam: args[3] }));
  assert.deepEqual(commands, [
    { notification: 0x400, controlId: 31, childId: ansi.result },
    { notification: 0x300, controlId: 31, childId: ansi.result },
    { notification: 0x400, controlId: 32, childId: wide.result },
    { notification: 0x300, controlId: 32, childId: wide.result },
  ]);

  const length = await call(runtime, 'user32.dll!GetWindowTextLengthW', [wide.result]);
  assert.equal(length.result, 'wide café €'.length);
  const output = runtime.allocate(64);
  assert.equal(
    (await call(runtime, 'user32.dll!GetWindowTextW', [wide.result, output, 32])).result,
    'wide café €'.length,
  );
  assert.equal(runtime.wideString(output), 'wide café €');
});

test('browser button and edit input enqueue parent notifications without re-entering guest code', async (t) => {
  const harness = await makeHarness(t);
  const { runtime, parentId, callbacks } = harness;
  const button = await createChild(runtime, parentId, { className: 'BUTTON', controlId: 41 });
  const edit = await createChild(runtime, parentId, {
    className: 'EDIT',
    title: 'before',
    controlId: 42,
  });
  assert.ok(button.result && edit.result);
  const manager = runtime.windows;
  const parentWindow = manager.windows.get(parentId);
  parentWindow.visible = true;
  manager.queue.length = 0;
  callbacks.length = 0;

  harness.setParentHook(async ([, message]) => {
    if (message !== 0x400) return;
    manager.input({ type: 'command', windowId: button.result, notification: 0 });
    manager.input({ type: 'text', windowId: edit.result, text: 'after' });
  });
  await manager.send(parentId, 0x400, 0, 0);

  assert.equal(
    harness.maximumGuestDepth,
    1,
    'input received during a guest callback does not recurse',
  );
  assert.equal(
    callbacks.filter((args) => args[1] === WM_COMMAND).length,
    0,
    'input only queues notifications while the guest callback is active',
  );
  assert.equal(runtime.windows.windows.get(edit.result).title, 'after');
  assert.deepEqual(
    manager.queue.map((message) => commandWords(message)),
    [
      { notification: 0, controlId: 41, childId: button.result },
      { notification: 0x400, controlId: 42, childId: edit.result },
      { notification: 0x300, controlId: 42, childId: edit.result },
    ],
  );

  const queued = manager.queue.splice(0);
  for (const message of queued)
    await manager.send(message.hwnd, message.message, message.wParam, message.lParam);
  assert.deepEqual(
    callbacks
      .filter((args) => args[1] === WM_COMMAND)
      .map((args) => commandWords({ wParam: args[2], lParam: args[3] })),
    [
      { notification: 0, controlId: 41, childId: button.result },
      { notification: 0x400, controlId: 42, childId: edit.result },
      { notification: 0x300, controlId: 42, childId: edit.result },
    ],
  );
});

test('child focus, ancestor visibility, and parent destruction cascade through controls', async (t) => {
  const { runtime, events, parentId, callbacks } = await makeHarness(t);
  const button = await createChild(runtime, parentId, { className: 'BUTTON', controlId: 51 });
  const edit = await createChild(runtime, parentId, {
    className: 'EDIT',
    controlId: 52,
    exStyle: 0x200,
    width: 120,
    height: 28,
  });
  assert.ok(button.result && edit.result);
  const manager = runtime.windows;

  assert.equal(
    manager.isVisible(button.result),
    false,
    'child visibility includes hidden ancestors',
  );
  assert.equal((await call(runtime, 'user32.dll!ShowWindow', [parentId, 5])).result, 0);
  assert.equal(manager.isVisible(button.result), true);
  assert.equal((await call(runtime, 'user32.dll!SetFocus', [edit.result])).result, 0);
  assert.equal((await call(runtime, 'user32.dll!GetFocus', [])).result, edit.result);
  assert.ok(
    events.some((event) => event.type === 'window-focus' && event.windowId === edit.result),
  );
  assert.ok(
    callbacks.some(
      (args) =>
        args[1] === WM_COMMAND &&
        commandWords({ wParam: args[2], lParam: args[3] }).notification === 0x100 &&
        args[3] === edit.result,
    ),
    'edit WM_SETFOCUS sends EN_SETFOCUS to its parent',
  );

  await call(runtime, 'user32.dll!ShowWindow', [parentId, 0]);
  assert.equal(manager.isVisible(edit.result), false);
  manager.queue.length = 0;
  manager.input({ type: 'command', windowId: button.result, notification: 0 });
  manager.input({ type: 'text', windowId: edit.result, text: 'hidden' });
  assert.equal(manager.queue.length, 0, 'hidden descendants do not accept browser input');
  assert.notEqual(manager.windows.get(edit.result).title, 'hidden');

  assert.equal((await call(runtime, 'user32.dll!DestroyWindow', [parentId])).result, 1);
  assert.equal(manager.windows.has(parentId), false);
  assert.equal(manager.windows.has(button.result), false);
  assert.equal(manager.windows.has(edit.result), false);
  assert.equal((await call(runtime, 'user32.dll!IsWindow', [edit.result])).result, 0);
  assert.equal(manager.isVisible(edit.result), false);
  assert.ok(
    events.some(
      (event) =>
        event.type === 'window' &&
        event.operation === 'destroy' &&
        event.window.id === button.result,
    ),
  );
});
