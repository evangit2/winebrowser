import { encodeAnsi } from './encoding.js';
import { sendWindowMessage } from './win32-window-text.js';
import { gdiApis, flushGdi, resizeWindowSurface, destroyWindowSurface } from './win32-gdi.js';

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
    this.nextTimer = 1;
    this.focus = 0;
    this.capture = 0;
  }
  fail(code, argc, value = 0) {
    this.runtime.lastError = code;
    return result(value, argc);
  }
  emit(window, operation = 'update') {
    const { id, title, x, y, width, height, visible } = window;
    this.runtime.emit({
      type: 'window',
      operation,
      window: { id, title, x, y, width, height, visible },
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
    return this.runtime.callGuest(window.proc, [hwnd, message, wParam, lParam]);
  }
  async destroy(hwnd) {
    const window = this.windows.get(hwnd);
    if (!window || window.destroying) return 0;
    window.destroying = true;
    await this.send(hwnd, 2);
    await this.send(hwnd, 0x82);
    for (const [key, timer] of this.timers)
      if (timer.hwnd === hwnd) {
        clearInterval(timer.interval);
        this.timers.delete(key);
      }
    this.queue = this.queue.filter((m) => m.hwnd !== hwnd);
    if (this.focus === hwnd) this.focus = 0;
    if (this.capture === hwnd) this.capture = 0;
    destroyWindowSurface(this.runtime, hwnd);
    this.windows.delete(hwnd);
    this.emit(window, 'destroy');
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
    this.focus = this.capture = 0;
    this.wake?.();
    this.wake = null;
  }
  input(event) {
    const hwnd = this.capture && event.type.startsWith('mouse') ? this.capture : event.windowId;
    const window = this.windows.get(hwnd);
    if (!window || !window.visible) return;
    if (event.type === 'close') this.post(hwnd, 0x10);
    else if (event.type === 'focus') {
      if (this.focus === hwnd) return;
      if (this.focus) this.post(this.focus, 8, hwnd);
      const previous = this.focus;
      this.focus = hwnd;
      this.post(hwnd, 7, previous);
    } else if (event.type === 'move') {
      if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
      window.x = Math.max(-1024, Math.min(4096, Math.round(event.x)));
      window.y = Math.max(0, Math.min(4096, Math.round(event.y)));
      this.post(hwnd, 3, 0, pair(window.x + BORDER, window.y + TITLE + BORDER));
      this.emit(window);
    } else if (event.type === 'resize') {
      if (!Number.isFinite(event.width) || !Number.isFinite(event.height)) return;
      window.width = Math.max(1, Math.min(1024, Math.round(event.width)));
      window.height = Math.max(1, Math.min(768, Math.round(event.height)));
      resizeWindowSurface(this.runtime, hwnd, window.width, window.height);
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
      this.post(hwnd, message, buttons, pair(event.x, event.y), {
        x: window.x + BORDER + event.x,
        y: window.y + TITLE + BORDER + event.y,
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
      if (window.visible && window.invalid && accepts(message)) return message;
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
        await new Promise((resolve) => setTimeout(resolve, 0));
        return result(0, 5);
      }
      await new Promise((resolve) => {
        this.wake = resolve;
      });
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
  const cls =
    classId <= 0xffff ? m.atoms.get(classId) : m.classes.get(text(r, classId, wide).toLowerCase());
  if (!cls) return m.fail(1407, 12);
  if (a(8) || a(9) || a(3) & 0x40000000)
    throw Error('Child/owned windows and menus are not implemented');
  if (a(0) & ~0x40000) throw Error('Unsupported extended window style');
  if (m.windows.size >= 8) return m.fail(8, 12);
  const width = a(6) === 0x80000000 ? 480 : a(6) | 0,
    height = a(7) === 0x80000000 ? 320 : a(7) | 0;
  if (width < 3 || height < TITLE + 3 || width > 1026 || height > 798) return m.fail(87, 12);
  const w = {
    id: m.nextWindow++,
    cls,
    proc: cls.proc,
    title: text(r, a(2), wide),
    x: a(4) === 0x80000000 ? 20 + m.windows.size * 24 : a(4) | 0,
    y: a(5) === 0x80000000 ? 20 + m.windows.size * 24 : a(5) | 0,
    width: width - 2 * BORDER,
    height: height - TITLE - 2 * BORDER,
    visible: false,
    style: a(3),
    exStyle: a(0),
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
    if ((await m.send(w.id, 1, 0, cs)) === 0xffffffff) {
      await m.destroy(w.id);
      return m.fail(1407, 12);
    }
    if (!m.windows.has(w.id)) return result(0, 12);
    m.emit(w, 'create');
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
  if (msg === 0x81) return result(1, 4);
  if (msg === 0x83 && !wp) {
    const rect = [0, 4, 8, 12].map((i) => r.read32(lp + i) | 0);
    rectangle(r, lp, [
      rect[0] + BORDER,
      rect[1] + TITLE + BORDER,
      rect[2] - BORDER,
      rect[3] - BORDER,
    ]);
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

export const windowApis = {};
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
    [`user32.dll!LoadCursor${suffix}`]: (r, a) => {
      if (a(0) || ![32512, 32513, 32514, 32515, 32516].includes(a(1)))
        throw Error('Custom cursors are unsupported');
      return result(a(1), 2);
    },
  });
}
Object.assign(windowApis, {
  'user32.dll!AdjustWindowRect': (r, a) => adjustRect(r, a, false),
  'user32.dll!AdjustWindowRectEx': (r, a) => adjustRect(r, a, true),
  'user32.dll!ShowWindow': show,
  'user32.dll!DestroyWindow': async (r, a) => result(await r.windows.destroy(a(0)), 1),
  'user32.dll!IsWindow': (r, a) => result(r.windows.windows.has(a(0)) ? 1 : 0, 1),
  'user32.dll!IsWindowVisible': (r, a) => result(r.windows.windows.get(a(0))?.visible ? 1 : 0, 1),
  'user32.dll!GetClientRect': (r, a) => {
    const w = r.windows.windows.get(a(0));
    if (!w) return r.windows.fail(1400, 2);
    rectangle(r, a(1), [0, 0, w.width, w.height]);
    return result(1, 2);
  },
  'user32.dll!GetWindowRect': (r, a) => {
    const w = r.windows.windows.get(a(0));
    if (!w) return r.windows.fail(1400, 2);
    rectangle(r, a(1), [w.x, w.y, w.x + w.width + 2 * BORDER, w.y + w.height + TITLE + 2 * BORDER]);
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
  'user32.dll!SetFocus': async (r, a) => {
    const previous = r.windows.focus;
    if (a(0) && !r.windows.windows.has(a(0))) return r.windows.fail(1400, 1);
    r.windows.focus = a(0);
    if (previous) await r.windows.send(previous, 8, a(0));
    if (a(0)) await r.windows.send(a(0), 7, previous);
    return result(previous, 1);
  },
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
    const values = { 0: 1024, 1: 768, 4: TITLE, 5: BORDER, 6: BORDER, 16: 1024, 17: 768 };
    if (!(a(0) in values)) throw Error(`Unsupported system metric ${a(0)}`);
    return result(values[a(0)], 1);
  },
});

function adjustRect(r, a, extended) {
  if (a(2) || (extended && a(3) & ~0x40000))
    throw Error('Window menus and these extended styles are unsupported');
  r.check(a(0), 16, true);
  const rect = [0, 4, 8, 12].map((i) => r.read32(a(0) + i) | 0);
  rectangle(r, a(0), [
    rect[0] - BORDER,
    rect[1] - TITLE - BORDER,
    rect[2] + BORDER,
    rect[3] + BORDER,
  ]);
  return result(1, extended ? 4 : 3);
}
