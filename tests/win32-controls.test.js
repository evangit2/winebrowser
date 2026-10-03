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

test('WS_EX_STATICEDGE uses one-pixel client geometry while CLIENTEDGE takes precedence', async (t) => {
  const { runtime, events, parentId } = await makeHarness(t);
  const rect = runtime.allocate(16);
  for (const [exStyle, border] of [
    [0x20000, 1],
    [0x20200, 2],
  ]) {
    const child = await createChild(runtime, parentId, {
      className: 'EDIT',
      exStyle,
      width: 120,
      height: 30,
    });
    assert.ok(child.result);
    const window = runtime.windows.windows.get(child.result);
    assert.equal(window.controlBorder, border);
    assert.equal((await call(runtime, 'user32.dll!GetClientRect', [child.result, rect])).result, 1);
    assert.deepEqual(
      [0, 4, 8, 12].map((i) => runtime.read32(rect + i)),
      [0, 0, 120 - 2 * border, 30 - 2 * border],
    );
    const published = events.findLast(
      (e) => e.type === 'window' && e.window.id === child.result,
    ).window;
    assert.equal(published.controlBorder, border);
    assert.equal(published.width, 120);
    assert.equal(published.height, 30);
  }
});

test('SS_OWNERDRAW dispatches a PE32 DRAWITEMSTRUCT with an isolated child HDC and resize/disable repaint', async (t) => {
  const { runtime, events, parentId, setParentHook } = await makeHarness(t);
  await call(runtime, 'user32.dll!ShowWindow', [parentId, 5]);
  const child = await createChild(runtime, parentId, {
    className: 'STATIC',
    style: WS_CHILD | WS_VISIBLE | 0xd,
    controlId: 60,
    width: 40,
    height: 24,
  });
  assert.ok(child.result);
  const painted = [];
  setParentHook(([hwnd, message, wp, lp]) => {
    if (message !== 0x2b) return;
    const fields = Array.from({ length: 12 }, (_, i) => runtime.read32(lp + i * 4));
    assert.equal(hwnd, parentId);
    assert.deepEqual(fields.slice(0, 7), [
      5,
      60,
      0,
      1,
      runtime.windows.isEnabled(child.result) ? 0 : 4,
      child.result,
      fields[6],
    ]);
    assert.equal(wp, 60);
    const w = runtime.windows.windows.get(child.result);
    assert.deepEqual(fields.slice(7), [0, 0, w.width, w.height, 0]);
    const brush = call(runtime, 'gdi32.dll!CreateSolidBrush', [
      fields[4] ? 0x46505a : 0x332211,
    ]).result;
    assert.equal(call(runtime, 'user32.dll!FillRect', [fields[6], lp + 28, brush]).result, 1);
    assert.equal(call(runtime, 'gdi32.dll!DeleteObject', [brush]).result, 1);
    painted.push({ dc: fields[6], width: w.width, height: w.height, disabled: !!fields[4] });
  });
  assert.equal(runtime.windows.next(child.result, 0xf, 0xf, false)?.message, 0xf);
  assert.equal((await call(runtime, 'user32.dll!UpdateWindow', [child.result])).result, 1);
  assert.equal(runtime.windows.windows.get(child.result).invalid, null);
  const dc = call(runtime, 'user32.dll!GetDC', [child.result]).result;
  assert.ok(dc);
  assert.equal(call(runtime, 'gdi32.dll!GetPixel', [dc, 10, 10]).result, 0x332211);
  const parentDC = call(runtime, 'user32.dll!GetDC', [parentId]).result;
  assert.notEqual(
    call(runtime, 'gdi32.dll!GetPixel', [parentDC, 10, 10]).result,
    0x332211,
    'child paint does not alter its parent framebuffer',
  );
  assert.equal(call(runtime, 'user32.dll!ReleaseDC', [parentId, parentDC]).result, 1);
  assert.equal(call(runtime, 'user32.dll!ReleaseDC', [child.result, dc]).result, 1);
  assert.equal(
    call(runtime, 'gdi32.dll!GetPixel', [painted[0].dc, 0, 0]).result,
    0xffffffff,
    'paint HDC is released after the callback',
  );
  assert.equal(
    (await call(runtime, 'user32.dll!MoveWindow', [child.result, 10, 12, 52, 30, 1])).result,
    1,
  );
  await call(runtime, 'user32.dll!EnableWindow', [child.result, 0]);
  await call(runtime, 'user32.dll!UpdateWindow', [child.result]);
  assert.deepEqual(
    painted.map(({ width, height, disabled }) => [width, height, disabled]),
    [
      [40, 24, false],
      [52, 30, true],
    ],
  );
  const frame = events.findLast((e) => e.type === 'frame' && e.windowId === child.result);
  assert.deepEqual([frame.width, frame.height], [52, 30]);
  assert.deepEqual([...frame.pixels.slice(0, 4)], [90, 80, 70, 255]);
  assert.equal((await call(runtime, 'user32.dll!DestroyWindow', [child.result])).result, 1);
  assert.equal(call(runtime, 'user32.dll!GetDC', [child.result]).result, 0);
});

test('owner-drawn child surfaces do not consume the eight top-level framebuffer slots', async (t) => {
  const { runtime, parentId } = await makeHarness(t);
  for (let i = 0; i < 10; i++) {
    const child = await createChild(runtime, parentId, {
      className: 'STATIC',
      style: WS_CHILD | WS_VISIBLE | 0xd,
    });
    assert.ok(child.result);
    const dc = call(runtime, 'user32.dll!GetDC', [child.result]).result;
    assert.ok(dc);
    call(runtime, 'user32.dll!ReleaseDC', [child.result, dc]);
  }
  assert.ok(call(runtime, 'user32.dll!GetDC', [parentId]).result);
});

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

test('multiline, password and case-filtered EDIT styles are modelled', async (t) => {
  const harness = await makeHarness(t);
  const { runtime, parentId } = harness;
  // Input is delivered only to a visible window, so the parent must be shown.
  runtime.windows.windows.get(parentId).visible = true;
  const create = (style, title = '') =>
    createChild(runtime, parentId, {
      className: 'EDIT',
      title,
      style: WS_CHILD | WS_VISIBLE | style,
    });
  // ES_MULTILINE | ES_AUTOVSCROLL survives line breaks.
  const multiline = await create(0x4 | 0x40, 'one');
  assert.ok(multiline.result);
  const multiWindow = runtime.windows.windows.get(multiline.result);
  assert.equal(multiWindow.multiline, true);
  runtime.windows.input({ type: 'text', windowId: multiline.result, text: 'a\nb\nc' });
  assert.equal(runtime.windows.windows.get(multiline.result).title, 'a\nb\nc');
  // ES_UPPERCASE rewrites typed text.
  const upper = await create(0x8);
  runtime.windows.input({ type: 'text', windowId: upper.result, text: 'mixed Case' });
  assert.equal(runtime.windows.windows.get(upper.result).title, 'MIXED CASE');
  // ES_LOWERCASE rewrites it the other way.
  const lower = await create(0x10);
  runtime.windows.input({ type: 'text', windowId: lower.result, text: 'MIXED Case' });
  assert.equal(runtime.windows.windows.get(lower.result).title, 'mixed case');
  // ES_NUMBER strips everything but digits and the minus sign.
  const numeric = await create(0x2000);
  runtime.windows.input({ type: 'text', windowId: numeric.result, text: 'a1b2-c3' });
  assert.equal(runtime.windows.windows.get(numeric.result).title, '12-3');
  // ES_PASSWORD is recorded and reaches the desktop, which turns the element
  // into a password field.
  const password = await create(0x20);
  assert.equal(runtime.windows.windows.get(password.result).password, true);
  const emitted = [];
  const originalEmit = runtime.emit;
  runtime.emit = (event) => emitted.push(event);
  runtime.windows.emit(runtime.windows.windows.get(password.result));
  runtime.emit = originalEmit;
  const published = emitted.find((e) => e.type === 'window')?.window;
  assert.equal(published.controlStyle.password, true, 'ES_PASSWORD reached the desktop');
  // An unsupported style bit and a contradictory alignment are rejected,
  // rather than silently producing a control with different behaviour.
  await assert.rejects(create(0x4000), /Unsupported EDIT control style/);
  await assert.rejects(create(0x3), /mutually exclusive/);
  await assert.rejects(create(0x20 | 0x4), /ES_PASSWORD requires single line/);
  // A single-line edit still flattens line breaks.
  const single = await create(0);
  runtime.windows.input({ type: 'text', windowId: single.result, text: 'x\ny' });
  assert.equal(runtime.windows.windows.get(single.result).title, 'xy');
});

test('the BUTTON family models check state, radio groups and group boxes', async (t) => {
  const harness = await makeHarness(t);
  const { runtime, parentId, callbacks } = harness;
  runtime.windows.windows.get(parentId).visible = true;
  const create = (style, title, controlId) =>
    createChild(runtime, parentId, {
      className: 'BUTTON',
      title,
      controlId,
      style: WS_CHILD | WS_VISIBLE | style,
    });
  const send = (id, message, wp = 0, lp = 0) =>
    call(runtime, 'user32.dll!SendMessageA', [id, message, wp, lp]);
  // SendMessageA resolves asynchronously, so the result must be awaited before
  // its `result` field is read.
  const check = async (id) => (await send(id, 0xf0)).result;

  // An automatic checkbox toggles on BM_CLICK and notifies its parent.
  const box = await create(0x3, 'Auto', 60);
  assert.equal(await check(box.result), 0);
  callbacks.length = 0;
  await send(box.result, 0xf5);
  assert.equal(await check(box.result), 1, 'BM_CLICK checks an automatic checkbox');
  assert.equal(callbacks.filter((a) => a[1] === WM_COMMAND).length, 1);
  await send(box.result, 0xf5);
  assert.equal(await check(box.result), 0, 'a second click unchecks it');

  // A manual checkbox changes state only through BM_SETCHECK.
  const manual = await create(0x2, 'Manual', 61);
  await send(manual.result, 0xf5);
  assert.equal(await check(manual.result), 0, 'a click does not toggle a manual checkbox');
  assert.equal((await send(manual.result, 0xf1, 1)).result, 0);
  assert.equal(await check(manual.result), 1);

  // A two-state button cannot hold the indeterminate state.
  assert.equal(await check(manual.result), 1);
  await send(manual.result, 0xf1, 2);
  assert.equal(await check(manual.result), 1, 'indeterminate is rejected on a two-state button');

  // A three-state button cycles unchecked -> checked -> indeterminate.
  const three = await create(0x6, 'Tri', 62);
  assert.equal(await check(three.result), 0);
  await send(three.result, 0xf5);
  assert.equal(await check(three.result), 1);
  await send(three.result, 0xf5);
  assert.equal(await check(three.result), 2);
  await send(three.result, 0xf5);
  assert.equal(await check(three.result), 0);

  // Radio buttons in one group are mutually exclusive, and checking one clears
  // the others, so a dialog reading the group sees exactly one selection.
  const group = await create(0x20007, 'Group', 63);
  const radioA = await create(0x9, 'A', 64);
  const radioB = await create(0x9, 'B', 65);
  await send(radioA.result, 0xf5);
  assert.equal(await check(radioA.result), 1);
  await send(radioB.result, 0xf5);
  assert.equal(await check(radioB.result), 1);
  assert.equal(await check(radioA.result), 0, 'the previously checked radio was cleared');
  await send(radioA.result, 0xf5);
  assert.equal(await check(radioB.result), 0, 'preceding radio clears following radio too');
  await send(radioA.result, 0xf5);
  assert.equal(await check(radioA.result), 1, 'checked automatic radio remains checked');
  await send(radioB.result, 0xf5);
  // WS_GROUP on the following group box starts a new native group.
  const second = await create(0x20007, 'Second', 66);
  const radioC = await create(0x9, 'C', 67);
  await send(radioC.result, 0xf5);
  assert.equal(await check(radioB.result), 1, 'the earlier group is unaffected');
  assert.equal(await check(radioC.result), 1);
  assert.ok(group.result && second.result);
  // A group box publishes its caption through the legend, not as body text.
  const emitted = [];
  const originalEmit = runtime.emit;
  runtime.emit = (event) => emitted.push(event);
  runtime.windows.emit(runtime.windows.windows.get(group.result));
  runtime.emit = originalEmit;
  const published = emitted.find((event) => event.type === 'window')?.window;
  assert.equal(published.controlStyle.groupBox, true);
  assert.equal(published.controlStyle.buttonType, 'group-box');
  // An unknown BUTTON style and an undocumented modifier bit are rejected.
  await assert.rejects(create(0xf, 'Bad', 68), /Unsupported BUTTON style/);
  await assert.rejects(create(0x10, 'Bad', 69), /Unsupported BUTTON modifier bits/);
  // BS_ICON and BS_BITMAP share one drawing slot, so the OS rejects both.
  await assert.rejects(create(0xc0, 'Bad', 90), /mutually exclusive/);
  // BS_FLAT is accepted.
  const flat = await create(0x8000, 'Flat', 70);
  assert.ok(flat.result);
});

test('BUTTON layout and notification modifiers are published to the desktop', async (t) => {
  const harness = await makeHarness(t);
  const { runtime, parentId } = harness;
  runtime.windows.windows.get(parentId).visible = true;
  const create = (style) =>
    createChild(runtime, parentId, {
      className: 'BUTTON',
      title: 'Caption',
      style: WS_CHILD | WS_VISIBLE | style,
    });
  const publish = (id) => {
    const emitted = [];
    const originalEmit = runtime.emit;
    runtime.emit = (event) => emitted.push(event);
    runtime.windows.emit(runtime.windows.windows.get(id));
    runtime.emit = originalEmit;
    return emitted.find((event) => event.type === 'window')?.window.controlStyle;
  };

  // Every documented modifier bit is accepted and round-trips.
  const modifiers = [
    0x20, 0x100, 0x200, 0x300, 0x400, 0x800, 0xc00, 0x1000, 0x2000, 0x4000, 0x8000,
  ];
  for (const bit of modifiers) {
    const control = await create(bit);
    assert.ok(control.result, `BUTTON style 0x${bit.toString(16)} is accepted`);
    assert.ok(publish(control.result), 'the modifier is republished');
  }

  // BS_RIGHTBUTTON/BS_LEFTTEXT (0x20) swaps the caption and the glyph.
  assert.equal(publish((await create(0x20)).result).leftText, true);
  assert.equal(publish((await create(0)).result).leftText, false);

  // The 0x300 field picks the horizontal alignment; the 0xc00 field the vertical.
  const horizontal = new Map([
    [0x000, 'center'],
    [0x100, 'left'],
    [0x200, 'right'],
    [0x300, 'center'],
  ]);
  for (const [bits, expected] of horizontal) {
    assert.equal(
      publish((await create(bits)).result).horizontalAlign,
      expected,
      `0x${bits.toString(16)}`,
    );
  }
  const vertical = new Map([
    [0x000, 'center'],
    [0x400, 'top'],
    [0x800, 'bottom'],
    [0xc00, 'center'],
  ]);
  for (const [bits, expected] of vertical) {
    assert.equal(
      publish((await create(bits)).result).verticalAlign,
      expected,
      `0x${bits.toString(16)}`,
    );
  }

  // BS_PUSHLIKE renders a checkbox as a push button; BS_MULTILINE wraps; and
  // BS_NOTIFY asks the parent for BN_* messages it would not otherwise get.
  const pushLike = await create(0x3 | 0x1000);
  assert.equal(publish(pushLike.result).pushLike, true);
  assert.equal(publish(pushLike.result).buttonType, 'auto-checkbox');
  assert.equal(publish((await create(0x1000)).result).pushLike, true);
  const multiline = await create(0x2000);
  assert.equal(publish(multiline.result).multilineCaption, true);
  const notify = await create(0x4000);
  assert.equal(publish(notify.result).notify, true);
  // BS_ICON / BS_BITMAP are accepted individually and mutually exclusive together.
  const icon = await create(0x40);
  assert.equal(publish(icon.result).icon, true);
  assert.equal(publish(icon.result).bitmap, false);
  const bitmap = await create(0x80);
  assert.equal(publish(bitmap.result).bitmap, true);
  assert.equal(publish(bitmap.result).icon, false);
  // A push button's default alignment is preserved when no bits are set.
  const plain = publish((await create(0)).result);
  assert.equal(plain.horizontalAlign, 'center');
  assert.equal(plain.verticalAlign, 'center');
});
