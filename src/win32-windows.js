import {
  builtinControlClass,
  controlStyle,
  controlMessage,
  controlInput,
} from './win32-controls.js';
import { encodeAnsi } from './encoding.js';
import { sendWindowMessage } from './win32-window-text.js';
import { gdiApis, flushGdi, resizeWindowSurface, destroyWindowSurface } from './win32-gdi.js';
import { virtualSystemMetric } from './win32-display.js';
import { iconForHandle } from './win32-icons.js';
import { cursorApis, setCursor } from './win32-cursors.js';
import { windowFindApis } from './win32-window-find.js';
import {
  windowFrame,
  frameForWindow,
  MAX_WINDOW_WIDTH,
  MAX_WINDOW_HEIGHT,
} from './window-frame.js';
import { windowDataApis } from './win32-window-data.js';
import { setWindowPos } from './win32-window-position.js';
import { inputState } from './dinput-device.js';

const BORDER = 1,
  TITLE = 28;
const result = (value = 0, argc = 0) => ({ result: value >>> 0, argc });
const pair = (x, y) => ((x & 0xffff) | ((y & 0xffff) << 16)) >>> 0;
const text = (r, p, wide) => (wide ? r.wideString(p) : r.string(p));

// One guest GUI thread. Browser events only enqueue messages; guest callbacks
// execute on the existing CPU dispatch stack, never reentrantly from onmessage.
export class WindowManager {
  constructor(runtime) {
    this.runtime = runtime;
    this.classes = new Map();
    this.atoms = new Map();
    this.windows = new Map();
    this.queue = [];
    this.delivered = new Map();
    this.timers = new Map();
    this.keys = new Map();
    this.keyboardState = new Map();
    this.accelerators = new Map();
    this.nextAccelerator = 0x30000;
    this.nextAtom = 0xc000;
    this.nextWindow = 0x20000;
    this.nextZOrder = 1;
    this.nextTimer = 1;
    this.focus = 0;
    this.active = 0;
    this.capture = 0;
  }
  get active() {
    return this._active ?? 0;
  }
  set active(value) {
    this._active = value;
    this.runtime.directInput?.foregroundChanged();
  }
  fail(code, argc, value = 0) {
    this.runtime.lastError = code;
    return result(value, argc);
  }
  emit(window, operation = 'update') {
    const {
      id,
      title,
      x,
      y,
      width,
      height,
      visible,
      parentId = 0,
      controlType,
      enabled,
      font,
      readOnly,
      textAlign,
      noPrefix,
    } = window;
    const border = window.controlBorder ?? 0;
    this.runtime.emit({
      type: 'window',
      operation,
      window: {
        id,
        title,
        x,
        y,
        width: width + 2 * border,
        height: height + 2 * border,
        visible,
        parentId,
        controlType,
        controlBorder: border,
        enabled,
        topmost: !!window.topmost,
        zOrder: window.zOrder,
        frame: parentId ? undefined : frameForWindow(window),
        font,
        readOnly,
        textAlign,
        noPrefix,
        icon:
          parentId || !window.cls?.icon ? undefined : iconForHandle(this.runtime, window.cls.icon),
      },
    });
  }
  post(hwnd, message, wParam = 0, lParam = 0, extra = {}) {
    if (hwnd && !this.windows.has(hwnd)) return false;
    if (this.queue.length >= 4096) throw Error('Window message queue limit exceeded');
    const coalesced =
      [0x200, 0x113].includes(message) &&
      this.queue.find(
        (m) =>
          m.hwnd === hwnd && m.message === message && (message !== 0x113 || m.wParam === wParam),
      );
    if (coalesced) {
      if (message === 0x200)
        Object.assign(coalesced, {
          wParam,
          lParam,
          time: Math.floor(performance.now()) >>> 0,
          ...extra,
        });
      return true;
    }
    this.queue.push({
      hwnd,
      message,
      wParam,
      lParam,
      time: Math.floor(performance.now()) >>> 0,
      x: 0,
      y: 0,
      ...extra,
    });
    this.wake?.();
    this.wake = null;
    return true;
  }
  invalidate(window, rect, erase) {
    const r = rect ?? [0, 0, window.width, window.height];
    window.invalid = window.invalid
      ? [
          Math.min(window.invalid[0], r[0]),
          Math.min(window.invalid[1], r[1]),
          Math.max(window.invalid[2], r[2]),
          Math.max(window.invalid[3], r[3]),
        ]
      : r;
    window.erase ||= erase;
    this.wake?.();
    this.wake = null;
  }
  async send(hwnd, message, wParam = 0, lParam = 0) {
    const window = this.windows.get(hwnd);
    if (!window) {
      this.runtime.lastError = 1400;
      return 0;
    }
    if (window.controlType)
      return controlMessage(
        this.runtime,
        window,
        message,
        wParam,
        lParam,
        async () =>
          (
            await defaultProc(
              this.runtime,
              (i) => [hwnd, message, wParam, lParam][i],
              window.cls.wide,
            )
          ).result,
      );
    return this.runtime.callGuest(window.proc, [hwnd, message, wParam, lParam]);
  }
  async destroy(hwnd) {
    const window = this.windows.get(hwnd);
    if (!window || window.destroying) return 0;
    window.destroying = true;
    await this.send(hwnd, 2);
    for (const child of [...this.windows.values()])
      if (child.parentId === hwnd) await this.destroy(child.id);
    await this.send(hwnd, 0x82);
    if (window.parentId && !(window.exStyle & 4) && !this.windows.get(window.parentId)?.destroying)
      await this.send(window.parentId, 0x210, pair(2, window.controlId), hwnd);
    for (const [key, timer] of this.timers)
      if (timer.hwnd === hwnd) {
        clearInterval(timer.interval);
        this.timers.delete(key);
      }
    this.queue = this.queue.filter((m) => m.hwnd !== hwnd);
    if (this.focus === hwnd) this.focus = 0;
    if (this.active === hwnd) this.active = 0;
    if (this.capture === hwnd) this.capture = 0;
    destroyWindowSurface(this.runtime, hwnd);
    this.windows.delete(hwnd);
    if (window.presented) this.emit(window, 'destroy');
    return 1;
  }
  dispose() {
    for (const timer of this.timers.values()) clearInterval(timer.interval);
    this.timers.clear();
    for (const window of this.windows.values()) {
      destroyWindowSurface(this.runtime, window.id);
      this.emit(window, 'destroy');
    }
    this.windows.clear();
    this.queue = [];
    this.delivered.clear();
    this.keys.clear();
    this.keyboardState.clear();
    this.accelerators.clear();
    this.focus = this.capture = this.active = 0;
    this.wake?.();
    this.wake = null;
  }
  isVisible(hwnd) {
    let window = this.windows.get(hwnd);
    if (!window) return false;
    while (window) {
      if (!window.visible) return false;
      window = window.parentId ? this.windows.get(window.parentId) : null;
    }
    return true;
  }
  topLevel(hwnd) {
    let window = this.windows.get(hwnd);
    while (window?.parentId) window = this.windows.get(window.parentId);
    return window?.id ?? 0;
  }
  raise(hwnd) {
    const window = this.windows.get(this.topLevel(hwnd));
    if (window) {
      window.zOrder = this.nextZOrder++;
      if (window.presented)
        this.runtime.emit({
          type: 'window-stack',
          windowId: window.id,
          zOrder: window.zOrder,
          topmost: window.topmost,
        });
    }
  }
  async setFocus(hwnd, raise = true) {
    const previous = this.focus;
    if (hwnd && !this.windows.has(hwnd)) return this.fail(1400, 1);
    if (hwnd && !this.isEnabled(hwnd)) return this.fail(87, 1);
    if (previous === hwnd) return result(previous, 1);
    this.focus = hwnd;
    if (hwnd) {
      this.active = this.topLevel(hwnd);
      if (raise) this.raise(hwnd);
    }
    this.runtime.emit({
      type: 'window-focus',
      windowId: hwnd,
      preserveOrder: true,
    });
    if (previous) await this.send(previous, 8, hwnd);
    if (hwnd && this.focus === hwnd && this.windows.has(hwnd)) await this.send(hwnd, 7, previous);
    return result(previous, 1);
  }
  isEnabled(hwnd) {
    let window = this.windows.get(hwnd);
    if (!window) return false;
    while (window) {
      if (window.enabled === false) return false;
      window = window.parentId ? this.windows.get(window.parentId) : null;
    }
    return true;
  }
  screenPosition(window) {
    let x = window.x,
      y = window.y,
      current = window;
    while (current.parentId) {
      const parent = this.windows.get(current.parentId);
      if (!parent) break;
      const frame = frameForWindow(parent);
      x += parent.x + frame.border;
      y += parent.y + frame.title + frame.border;
      current = parent;
    }
    return [x, y];
  }
  clientPosition(window) {
    const [x, y] = this.screenPosition(window),
      frame = frameForWindow(window);
    return [x + frame.border, y + frame.border + frame.title];
  }
  // Virtual-screen pointer position, updated by browser mouse input.
  pointerPosition() {
    return this.pointer ?? { x: 0, y: 0 };
  }
  setPointerPosition(x, y) {
    this.pointer = { x: x | 0, y: y | 0 };
  }
  // The deepest visible top-level or child window under a screen point.
  windowFromPoint(x, y) {
    const inside = (w) => {
      const [ox, oy] = this.screenPosition(w),
        frame = frameForWindow(w);
      return (
        x >= ox &&
        y >= oy &&
        x < ox + w.width + 2 * frame.border &&
        y < oy + w.height + frame.title + 2 * frame.border
      );
    };
    const candidates = [...this.windows.values()]
      .filter((w) => this.isVisible(w.id) && inside(w))
      .sort((a, b) => (b.parentId ? 1 : 0) - (a.parentId ? 1 : 0));
    return candidates[0]?.id ?? 0;
  }
  // Window-message properties (GetProp/SetProp), keyed by handle then string.
  props(hwnd) {
    this.propertyMap ??= new Map();
    let map = this.propertyMap.get(hwnd);
    if (!map) this.propertyMap.set(hwnd, (map = new Map()));
    return map;
  }
  input(event) {
    const directInput = inputState(this.runtime);
    if (event.type === 'app-blur') {
      directInput.blur();
      this.keys.clear();
      this.keyboardState.clear();
      return;
    }
    if (event.type === 'app-focus') {
      directInput.focused = true;
      return;
    }
    const hwnd = this.capture && event.type.startsWith('mouse') ? this.capture : event.windowId;
    const window = this.windows.get(hwnd);
    if (!window || !this.isVisible(hwnd) || !this.isEnabled(hwnd)) return;
    // Remember the pointer in virtual-screen coordinates before any handler
    // may consume the event. GetCursorPos and ScreenToClient report this.
    if (['mousemove', 'mousedown', 'mouseup'].includes(event.type)) {
      const [originX, originY] = this.clientPosition(window);
      this.pointer = { x: (originX + event.x) | 0, y: (originY + event.y) | 0 };
    }
    if (directInput.input(event, window)) return;
    if (controlInput(this.runtime, window, event)) return;
    if (event.type === 'close') this.post(hwnd, 0x10);
    else if (event.type === 'focus') {
      this.active = this.topLevel(hwnd);
      this.raise(hwnd);
      if (this.focus === hwnd) return;
      if (this.focus) this.post(this.focus, 8, hwnd);
      const previous = this.focus;
      this.focus = hwnd;
      this.post(hwnd, 7, previous);
    } else if (event.type === 'move') {
      if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
      window.x = Math.max(-1024, Math.min(4096, Math.round(event.x)));
      window.y = Math.max(0, Math.min(4096, Math.round(event.y)));
      const frame = frameForWindow(window);
      this.post(hwnd, 3, 0, pair(window.x + frame.border, window.y + frame.title + frame.border));
      this.emit(window);
    } else if (event.type === 'resize') {
      if (!Number.isFinite(event.width) || !Number.isFinite(event.height)) return;
      const width = Math.max(1, Math.min(MAX_WINDOW_WIDTH, Math.round(event.width))),
        height = Math.max(1, Math.min(MAX_WINDOW_HEIGHT, Math.round(event.height)));
      if (!resizeWindowSurface(this.runtime, hwnd, width, height)) return;
      window.width = width;
      window.height = height;
      this.invalidate(window, null, true);
      this.post(hwnd, 5, 0, pair(window.width, window.height));
      this.emit(window);
    } else if (event.type === 'keydown' || event.type === 'keyup') {
      const vk = event.keyCode >>> 0;
      if (!vk || vk > 255) return;
      const up = event.type === 'keyup';
      const previous = this.keys.get(vk) ?? 0;
      this.keys.set(vk, up ? previous & 1 : 0x8001);
      const system = !!event.altKey || vk === 18;
      const flags =
        (1 |
          (event.altKey ? 1 << 29 : 0) |
          (event.repeat || up ? 1 << 30 : 0) |
          (up ? 0x80000000 : 0)) >>>
        0;
      this.post(hwnd, (system ? 0x104 : 0x100) + (up ? 1 : 0), vk, flags, {
        modifiers: { shiftKey: !!event.shiftKey, ctrlKey: !!event.ctrlKey, altKey: !!event.altKey },
        character: !up && typeof event.key === 'string' && event.key.length === 1 ? event.key : '',
      });
    } else if (['mousemove', 'mousedown', 'mouseup'].includes(event.type)) {
      if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
      const message =
        event.type === 'mousemove'
          ? 0x200
          : event.button === 2
            ? event.type === 'mousedown'
              ? 0x204
              : 0x205
            : event.button === 1
              ? event.type === 'mousedown'
                ? 0x207
                : 0x208
              : event.type === 'mousedown'
                ? 0x201
                : 0x202;
      const buttons =
        (event.buttons & 1 ? 1 : 0) | (event.buttons & 2 ? 2 : 0) | (event.buttons & 4 ? 16 : 0);
      const [screenX, screenY] = this.clientPosition(window);
      this.post(hwnd, message, buttons, pair(event.x, event.y), {
        hardwareMouse: true,
        cursorSent: false,
        x: screenX + event.x,
        y: screenY + event.y,
      });
    }
  }
  next(hwnd, min, max, remove) {
    const accepts = (m) =>
      m.message === 0x12 ||
      ((!hwnd || (hwnd === 0xffffffff ? !m.hwnd : m.hwnd === hwnd)) &&
        ((!min && !max) || (m.message >= min && m.message <= max)));
    let index = this.queue.findIndex(accepts);
    if (index >= 0) return remove ? this.queue.splice(index, 1)[0] : this.queue[index];
    for (const window of this.windows.values()) {
      const message = {
        hwnd: window.id,
        message: 0xf,
        wParam: 0,
        lParam: 0,
        time: Math.floor(performance.now()) >>> 0,
        x: 0,
        y: 0,
      };
      if (this.isVisible(window.id) && !window.controlType && window.invalid && accepts(message))
        return message;
    }
    return null;
  }
  async message(a, peek) {
    const pointer = a(0),
      hwnd = a(1),
      min = a(2),
      max = a(3);
    try {
      this.runtime.check(pointer, 28, true);
    } catch {
      return this.fail(87, peek ? 5 : 4, peek ? 0 : -1);
    }
    if (hwnd && hwnd !== 0xffffffff && !this.windows.has(hwnd))
      return this.fail(1400, peek ? 5 : 4, peek ? 0 : -1);
    if (peek && a(4) & ~1) throw Error('Unsupported PeekMessage flags');
    let message;
    while (!(message = this.next(hwnd, min, max, !peek || !!(a(4) & 1)))) {
      flushGdi(this.runtime);
      if (peek) {
        await this.runtime.threads.block(new Promise((resolve) => setTimeout(resolve, 0)));
        return result(0, 5);
      }
      await this.runtime.threads.block(
        new Promise((resolve) => {
          this.wake = resolve;
        }),
      );
    }
    if ((!peek || a(4) & 1) && [0x100, 0x101, 0x104, 0x105].includes(message.message)) {
      const down = !(message.message & 1),
        vk = message.wParam;
      const previous = this.keyboardState.get(vk) ?? 0;
      const toggle = [20, 144, 145].includes(vk) && down && !(previous & 0x8000);
      this.keyboardState.set(vk, (down ? 0x8000 : 0) | ((previous ^ (toggle ? 1 : 0)) & 1));
      if (message.modifiers) {
        for (const [key, code] of [
          ['shiftKey', 16],
          ['ctrlKey', 17],
          ['altKey', 18],
        ])
          this.keyboardState.set(code, message.modifiers[key] ? 0x8000 : 0);
      }
    }
    if (
      message.hardwareMouse &&
      !message.cursorSent &&
      !this.capture &&
      this.windows.has(message.hwnd)
    ) {
      // WM_SETCURSOR is a synchronous sent message, not an extra queued event.
      message.cursorSent = true;
      await this.send(message.hwnd, 0x20, message.hwnd, pair(1, message.message));
    }
    const fields = [
      message.hwnd,
      message.message,
      message.wParam,
      message.lParam,
      message.time,
      message.x,
      message.y,
    ];
    fields.forEach((value, i) => this.runtime.write32(pointer + i * 4, value));
    this.delivered.set(pointer, message);
    if (this.delivered.size > 64) this.delivered.delete(this.delivered.keys().next().value);
    return result(peek || message.message !== 0x12 ? 1 : 0, peek ? 5 : 4);
  }
}

function register(r, a, wide, extended) {
  const manager = r.windows,
    start = a(0),
    p = start + (extended ? 4 : 0);
  r.check(start, extended ? 48 : 40);
  if (extended && r.read32(start) !== 48) return manager.fail(87, 1);
  const name = text(r, r.read32(p + 36), wide).toLowerCase();
  const extra = r.read32(p + 12);
  if (!name || manager.classes.has(name)) return manager.fail(1410, 1);
  if (r.read32(p + 8) || extra > 4096 || r.read32(p + 32))
    throw Error('Window class extra data or class menus are unsupported');
  if (manager.classes.size >= 128) return manager.fail(8, 1);
  const cls = {
    name,
    atom: manager.nextAtom++,
    style: r.read32(p),
    proc: r.read32(p + 4),
    extra,
    instance: r.read32(p + 16),
    icon: (extended && r.read32(p + 40)) || r.read32(p + 20),
    cursor: r.read32(p + 24),
    background: r.read32(p + 28),
    wide,
  };
  manager.classes.set(name, cls);
  manager.atoms.set(cls.atom, cls);
  return result(cls.atom, 1);
}

async function create(r, a, wide) {
  const m = r.windows,
    classId = a(1);
  const name = classId <= 0xffff ? null : text(r, classId, wide).toLowerCase();
  const cls =
    classId <= 0xffff
      ? m.atoms.get(classId)
      : (m.classes.get(name) ?? builtinControlClass(name, wide));
  if (!cls) return m.fail(1407, 12);
  const child = !!(a(3) & 0x40000000),
    parentId = child ? a(8) : 0;
  if (child && !m.windows.has(parentId)) return m.fail(1400, 12);
  if (!child && (a(8) || a(9))) throw Error('Owned windows and menus are not implemented');
  if (cls.controlType && !child) throw Error('Standard controls require a parent window');
  if (child && !cls.controlType) throw Error('Custom child window rendering is not implemented');
  const control = child ? controlStyle(cls.controlType, a(3), a(0)) : {};
  if (!child && a(0) & ~0x40008) throw Error('Unsupported extended window style');
  const count = [...m.windows.values()].filter((w) => !!w.parentId === child).length;
  if (count >= (child ? 256 : 8)) return m.fail(8, 12);
  const width = a(6) === 0x80000000 ? 480 : a(6) | 0,
    height = a(7) === 0x80000000 ? 320 : a(7) | 0;
  const frame = windowFrame(a(3)),
    border = child ? control.controlBorder : frame.border,
    titleHeight = child ? 0 : frame.title;
  if (
    width < 2 * border ||
    height < titleHeight + 2 * border ||
    width - 2 * border > MAX_WINDOW_WIDTH ||
    height - titleHeight - 2 * border > MAX_WINDOW_HEIGHT
  )
    return m.fail(87, 12);
  const w = {
    id: m.nextWindow++,
    // New child controls go behind siblings; top-level windows go in front.
    zOrder: (child ? -1 : 1) * m.nextZOrder++,
    cls,
    proc: cls.proc,
    title: text(r, a(2), wide),
    x: a(4) === 0x80000000 ? 20 + m.windows.size * 24 : a(4) | 0,
    y: a(5) === 0x80000000 ? 20 + m.windows.size * 24 : a(5) | 0,
    width: width - 2 * border,
    height: height - titleHeight - 2 * border,
    parentId,
    controlType: cls.controlType,
    controlId: child ? a(9) : 0,
    enabled: !(a(3) & 0x08000000),
    ...control,
    visible: false,
    style: (a(3) | (child ? 0 : 0x04000000 | (a(3) & 0x80000000 ? 0 : 0x00c00000))) >>> 0,
    exStyle: (a(0) | (!child && !(a(3) & 0x80000000) && a(3) & 0x00c40000 ? 0x100 : 0)) >>> 0,
    topmost: !child && !!(a(0) & 8),
    instance: a(10),
    userData: 0,
    extra: new DataView(new ArrayBuffer(cls.extra)),
    invalid: null,
    erase: false,
  };
  m.windows.set(w.id, w);
  const cs = r.allocate(48);
  const clientRect = r.allocate(16);
  const values = [a(11), a(10), a(9), a(8), height, width, w.y, w.x, a(3), a(2), a(1), a(0)];
  values.forEach((v, i) => r.write32(cs + i * 4, v));
  try {
    if (!(await m.send(w.id, 0x81, 0, cs))) {
      destroyWindowSurface(r, w.id);
      m.windows.delete(w.id);
      return m.fail(1407, 12);
    }
    rectangle(r, clientRect, [w.x, w.y, w.x + width, w.y + height]);
    await m.send(w.id, 0x83, 0, clientRect);
    const clientWidth = (r.read32(clientRect + 8) - r.read32(clientRect)) | 0;
    const clientHeight = (r.read32(clientRect + 12) - r.read32(clientRect + 4)) | 0;
    if (clientWidth !== w.width || clientHeight !== w.height)
      throw Error('Custom nonclient window geometry is unsupported');
    m.emit(w, 'create');
    w.presented = true;
    if ((await m.send(w.id, 1, 0, cs)) === 0xffffffff) {
      await m.destroy(w.id);
      return m.fail(1407, 12);
    }
    if (!m.windows.has(w.id)) return result(0, 12);
    if (parentId && !(w.exStyle & 4)) await m.send(parentId, 0x210, pair(1, w.controlId), w.id);
    if (w.style & 0x10000000) await show(r, (i) => [w.id, 5][i]);
    return result(w.id, 12);
  } finally {
    r.free(clientRect);
    r.free(cs);
  }
}
async function show(r, a) {
  const w = r.windows.windows.get(a(0));
  if (!w) return r.windows.fail(1400, 2);
  if (![0, 1, 5, 8, 9, 10].includes(a(1)))
    throw Error('Minimized/maximized windows are not implemented');
  const previous = w.visible;
  w.visible = a(1) !== 0;
  if (!w.parentId) {
    if (w.visible && a(1) !== 8) {
      r.windows.active = w.id;
      r.windows.raise(w.id);
    } else if (!w.visible && r.windows.active === w.id) r.windows.active = 0;
  }
  r.windows.emit(w);
  await r.windows.send(w.id, 0x18, w.visible ? 1 : 0);
  if (w.visible) {
    r.windows.invalidate(w, null, true);
    await r.windows.send(w.id, 5, 0, pair(w.width, w.height));
  }
  return result(previous ? 1 : 0, 2);
}
function rectangle(r, p, rect) {
  r.check(p, 16, true);
  rect.forEach((v, i) => r.write32(p + i * 4, v));
}
async function defaultProc(r, a, wide) {
  const [hwnd, msg, wp, lp] = [a(0), a(1), a(2), a(3)],
    w = r.windows.windows.get(hwnd);
  if (!w) return result(0, 4);
  if (msg === 0x20) {
    const hit = lp & 0xffff;
    if (w.parentId && !(hit >= 10 && hit <= 17) && (await r.windows.send(w.parentId, msg, wp, lp)))
      return result(1, 4);
    const target = r.windows.windows.get(wp);
    const cursor =
      hit === 1
        ? target?.cls.cursor
        : ({
            10: 32644,
            11: 32644,
            12: 32645,
            13: 32642,
            14: 32643,
            15: 32645,
            16: 32643,
            17: 32642,
          }[hit] ?? 32512);
    if (cursor) setCursor(r, cursor);
    return result(0, 4);
  }
  if (msg === 0x81) return result(1, 4);
  if (msg === 0x83) {
    if (wp) r.check(lp, 52);
    const rect = [0, 4, 8, 12].map((i) => r.read32(lp + i) | 0);
    const { border, title } = frameForWindow(w);
    rectangle(r, lp, [
      rect[0] + border,
      rect[1] + title + border,
      rect[2] - border,
      rect[3] - border,
    ]);
    return result(0, 4);
  }
  if (msg === 0x47) {
    r.check(lp, 28);
    const flags = r.read32(lp + 24),
      frame = frameForWindow(w);
    if (!(flags & 0x1000))
      await r.windows.send(hwnd, 3, 0, pair(w.x + frame.border, w.y + frame.border + frame.title));
    if (!(flags & 0x800) && r.windows.windows.has(hwnd))
      await r.windows.send(hwnd, 5, 0, pair(w.width, w.height));
    return result(0, 4);
  }
  if (msg === 0x46) {
    r.check(lp, 28);
    if (!(r.read32(lp + 24) & 1) && (w.style & 0x40000 || !(w.style & 0xc0000000))) {
      const info = r.allocate(40),
        frame = frameForWindow(w);
      try {
        [
          0,
          0,
          1024,
          768,
          0,
          0,
          1 + 2 * frame.border,
          1 + 2 * frame.border + frame.title,
          MAX_WINDOW_WIDTH + 2 * frame.border,
          MAX_WINDOW_HEIGHT + 2 * frame.border + frame.title,
        ].forEach((v, i) => r.write32(info + i * 4, v));
        await r.windows.send(hwnd, 0x24, 0, info);
        if (r.windows.windows.has(hwnd))
          for (const [posOffset, minOffset, maxOffset] of [
            [16, 24, 32],
            [20, 28, 36],
          ]) {
            const value = r.read32(lp + posOffset) | 0,
              min = r.read32(info + minOffset) | 0,
              max = r.read32(info + maxOffset) | 0;
            r.write32(lp + posOffset, Math.max(min, Math.min(max, value)));
          }
      } finally {
        r.free(info);
      }
    }
    return result(0, 4);
  }
  if (msg === 0x10) return result(await r.windows.destroy(hwnd), 4);
  if (msg === 0xc) {
    w.title = text(r, lp, wide);
    r.windows.emit(w);
    return result(1, 4);
  }
  if (msg === 0xe) return result(wide ? w.title.length : encodeAnsi(w.title).bytes.length, 4);
  if (msg === 0xd) {
    if (!wp) return result(0, 4);
    if (!wide) {
      const bytes = encodeAnsi(w.title).bytes.subarray(0, wp - 1);
      r.check(lp, bytes.length + 1, true);
      r.data.set(bytes, lp);
      r.guestMemory.write(lp + bytes.length, 0, 1);
      return result(bytes.length, 4);
    }
    const value = w.title.slice(0, wp - 1);
    r.check(lp, (value.length + 1) * 2, true);
    for (let i = 0; i <= value.length; i++)
      r.guestMemory.write(lp + i * 2, i === value.length ? 0 : value.charCodeAt(i), 2);
    return result(value.length, 4);
  }
  if (msg === 0xf) {
    w.invalid = null;
    w.erase = false;
  }
  return result(0, 4);
}
async function beginPaint(r, a) {
  const w = r.windows.windows.get(a(0)),
    p = a(1);
  if (!w) return r.windows.fail(1400, 2);
  r.check(p, 64, true);
  const dc = gdiApis['user32.dll!GetDC'](r, (i) => (i ? 0 : w.id)).result;
  if (!dc) return result(0, 2);
  r.data.fill(0, p, p + 64);
  r.write32(p, dc);
  const invalid = w.invalid ?? [0, 0, 0, 0],
    erase = w.erase;
  w.invalid = null;
  w.erase = false;
  rectangle(r, p + 8, invalid);
  if (erase && w.cls.background) {
    const brush =
      w.cls.background <= 31
        ? gdiApis['user32.dll!GetSysColorBrush'](r, () => w.cls.background - 1).result
        : w.cls.background;
    gdiApis['user32.dll!FillRect'](r, (i) => [dc, p + 8, brush][i]);
  }
  if (erase)
    r.write32(p + 4, (await r.windows.send(w.id, 0x14, dc)) ? 0 : w.cls.background ? 0 : 1);
  return result(dc, 2);
}

export const windowApis = { ...cursorApis, ...windowFindApis, ...windowDataApis };
for (const wide of [false, true]) {
  const suffix = wide ? 'W' : 'A';
  windowApis[`user32.dll!GetWindowText${suffix}`] = async (r, a) =>
    result(await sendWindowMessage(r, a(0), 0xd, a(2), a(1), wide), 3);
  windowApis[`user32.dll!GetWindowTextLength${suffix}`] = async (r, a) =>
    result(await r.windows.send(a(0), 0xe), 1);
  Object.assign(windowApis, {
    [`user32.dll!RegisterClass${suffix}`]: (r, a) => register(r, a, wide, false),
    [`user32.dll!RegisterClassEx${suffix}`]: (r, a) => register(r, a, wide, true),
    [`user32.dll!CreateWindowEx${suffix}`]: (r, a) => create(r, a, wide),
    [`user32.dll!DefWindowProc${suffix}`]: (r, a) => defaultProc(r, a, wide),
    [`user32.dll!GetMessage${suffix}`]: (r, a) => r.windows.message(a, false),
    [`user32.dll!PeekMessage${suffix}`]: (r, a) => r.windows.message(a, true),
    [`user32.dll!DispatchMessage${suffix}`]: async (r, a) => {
      r.check(a(0), 28);
      const p = a(0),
        values = [0, 4, 8, 12].map((i) => r.read32(p + i));
      if (values[1] === 0x113 && values[3])
        return result(
          await r.callGuest(values[3], [values[0], values[1], values[2], r.read32(p + 16)]),
          1,
        );
      return result(values[0] ? await r.windows.send(...values) : 0, 1);
    },
    [`user32.dll!SendMessage${suffix}`]: async (r, a) =>
      result(await sendWindowMessage(r, a(0), a(1), a(2), a(3), wide), 4),
    [`user32.dll!PostMessage${suffix}`]: (r, a) =>
      result(r.windows.post(a(0), a(1), a(2), a(3)) ? 1 : 0, 4),
    [`user32.dll!CallWindowProc${suffix}`]: async (r, a) =>
      result(await r.callGuest(a(0), [a(1), a(2), a(3), a(4)]), 5),
    [`user32.dll!SetWindowText${suffix}`]: async (r, a) =>
      result(await sendWindowMessage(r, a(0), 0xc, 0, a(1), wide), 2),
  });
}
Object.assign(windowApis, {
  'user32.dll!GetCursorPos': (r, a) => {
    const point = a(0);
    if (!point) return result(0, 1);
    r.check(point, 8, true);
    const { x, y } = r.windows.pointerPosition();
    r.write32(point, x | 0);
    r.write32(point + 4, y | 0);
    return result(1, 1);
  },
  'user32.dll!SetCursorPos': (r, a) => {
    r.windows.setPointerPosition(a(0) | 0, a(1) | 0);
    return result(1, 2);
  },
  'user32.dll!ScreenToClient': (r, a) => {
    const window = r.windows.windows.get(a(0));
    if (!window) return r.windows.fail(1400, 2);
    const point = a(1);
    r.check(point, 8, true);
    // clientPosition() already includes the frame offsets.
    const [x, y] = r.windows.clientPosition(window);
    r.write32(point, ((r.read32(point) | 0) - x) | 0);
    r.write32(point + 4, ((r.read32(point + 4) | 0) - y) | 0);
    return result(1, 2);
  },
  'user32.dll!WindowFromPoint': (r, a) => {
    const x = r.read32(a(0)) | 0,
      y = r.read32(a(0) + 4) | 0;
    return result(r.windows.windowFromPoint(x, y), 1);
  },
  'user32.dll!EnableWindow': (r, a) => {
    const window = r.windows.windows.get(a(0));
    if (!window) return r.windows.fail(1400, 2);
    const previous = window.enabled !== false;
    window.enabled = a(1) !== 0;
    return result(previous ? 1 : 0, 2);
  },
  'user32.dll!IsWindowEnabled': (r, a) => {
    const window = r.windows.windows.get(a(0));
    if (!window) return r.windows.fail(1400, 1);
    return result(window.enabled === false ? 0 : 1, 1);
  },
  'user32.dll!MessageBeep': (r, a) => {
    r.emit?.({ type: 'beep', frequency: 800, durationMs: 120 });
    return result(1, 1);
  },
  'user32.dll!SetWindowPos': setWindowPos,
  'user32.dll!AdjustWindowRect': (r, a) => adjustRect(r, a, false),
  'user32.dll!AdjustWindowRectEx': (r, a) => adjustRect(r, a, true),
  'user32.dll!ShowWindow': show,
  'user32.dll!DestroyWindow': async (r, a) => result(await r.windows.destroy(a(0)), 1),
  'user32.dll!IsWindow': (r, a) => result(r.windows.windows.has(a(0)) ? 1 : 0, 1),
  'user32.dll!IsWindowVisible': (r, a) => result(r.windows.isVisible(a(0)) ? 1 : 0, 1),
  'user32.dll!GetParent': (r, a) => result(r.windows.windows.get(a(0))?.parentId ?? 0, 1),
  'user32.dll!GetDlgCtrlID': (r, a) => result(r.windows.windows.get(a(0))?.controlId ?? 0, 1),
  'user32.dll!GetDlgItem': (r, a) =>
    result(
      [...r.windows.windows.values()].find((w) => w.parentId === a(0) && w.controlId === a(1))
        ?.id ?? 0,
      2,
    ),
  'user32.dll!GetClientRect': (r, a) => {
    const w = r.windows.windows.get(a(0));
    if (!w) return r.windows.fail(1400, 2);
    rectangle(r, a(1), [0, 0, w.width, w.height]);
    return result(1, 2);
  },
  'user32.dll!GetWindowRect': (r, a) => {
    const w = r.windows.windows.get(a(0));
    if (!w) return r.windows.fail(1400, 2);
    const [x, y] = r.windows.screenPosition(w),
      { border, title } = frameForWindow(w);
    rectangle(r, a(1), [x, y, x + w.width + 2 * border, y + w.height + title + 2 * border]);
    return result(1, 2);
  },
  'user32.dll!InvalidateRect': (r, a) => {
    const w = r.windows.windows.get(a(0));
    if (!w) return r.windows.fail(1400, 3);
    const rect = a(1) ? [0, 4, 8, 12].map((i) => r.read32(a(1) + i) | 0) : null;
    r.windows.invalidate(w, rect, !!a(2));
    return result(1, 3);
  },
  'user32.dll!UpdateWindow': async (r, a) => {
    const w = r.windows.windows.get(a(0));
    if (!w) return r.windows.fail(1400, 1);
    if (w.invalid) await r.windows.send(w.id, 0xf);
    flushGdi(r);
    return result(1, 1);
  },
  'user32.dll!BeginPaint': beginPaint,
  'user32.dll!EndPaint': (r, a) => {
    r.check(a(1), 64);
    const dc = r.read32(a(1));
    const value = gdiApis['user32.dll!ReleaseDC'](r, (i) => [a(0), dc][i]);
    flushGdi(r);
    return result(value.result, 2);
  },
  'user32.dll!PostQuitMessage': (r, a) => {
    r.windows.post(0, 0x12, a(0));
    return result(0, 1);
  },
  'user32.dll!TranslateMessage': (r, a) => {
    r.check(a(0), 28);
    const message = r.windows.delivered.get(a(0));
    if (message?.character) {
      r.windows.post(
        message.hwnd,
        message.message === 0x104 ? 0x106 : 0x102,
        message.character.charCodeAt(0),
        message.lParam,
      );
      message.character = '';
    }
    const id = r.read32(a(0) + 4);
    return result(id >= 0x100 && id <= 0x109 ? 1 : 0, 1);
  },
  'user32.dll!GetFocus': (r) => result(r.windows.focus),
  'user32.dll!GetForegroundWindow': (r) => result(r.windows.active),
  'user32.dll!GetActiveWindow': (r) => result(r.windows.active),
  'user32.dll!SetFocus': (r, a) => r.windows.setFocus(a(0)),
  'user32.dll!SetCapture': (r, a) => {
    if (!r.windows.windows.has(a(0))) return r.windows.fail(1400, 1);
    const previous = r.windows.capture;
    r.windows.capture = a(0);
    return result(previous, 1);
  },
  'user32.dll!ReleaseCapture': (r) => {
    r.windows.capture = 0;
    return result(1);
  },
  'user32.dll!GetAsyncKeyState': (r, a) => {
    const state = r.windows.keys.get(a(0)) ?? 0;
    r.windows.keys.set(a(0), state & 0x8000);
    return result(state, 1);
  },
  'user32.dll!SetTimer': (r, a) => {
    const m = r.windows;
    if (a(0) && !m.windows.has(a(0))) return m.fail(1400, 4);
    const hwnd = a(0),
      callback = a(3);
    const id = hwnd ? a(1) : m.nextTimer++;
    const key = `${hwnd}:${id}`;
    const previous = m.timers.get(key);
    if (previous) clearInterval(previous.interval);
    else if (m.timers.size >= 64) return m.fail(8, 4);
    const interval = setInterval(
      () => m.post(hwnd, 0x113, id, callback),
      Math.max(10, Math.min(0x7fffffff, a(2))),
    );
    m.timers.set(key, { hwnd, interval });
    return result(id, 4);
  },
  'user32.dll!KillTimer': (r, a) => {
    const key = `${a(0)}:${a(1)}`,
      timer = r.windows.timers.get(key);
    if (!timer) return result(0, 2);
    clearInterval(timer.interval);
    r.windows.timers.delete(key);
    return result(1, 2);
  },
  'user32.dll!GetSystemMetrics': (r, a) => {
    const values = { 4: TITLE, 5: BORDER, 6: BORDER };
    const displayValue = virtualSystemMetric(a(0), r);
    if (displayValue !== undefined) return result(displayValue, 1);
    if (!(a(0) in values)) throw Error(`Unsupported system metric ${a(0)}`);
    return result(values[a(0)], 1);
  },
});

function adjustRect(r, a, extended) {
  if (a(2) || (extended && a(3) & ~0x40008))
    throw Error('Window menus and these extended styles are unsupported');
  r.check(a(0), 16, true);
  const rect = [0, 4, 8, 12].map((i) => r.read32(a(0) + i) | 0);
  const { border, title } = windowFrame(a(1));
  rectangle(r, a(0), [
    rect[0] - border,
    rect[1] - title - border,
    rect[2] + border,
    rect[3] + border,
  ]);
  return result(1, extended ? 4 : 3);
}
