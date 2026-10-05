import { dialogX, dialogY } from './dialog-units.js';
import { receiveDroppedFiles } from './win32-drop-files.js';
import { paintOwnerCombo, writeComboInfo } from './win32-combos.js';
import { paintOwnerList } from './win32-owner-lists.js';
import { describeList } from './win32-lists.js';
import { describeTree } from './win32-treeview.js';
import { describeTabs } from './win32-tabs.js';
import { describeStatusbar } from './win32-statusbar.js';
import { describeToolbar } from './win32-toolbar.js';
import { describeProgress } from './win32-progress.js';
import { describeListview } from './win32-listview.js';
import { legacyUiApis } from './win32-legacy-ui.js';
import { resolveGuestPath } from './guest-paths.js';
import {
  builtinControlClass,
  controlStyle,
  controlMessage,
  controlInput,
  EDIT_INPUT,
} from './win32-controls.js';
import { encodeAnsi } from './encoding.js';
import { sendWindowMessage } from './win32-window-text.js';
import {
  gdiApis,
  describeGdiFont,
  describeGdiBrush,
  activeGdiDC,
  acquireControlColorDC,
  flushGdi,
  resizeWindowSurface,
  destroyWindowSurface,
  clearControlDrawing,
  hasControlDrawing,
  releaseControlColorSurface,
} from './win32-gdi.js';
import {
  describeWindowMenu,
  MENU_BAR_HEIGHT,
  loadClassMenu,
  menuCommandAllowed,
} from './win32-menus.js';
import { virtualSystemMetric } from './win32-display.js';
import { iconForHandle } from './win32-icons.js';
import { staticBitmapMessage } from './win32-static-bitmaps.js';
import { cursorApis, setCursor } from './win32-cursors.js';
import { windowFindApis } from './win32-window-find.js';
import {
  windowFrame,
  frameForWindow,
  outerWindowSize,
  effectiveControlBorder,
  MAX_WINDOW_WIDTH,
  MAX_WINDOW_HEIGHT,
} from './window-frame.js';
import { windowDataApis } from './win32-window-data.js';
import { setWindowPos } from './win32-window-position.js';
import { currentDisplayMode } from './win32-display.js';
import { inputState } from './dinput-device.js';
import { registerThunk } from './thunk-addresses.js';

const BORDER = 1,
  TITLE = 28;
const result = (value = 0, argc = 0) => ({ result: value >>> 0, argc });
// Property names are guest strings keyed per window. Message registration is
// process-global and returns a stable id for the application's lifetime.
function propName(runtime, pointer, wide) {
  return wide ? runtime.wideString(pointer) : runtime.string(pointer);
}
function getProp(runtime, hwnd, name, wide) {
  if (!runtime.windows.windows.has(hwnd) || !name) return 0;
  return runtime.windows.props(hwnd).get(propName(runtime, name, wide)) ?? 0;
}
function setProp(runtime, hwnd, name, value, wide) {
  if (!runtime.windows.windows.has(hwnd) || !name) return 0;
  runtime.windows.props(hwnd).set(propName(runtime, name, wide), value >>> 0);
  return 1;
}
function removeProp(runtime, hwnd, name, wide) {
  if (!runtime.windows.windows.has(hwnd) || !name) return 0;
  const props = runtime.windows.props(hwnd),
    key = propName(runtime, name, wide),
    previous = props.get(key) ?? 0;
  props.delete(key);
  return previous;
}
function registerWindowMessage(runtime, name, wide = false) {
  if (!name) return 0;
  return runtime.windows.registerWindowMessage(propName(runtime, name, wide));
}
const pair = (x, y) => ((x & 0xffff) | ((y & 0xffff) << 16)) >>> 0;
const text = (r, p, wide) => (wide ? r.wideString(p) : r.string(p));

// One guest GUI thread. Browser events only enqueue messages; guest callbacks
// execute on the existing CPU dispatch stack, never reentrantly from onmessage.
// ---------------------------------------------------------------------------
// Rectangle geometry and simple window movement. These are pure helpers that
// dialog and control code calls constantly; they read and write the 16-byte
// RECT layout (left, top, right, bottom).
function readRect(r, pointer) {
  if (!pointer) return null;
  r.check(pointer, 16);
  return [0, 4, 8, 12].map((offset) => r.read32(pointer + offset) | 0);
}
function equalRect(r, a) {
  const first = readRect(r, a(0)),
    second = readRect(r, a(1));
  return result(first && second && first.every((v, i) => v === second[i]) ? 1 : 0, 2);
}
function ptInRect(r, a) {
  const rect = readRect(r, a(0));
  if (!rect) return result(0, 3);
  // POINT is two signed LONGs passed by value on PE32, after the RECT pointer.
  const x = a(1) | 0,
    y = a(2) | 0;
  const [left, top, right, bottom] = rect;
  return result(x >= left && x < right && y >= top && y < bottom ? 1 : 0, 3);
}
// InflateRect/OffsetRect/SetRect all report BOOL and write through lprc.
function inflateRect(r, a) {
  if (!a(0)) return result(0, 3);
  const rect = readRect(r, a(0));
  const dx = a(1) | 0,
    dy = a(2) | 0;
  rectangle(r, a(0), [rect[0] - dx, rect[1] - dy, rect[2] + dx, rect[3] + dy]);
  return result(1, 3);
}
function offsetRect(r, a) {
  if (!a(0)) return result(0, 3);
  const rect = readRect(r, a(0));
  const dx = a(1) | 0,
    dy = a(2) | 0;
  rectangle(r, a(0), [rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy]);
  return result(1, 3);
}
function setRect(r, a) {
  if (!a(0)) return result(0, 5);
  rectangle(r, a(0), [a(1) | 0, a(2) | 0, a(3) | 0, a(4) | 0]);
  return result(1, 5);
}
// MapWindowPoints(hwndFrom, hwndTo, points, count) re-expresses POINTs between
// two windows' client spaces, or between a client space and the screen when a
// handle is zero/NULL. It returns the packed (x, y) deltas in the high/low
// words, which is what callers that use the return value expect.
function mapWindowPoints(r, a) {
  const from = a(0) >>> 0,
    to = a(1) >>> 0;
  const pointer = a(2),
    count = a(3) >>> 0;
  if (!count || !pointer) return result(0, 4);
  if (count > 1024) return r.windows.fail(122, 4);
  r.check(pointer, count * 8);
  const originOf = (id) => {
    if (!id || id === DESKTOP_WINDOW) return [0, 0];
    const w = r.windows.windows.get(id);
    if (!w) return null;
    return r.windows.clientPosition(w);
  };
  const fromOrigin = originOf(from);
  const toOrigin = originOf(to);
  if (!fromOrigin || !toOrigin) return r.windows.fail(1400, 4);
  const dx = fromOrigin[0] - toOrigin[0];
  const dy = fromOrigin[1] - toOrigin[1];
  for (let i = 0; i < count; i++) {
    const at = pointer + i * 8;
    r.write32(at, (r.read32(at) | 0) + dx);
    r.write32(at + 4, (r.read32(at + 4) | 0) + dy);
  }
  return result(((dy & 0xffff) << 16) | (dx & 0xffff), 4);
}
// MoveWindow(hwnd, X, Y, Width, Height, Repaint) repositions and resizes in one
// call. The runtime's window model applies both and reports success.
async function moveWindow(r, a) {
  const window = r.windows.windows.get(a(0));
  if (!window) return r.windows.fail(1400, 6);
  // MoveWindow passes a rectangle in *window* coordinates (the same units
  // SetWindowPos takes), so it routes through the shared positioning path that
  // already validates the frame and clamps the size.
  const moved = await setWindowPos(
    r,
    (i) => [a(0), 0, a(1), a(2), a(3), a(4), 0x4 | (a(5) ? 0 : 0x100)][i] ?? 0,
  );
  return result(moved.result ? 1 : 0, 6);
}
// DrawEdge paints into the caller's HDC, including compatible memory DCs.
// Save/restore its selected objects and position; temporary pens never escape.
function drawEdge(r, a) {
  const dc = a(0),
    rect = readRect(r, a(1));
  const edge = a(2) >>> 0,
    flags = a(3) >>> 0;
  if (!rect || edge & ~15 || flags & ~0xe80f || flags & 0x10) return result(0, 4);
  const call = (name, args) => gdiApis[name](r, (i) => args[i]).result;
  const saved = call('gdi32.dll!SaveDC', [dc]);
  if (!saved) return result(0, 4);
  const pens = new Map();
  let [left, top, right, bottom] = rect;
  const pen = (color) => {
    if (!pens.has(color)) pens.set(color, call('gdi32.dll!CreatePen', [0, 1, color]));
    return pens.get(color);
  };
  const line = (x1, y1, x2, y2, color) => {
    const handle = pen(color);
    if (!handle) return;
    call('gdi32.dll!SelectObject', [dc, handle]);
    call('gdi32.dll!MoveToEx', [dc, x1, y1, 0]);
    call('gdi32.dll!LineTo', [dc, x2, y2]);
  };
  try {
    if ((edge & 3) === 3 || (edge & 12) === 12) return result(0, 4);
    for (const [bits, raised, sunken] of [
      [edge & 3, [0xc0c0c0, 0x000000], [0x808080, 0xffffff]],
      [edge & 12, [0xffffff, 0x808080], [0x000000, 0xc0c0c0]],
    ]) {
      if (!bits || left >= right || top >= bottom) continue;
      const colors = bits & 5 ? raised : sunken;
      const [light, dark] =
        flags & 0x8000 ? [0, 0] : flags & 0x4000 ? [0x808080, 0x808080] : colors;
      if (flags & 2) line(left, top, right, top, light);
      if (flags & 1) line(left, top, left, bottom, light);
      if (flags & 8) line(left, bottom - 1, right, bottom - 1, dark);
      if (flags & 4) line(right - 1, top, right - 1, bottom, dark);
      if (flags & 1) left++;
      if (flags & 2) top++;
      if (flags & 4) right--;
      if (flags & 8) bottom--;
    }
    if (flags & 0x800) {
      const inner = r.allocate(16);
      try {
        rectangle(r, inner, [left, top, right, bottom]);
        call('user32.dll!FillRect', [dc, inner, 16]);
      } finally {
        r.free(inner);
      }
    }
    if (flags & 0x2000) rectangle(r, a(1), [left, top, right, bottom]);
    return result(1, 4);
  } finally {
    call('gdi32.dll!RestoreDC', [dc, saved]);
    for (const handle of pens.values()) if (handle) call('gdi32.dll!DeleteObject', [handle]);
  }
}

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
    this.applicationActivation(!!value && !this.appBlurred);
  }
  applicationActivation(active) {
    if (this.appActive === active) return;
    this.appActive = active;
    // WM_ACTIVATEAPP belongs to the application, not an individual child or
    // a switch between two of its top-level windows. Browser events queue it
    // for the guest message loop so no guest callback runs on a host input stack.
    for (const window of this.windows.values())
      if (!window.parentId && !window.destroying) this.post(window.id, 0x1c, Number(active), 0);
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
      ownerDraw,
      enabled,
      font,
      readOnly,
      textLimit,
      textAlign,
      noPrefix,
      buttonType,
      flat,
      leftText,
      horizontalAlign,
      verticalAlign,
      pushLike,
      multilineCaption,
      notify,
      icon: buttonIcon,
      bitmap: buttonBitmap,
      toggle,
      triState,
      automatic,
      groupBox,
      checkState,
      multiline,
      password,
      uppercase,
      lowercase,
      number,
      autoVScroll,
      autoHScroll,
      wantReturn,
      verticalScroll,
      horizontalScroll,
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
        width: parentId ? outerWindowSize(window)[0] : width,
        height: parentId ? outerWindowSize(window)[1] : height,
        visible,
        minimized: [2, 6, 7, 11].includes(window.showCmd),
        parentId,
        controlType,
        comboHostId: window.comboHostId,
        comboPopup: !!window.comboHostId && this.windows.get(window.comboHostId)?.comboType !== 1,
        controlBorder: border,
        enabled,
        acceptFiles: !!(window.exStyle & 0x10),
        controlStyle: controlType
          ? {
              ownerDraw: !!ownerDraw,
              nativeCombo: controlType === 'combobox',
              noWordWrap: !!window.noWordWrap,
              subclassed: this.isControlSubclass(window),
              centerImage: !!window.centerImage,
              readOnly: !!readOnly,
              buttonType,
              flat: !!flat,
              leftText: !!leftText,
              horizontalAlign,
              verticalAlign,
              pushLike: !!pushLike,
              multilineCaption: !!multilineCaption,
              notify: !!notify,
              icon: !!buttonIcon,
              bitmap: !!buttonBitmap,
              toggle: !!toggle,
              triState: !!triState,
              automatic: !!automatic,
              groupBox: !!groupBox,
              checkState: checkState ?? 0,
              textAlign,
              noPrefix: !!noPrefix,
              multiline: !!multiline,
              password: !!password,
              uppercase: !!uppercase,
              lowercase: !!lowercase,
              number: !!number,
              autoVScroll: !!autoVScroll,
              autoHScroll: !!autoHScroll,
              wantReturn: !!wantReturn,
              verticalScroll: !!verticalScroll,
              horizontalScroll: !!horizontalScroll,
            }
          : undefined,
        topmost: !!window.topmost,
        zOrder: window.zOrder,
        frame: parentId ? undefined : frameForWindow(window),
        font,
        controlColors: window.controlColors,
        readOnly,
        textLimit,
        selection:
          controlType === 'edit' && window.selectionStart !== undefined
            ? { start: window.selectionStart, end: window.selectionEnd }
            : undefined,
        textAlign,
        noPrefix,
        icon:
          parentId || !window.cls?.icon ? undefined : iconForHandle(this.runtime, window.cls.icon),
        // A top-level window's menu bar, rendered by the desktop. Null when the
        // window has no menu, so the frame stays as it was.
        menu: parentId ? undefined : describeWindowMenu(this.runtime, window),
        isDialog: !parentId && !!window.dialogProc,
        controlId: window.controlId,
        tree: describeTree(window),
        tabs: describeTabs(window),
        statusbar: describeStatusbar(window),
        toolbar: describeToolbar(window),
        progress: describeProgress(window),
        report: describeListview(window),
        list: describeList(window),
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
  controlProcedure(window) {
    const kind = window.controlType,
      wide = !!window.cls.wide;
    this.controlProcedures ??= new Map();
    this.controlProcedureEntries ??= new Map();
    const key = `${kind}:${wide}`;
    let pointer = this.controlProcedures.get(key);
    if (!pointer) {
      const entry = {
        kind: 'window-proc',
        name: `WineBrowser ${kind} WndProc${wide ? 'W' : 'A'}`,
        controlType: kind,
        wide,
        invoke: async (r, a) => {
          const target = r.windows.windows.get(a(0));
          if (!target) return r.windows.fail(1400, 4);
          if (target.controlType !== kind || !!target.cls.wide !== wide)
            return r.windows.fail(87, 4);
          return result(await r.windows.baseControlMessage(target, a(1), a(2), a(3), wide), 4);
        },
      };
      pointer = registerThunk(this.runtime.thunks, entry);
      this.controlProcedures.set(key, pointer);
      // Class procedures live for the GUI process, independently of a DLL-load
      // transaction that happens to discover their addresses.
      this.controlProcedureEntries.set(pointer, entry);
    }
    return pointer;
  }
  async baseControlMessage(window, message, wParam, lParam, textWide) {
    const bitmapResult = await staticBitmapMessage(
      this.runtime,
      window,
      message,
      wParam,
      lParam,
      textWide,
    );
    if (bitmapResult !== null) return bitmapResult;
    if (window.ownerDraw && message === 0xf)
      return window.controlType === 'combobox'
        ? paintOwnerCombo(this.runtime, window)
        : window.controlType === 'listbox'
          ? paintOwnerList(this.runtime, window)
          : paintOwnerDraw(this.runtime, window);
    if (message === 0xf && window.controlType !== 'custom')
      clearControlDrawing(this.runtime, window.id, window.invalid);
    if (message === 0xf && colorControl(window)) return paintControlColors(this.runtime, window);
    if (message === 0xf && hasControlDrawing(this.runtime, window.id)) {
      window.invalid = null;
      window.erase = false;
    }
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
            (i) => [window.id, message, wParam, lParam][i],
            window.cls.wide,
          )
        ).result,
      textWide ?? !!window.cls.wide,
    );
  }
  async drawOwnerControl(window, action) {
    if (!this.windows.has(window.id)) return 0;
    return paintOwnerDraw(this.runtime, window, action);
  }
  isControlSubclass(window) {
    return !!(
      window.controlType &&
      window.controlType !== 'custom' &&
      window.proc &&
      window.proc !== this.controlProcedure(window)
    );
  }
  async send(hwnd, message, wParam = 0, lParam = 0, textWide) {
    const window = this.windows.get(hwnd);
    if (!window) {
      this.runtime.lastError = 1400;
      return 0;
    }
    if (message === 0xa) invalidateControlColors(this, hwnd);
    if (message === EDIT_INPUT && window.pendingTextEvents?.has(wParam)) {
      const value = window.pendingTextEvents.get(wParam);
      window.pendingTextEvents.delete(wParam);
      const incoming = typeof value === 'string' ? value : value.text;
      const bytes = window.cls.wide ? null : encodeAnsi(incoming).bytes;
      const text = bytes
        ? this.runtime.allocate(bytes.length + 1)
        : this.runtime.allocString(incoming, true);
      if (bytes) this.runtime.data.set(bytes, text);
      if (typeof value === 'object')
        window.browserSelection = {
          start: Math.max(0, value.start ?? incoming.length),
          end: Math.max(0, value.end ?? incoming.length),
        };
      try {
        return await this.send(hwnd, 0xc, 0, text);
      } finally {
        delete window.browserSelection;
        this.runtime.free(text);
        if (this.windows.has(hwnd)) this.emit(window);
      }
    }
    if (window.browseFolder) {
      const folder = window.browseFolder;
      if (message === 0x465) {
        folder.enabled = !!lParam;
        return 0;
      }
      if (message === 0x466 || message === 0x467) {
        if (wParam) {
          const input =
            message === 0x467 ? this.runtime.wideString(lParam) : this.runtime.string(lParam);
          try {
            const path = resolveGuestPath(input, this.runtime.cwd, { allowRoot: true });
            if (folder.choices.includes(path)) folder.selection = path;
          } catch {}
        }
        return 0;
      }
    }
    if (window.controlType && window.controlType !== 'custom') {
      if (this.isControlSubclass(window))
        return this.runtime.callGuest(window.proc, [hwnd, message, wParam, lParam]);
      return this.baseControlMessage(window, message, wParam, lParam, textWide);
    }
    if (window.dialogProc) {
      if (window.customDialogClass && window.proc)
        return this.runtime.callGuest(window.proc, [hwnd, message, wParam, lParam]);
      return dispatchDialogMessage(this.runtime, window, message, wParam, lParam, window.cls.wide);
    } else if (window.proc)
      return this.runtime.callGuest(window.proc, [hwnd, message, wParam, lParam]);
    return (
      await defaultProc(this.runtime, (i) => [hwnd, message, wParam, lParam][i], window.cls.wide)
    ).result;
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
    if (window.dialogResourceFont)
      gdiApis['gdi32.dll!DeleteObject'](this.runtime, () => window.dialogResourceFont);
    this.windows.delete(hwnd);
    if (window.ownerId && window.visible) invalidateControlColors(this, window.ownerId);
    this.runtime.dialogs?.byWindow.delete(hwnd);
    this.wake?.();
    this.wake = null;
    if (window.presented) this.emit(window, 'destroy');
    return 1;
  }
  dispose() {
    for (const timer of this.timers.values()) clearInterval(timer.interval);
    this.timers.clear();
    for (const window of this.windows.values()) {
      destroyWindowSurface(this.runtime, window.id);
      if (window.dialogResourceFont)
        gdiApis['gdi32.dll!DeleteObject'](this.runtime, () => window.dialogResourceFont);
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
  async changeCapture(hwnd) {
    const previous = this.capture;
    this.capture = hwnd;
    if (previous && previous !== hwnd && this.windows.has(previous))
      await this.send(previous, 0x215, 0, hwnd);
    return previous;
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
    if (this.cursorClip) {
      const [left, top, right, bottom] = this.cursorClip;
      x = Math.max(left, Math.min(Math.max(left, right - 1), x));
      y = Math.max(top, Math.min(Math.max(top, bottom - 1), y));
    }
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
      .filter(
        (w) =>
          this.isVisible(w.id) &&
          ![2, 6, 7, 11].includes(this.windows.get(this.topLevel(w.id))?.showCmd) &&
          inside(w),
      )
      .sort((a, b) => (b.parentId ? 1 : 0) - (a.parentId ? 1 : 0));
    return candidates[0]?.id ?? 0;
  }
  // Process-global RegisterWindowMessage table. Ids start at 0xC000, above the
  // fixed WM_* range, and stay stable for the lifetime of the process.
  registerWindowMessage(name) {
    this.registeredMessages ??= new Map();
    if (this.registeredMessages.has(name)) return this.registeredMessages.get(name);
    if (this.registeredMessages.size >= 0x3fff) throw Error('Window message table full');
    const id = 0xc000 + this.registeredMessages.size;
    this.registeredMessages.set(name, id);
    return id;
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
      this.appBlurred = true;
      this.applicationActivation(false);
      directInput.blur();
      this.keys.clear();
      this.keyboardState.clear();
      return;
    }
    if (event.type === 'app-focus') {
      this.appBlurred = false;
      this.applicationActivation(!!this.active);
      directInput.focused = true;
      return;
    }
    const pointerEvent = ['mousemove', 'mousedown', 'mouseup', 'dblclick', 'wheel'].includes(
      event.type,
    );
    const hwnd =
      this.capture && pointerEvent && event.type !== 'wheel' ? this.capture : event.windowId;
    const window = this.windows.get(hwnd);
    if (!window || !this.isVisible(hwnd) || !this.isEnabled(hwnd)) return;
    if (event.type === 'drop-files') {
      receiveDroppedFiles(this.runtime, window, event);
      return;
    }
    // Remember the pointer in virtual-screen coordinates before any handler
    // may consume the event. GetCursorPos and ScreenToClient report this.
    if (pointerEvent) {
      if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
      if (hwnd !== event.windowId) {
        const source = this.windows.get(event.windowId);
        if (!source) return;
        const sourceOrigin = this.clientPosition(source),
          targetOrigin = this.clientPosition(window);
        event = {
          ...event,
          x: event.x + sourceOrigin[0] - targetOrigin[0],
          y: event.y + sourceOrigin[1] - targetOrigin[1],
        };
      }
      const [originX, originY] = this.clientPosition(window);
      this.setPointerPosition((originX + event.x) | 0, (originY + event.y) | 0);
      if (this.cursorClip)
        event = { ...event, x: this.pointer.x - originX, y: this.pointer.y - originY };
    }
    if (directInput.input(event, window)) return;
    if (controlInput(this.runtime, window, event)) return;
    if (event.type === 'menu-command') {
      if (menuCommandAllowed(this.runtime, window, event.command >>> 0))
        this.post(hwnd, 0x111, event.command >>> 0, 0);
    } else if (event.type === 'menu-open') {
      this.post(hwnd, 0x211, 0);
      this.post(hwnd, 0x116, window.menu);
    } else if (event.type === 'menu-close') this.post(hwnd, 0x212, 0);
    else if (event.type === 'close') this.post(hwnd, 0x10);
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
    } else if (pointerEvent) {
      if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return;
      const down = event.type === 'mousedown' || event.type === 'dblclick',
        double = event.type === 'dblclick' && !!(window.cls.style & 8);
      const message =
        event.type === 'wheel'
          ? 0x20a
          : double
            ? event.button === 2
              ? 0x206
              : event.button === 1
                ? 0x209
                : 0x203
            : event.type === 'mousemove'
              ? 0x200
              : event.button === 2
                ? down
                  ? 0x204
                  : 0x205
                : event.button === 1
                  ? down
                    ? 0x207
                    : 0x208
                  : down
                    ? 0x201
                    : 0x202;
      const buttons =
        (event.buttons & 1 ? 1 : 0) |
        (event.buttons & 2 ? 2 : 0) |
        (event.buttons & 4 ? 16 : 0) |
        (event.shiftKey ? 4 : 0) |
        (event.ctrlKey ? 8 : 0);
      const [screenX, screenY] = this.clientPosition(window);
      if (event.type === 'wheel' && !Number.isFinite(event.wheelDelta)) return;
      this.post(
        hwnd,
        message,
        event.type === 'wheel' ? pair(buttons, event.wheelDelta) : buttons,
        event.type === 'wheel'
          ? pair(screenX + event.x, screenY + event.y)
          : pair(event.x, event.y),
        {
          hardwareMouse: true,
          cursorSent: false,
          x: screenX + event.x,
          y: screenY + event.y,
        },
      );
    }
  }
  next(hwnd, min, max, remove) {
    const accepts = (m) =>
      m.message === 0x12 ||
      ((!hwnd || (hwnd === 0xffffffff ? !m.hwnd : m.hwnd === hwnd)) &&
        ((!min && !max) || (m.message >= min && m.message <= max)));
    let index = this.queue.findIndex(accepts);
    if (index >= 0) {
      const message = remove ? this.queue.splice(index, 1)[0] : this.queue[index];
      // Modal dialogs consume this queue directly. GetKeyState must describe
      // the removed message in both modal and public Get/PeekMessage loops.
      if (remove && [0x100, 0x101, 0x104, 0x105].includes(message.message)) {
        const down = !(message.message & 1),
          vk = message.wParam,
          previous = this.keyboardState.get(vk) ?? 0,
          toggle = [20, 144, 145].includes(vk) && down && !(previous & 0x8000);
        this.keyboardState.set(vk, (down ? 0x8000 : 0) | ((previous ^ (toggle ? 1 : 0)) & 1));
        if (message.modifiers)
          for (const [key, code] of [
            ['shiftKey', 16],
            ['ctrlKey', 17],
            ['altKey', 18],
          ])
            this.keyboardState.set(code, message.modifiers[key] ? 0x8000 : 0);
      }
      return message;
    }
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
      if (
        this.isVisible(window.id) &&
        (!window.controlType ||
          window.controlType === 'custom' ||
          window.ownerDraw ||
          colorControl(window) ||
          hasControlDrawing(this.runtime, window.id)) &&
        (window.invalid || window.internalPaint) &&
        accepts(message)
      ) {
        if (remove) window.internalPaint = false;
        return message;
      }
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
  const namePointer = r.read32(p + 36);
  if (!namePointer) return manager.fail(87, 1);
  const originalName = text(r, namePointer, wide);
  const name = originalName.toLowerCase();
  const extra = r.read32(p + 12);
  const classExtra = r.read32(p + 8);
  // ERROR_CLASS_ALREADY_EXISTS is only correct when the same name is already
  // registered; an empty or misread name is a different failure entirely.
  if (!name) return manager.fail(87, 1);
  if (manager.classes.has(name)) return manager.fail(1410, 1);
  // cbClsExtra and cbWndExtra are small per-class/per-window blocks the guest
  // addresses with Get/SetWindowLong; a class menu name selects the menu every
  // window of this class gets. All three are ordinary parts of WNDCLASS.
  if (classExtra > 4096 || extra > 4096) throw Error('Window class extra data limit exceeded');
  if (manager.classes.size >= 128) return manager.fail(8, 1);
  const menuName = r.read32(p + 32);
  const cls = {
    name,
    originalName,
    atom: manager.nextAtom++,
    style: r.read32(p),
    proc: r.read32(p + 4),
    classExtra,
    extra,
    instance: r.read32(p + 16),
    icon: r.read32(p + 20),
    smallIcon: extended ? r.read32(p + 40) : 0,
    cursor: r.read32(p + 24),
    background: r.read32(p + 28),
    menuNamePointer: menuName,
    menuName: menuName ? (menuName <= 0xffff ? menuName : text(r, menuName, wide)) : 0,
    wide,
  };
  manager.classes.set(name, cls);
  manager.atoms.set(cls.atom, cls);
  return result(cls.atom, 1);
}

function resolveControlClass(m, name, wide) {
  m.builtinClasses ??= new Map();
  const key = `${name}:${wide}`,
    cached = m.builtinClasses.get(key);
  if (cached) return cached;
  const cls = builtinControlClass(name, wide);
  if (cls) m.builtinClasses.set(key, cls);
  return cls;
}
function classInfo(r, a, wide, remove = false) {
  const m = r.windows,
    p = a(remove ? 0 : 1),
    instance = a(remove ? 1 : 0);
  const name = p <= 0xffff ? null : text(r, p, wide).toLowerCase();
  const cls =
    p <= 0xffff
      ? m.atoms.get(p)
      : (m.classes.get(name) ?? (!remove ? resolveControlClass(m, name, wide) : null));
  if (!cls || (!cls.controlType && cls.instance !== instance && !(cls.style & 0x4000)))
    return m.fail(1411, remove ? 2 : 3);
  if (remove) {
    if ([...m.windows.values()].some((w) => w.cls === cls)) return m.fail(1412, 2);
    for (const address of [
      ...(cls.menuPointers?.values() ?? []),
      ...(cls.namePointers?.values() ?? []),
    ])
      r.free(address);
    m.classes.delete(cls.name);
    m.atoms.delete(cls.atom);
    return result(1, 2);
  }
  const out = a(2);
  if (!out) return m.fail(87, 3);
  r.check(out, 40, true);
  const ownedString = (value) => {
    if (wide) return r.allocString(value, true);
    const { bytes } = encodeAnsi(value),
      address = r.allocate(bytes.length + 1, true);
    r.data.set(bytes, address);
    return address;
  };
  cls.namePointers ??= new Map();
  if (!cls.namePointers.has(wide))
    cls.namePointers.set(wide, ownedString(cls.originalName ?? cls.name));
  let menu = cls.menuName;
  if (typeof menu === 'string') {
    cls.menuPointers ??= new Map();
    if (!cls.menuPointers.has(wide)) {
      const address = ownedString(menu);
      cls.menuPointers.set(wide, address);
    }
    menu = cls.menuPointers.get(wide);
  }
  [
    cls.style,
    cls.controlType ? m.controlProcedure({ controlType: cls.controlType, cls }) : cls.proc,
    cls.classExtra,
    cls.extra,
    cls.instance,
    cls.icon,
    cls.cursor,
    cls.background,
    menu,
    cls.namePointers.get(wide),
  ].forEach((v, i) => r.write32(out + i * 4, v || 0));
  return result(1, 3);
}

async function create(r, a, wide) {
  const m = r.windows,
    classId = a(1);
  const name = classId <= 0xffff ? null : text(r, classId, wide).toLowerCase();
  const cls =
    classId <= 0xffff
      ? m.atoms.get(classId)
      : (m.classes.get(name) ??
        resolveControlClass(m, name, wide) ??
        builtinWindowClass(name, wide));
  if (!cls) return m.fail(1407, 12);
  const child = !!(a(3) & 0x40000000),
    parentId = child ? a(8) : 0;
  if (child && !m.windows.has(parentId)) return m.fail(1400, 12);
  // A non-child window's hWndParent argument is its owner: the window is
  // top-level but stays above its owner. The menu argument (or the class's
  // menu name) selects the window's menu bar.
  const ownerId = child ? 0 : a(8) >>> 0;
  if (ownerId && !m.windows.has(ownerId)) return m.fail(1400, 12);
  if (cls.controlType && !child) throw Error('Standard controls require a parent window');
  const controlType = cls.controlType ?? (child ? 'custom' : undefined);
  const control = child ? controlStyle(controlType, a(3), a(0)) : {};
  if (!child && a(0) & ~0x40218)
    throw Error('Unsupported extended window style 0x' + (a(0) >>> 0).toString(16));
  const count = [...m.windows.values()].filter((w) => !!w.parentId === child).length;
  if (count >= (child ? 256 : 8)) return m.fail(8, 12);
  const width = a(6) === 0x80000000 ? 480 : a(6) | 0,
    requestedHeight = a(7) === 0x80000000 ? 320 : a(7) | 0,
    height =
      cls.controlType === 'combobox' && control.comboType !== 1
        ? Math.min(requestedHeight, 24)
        : requestedHeight;
  if (child) {
    control.nominalControlBorder = control.controlBorder;
    control.controlBorder = effectiveControlBorder(control.controlBorder, width, height);
  }
  const menu = child
    ? 0
    : a(9) || (cls.menuName ? loadClassMenu(r, a(10) || cls.instance, cls.menuName, wide) : 0);
  const frame = windowFrame(a(3), !!menu, a(0)),
    border = child ? control.controlBorder : frame.border,
    titleHeight = child ? 0 : frame.title;
  if (
    (child ? width < 0 : width < 2 * border) ||
    (child ? height < 0 : height < titleHeight + 2 * border) ||
    width - 2 * border > MAX_WINDOW_WIDTH ||
    height - titleHeight - 2 * border > MAX_WINDOW_HEIGHT
  )
    return m.fail(87, 12);
  const w = {
    id: m.runtime.processSession ? m.runtime.processSession.nextWindow++ : m.nextWindow++,
    // New child controls go behind siblings; top-level windows go in front.
    zOrder: (child ? -1 : 1) * m.nextZOrder++,
    cls,
    proc: cls.proc,
    title: text(r, a(2), wide),
    x: a(4) === 0x80000000 ? 20 + m.windows.size * 24 : a(4) | 0,
    y: a(5) === 0x80000000 ? 20 + m.windows.size * 24 : a(5) | 0,
    width: Math.max(0, width - 2 * border),
    height: Math.max(0, height - titleHeight - 2 * border),
    parentId,
    controlType,
    comboRequestedHeight: controlType === 'combobox' ? requestedHeight : undefined,
    comboHostId:
      cls.comboList && m.windows.get(parentId)?.controlType === 'combobox' ? parentId : undefined,
    comboEditHostId:
      controlType === 'edit' && m.windows.get(parentId)?.controlType === 'combobox'
        ? parentId
        : undefined,
    list:
      cls.comboList && m.windows.get(parentId)?.controlType === 'combobox'
        ? m.windows.get(parentId).list
        : undefined,
    fontHandle: cls.comboList ? m.windows.get(parentId)?.fontHandle : 0,
    // EDIT attributes the browser input path needs to filter typed text.
    multiline: !!control.multiline,
    uppercase: !!control.uppercase,
    lowercase: !!control.lowercase,
    number: !!control.number,
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
    // cbClsExtra storage is shared by every window of the class, so it lives
    // on the class object; a window's own extra bytes stay private.
    classExtra: new DataView(new ArrayBuffer(cls.classExtra ?? 0)),
    // A class menu name (or the CreateWindow menu argument) selects the window's
    // menu. The runtime resolves it lazily when the menu module loads it.
    ownerId,
    menu,
    classMenuName: cls.menuName ?? 0,
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
      throw Error(
        `Custom nonclient window geometry is unsupported: the class produced ` +
          `${clientWidth}x${clientHeight} but the runtime computed ${w.width}x${w.height} ` +
          `(style 0x${w.style.toString(16)}, exStyle 0x${w.exStyle.toString(16)})`,
      );
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
  if (![0, 1, 2, 3, 5, 6, 7, 8, 9, 10, 11].includes(a(1)))
    throw Error('Unsupported ShowWindow command ' + a(1));
  let command = a(1);
  const wasMinimized = [2, 6, 7, 11].includes(w.showCmd);
  if (command === 9 && wasMinimized) command = w.minimizedFrom ?? 1;
  const previous = w.visible;
  if ([2, 6, 7, 11].includes(command)) {
    if (!wasMinimized) w.minimizedFrom = w.showCmd === 3 ? 3 : 1;
    w.showCmd = command;
    w.style = (w.style | 0x20000000) >>> 0;
  } else if ([1, 3, 9].includes(command)) {
    w.style = (w.style & ~0x20000000) >>> 0;
    w.showCmd = command === 3 ? 3 : 1;
    delete w.minimizedFrom;
  }
  if (command === 3 && !w.parentId) {
    w.normalRectangle ??= [w.x, w.y, ...outerWindowSize(w)];
    w.showCmd = 3;
    w.style = (w.style | 0x01000000) >>> 0;
    const mode = currentDisplayMode(r);
    const resized = await setWindowPos(r, (i) => [w.id, 0, 0, 0, mode.width, mode.height, 0x14][i]);
    if (!resized.result) return result(previous ? 1 : 0, 2);
  } else if ([1, 9].includes(command) && w.normalRectangle) {
    const [x, y, width, height] = w.normalRectangle;
    w.showCmd = 1;
    w.style = (w.style & ~0x01000000) >>> 0;
    await setWindowPos(r, (i) => [w.id, 0, x, y, width, height, 0x14][i]);
    delete w.normalRectangle;
  }
  w.visible = a(1) !== 0;
  const minimized = [2, 6, 7, 11].includes(w.showCmd);
  if (!w.parentId) {
    if (w.visible && !minimized && a(1) !== 8) {
      r.windows.active = w.id;
      r.windows.raise(w.id);
    } else if ((!w.visible || minimized) && r.windows.active === w.id) r.windows.active = 0;
  }
  r.windows.emit(w);
  await r.windows.send(w.id, 0x18, w.visible ? 1 : 0);
  if (w.visible && !minimized) {
    r.windows.invalidate(w, null, true);
    await r.windows.send(w.id, 5, w.showCmd === 3 ? 2 : 0, pair(w.width, w.height));
  }
  if (w.visible && minimized) await r.windows.send(w.id, 5, 1, 0);
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
  if (msg === 0x20a && w.parentId) return result(await r.windows.send(w.parentId, msg, wp, lp), 4);
  if (msg === 0x205) {
    const [x, y] = r.windows.clientPosition(w);
    await r.windows.send(hwnd, 0x7b, hwnd, pair(x + ((lp << 16) >> 16), y + (lp >> 16)));
    return result(0, 4);
  }
  if (msg === 0x7b && w.parentId) return result(await r.windows.send(w.parentId, msg, wp, lp), 4);
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
  if (msg >= 0x132 && msg <= 0x138) {
    gdiApis['gdi32.dll!SetTextColor'](r, (i) => [wp, 0][i]);
    const color = msg === 0x133 || msg === 0x134 ? 5 : 15;
    const rgb = gdiApis['user32.dll!GetSysColor'](r, () => color).result;
    gdiApis['gdi32.dll!SetBkColor'](r, (i) => [wp, rgb][i]);
    return result(gdiApis['user32.dll!GetSysColorBrush'](r, () => color).result, 4);
  }
  if (msg === 0x81) return result(1, 4);
  if (msg === 0x83) {
    if (wp) r.check(lp, 52);
    const rect = [0, 4, 8, 12].map((i) => r.read32(lp + i) | 0);
    const { border, title } = frameForWindow(w);
    rectangle(r, lp, [
      rect[0] + border,
      rect[1] + title + border,
      Math.max(rect[0] + border, rect[2] - border),
      Math.max(rect[1] + title + border, rect[3] - border),
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
      await r.windows.send(hwnd, 5, w.showCmd === 3 ? 2 : 0, pair(w.width, w.height));
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
  if (msg === 0x112 && (wp & 0xfff0) === 0xf060)
    return result(await r.windows.send(hwnd, 0x10, 0, 0), 4);
  if (msg === 0x10) return result(await r.windows.destroy(hwnd), 4);
  if (msg === 0xc) {
    w.title = text(r, lp, wide);
    if (w.controlType && hasControlDrawing(r, w.id)) r.windows.invalidate(w, null, true);
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
  if (msg === 0xf && (!w.controlType || w.controlType === 'custom')) {
    const paint = r.allocate(64);
    try {
      const response = await beginPaint(r, (i) => [hwnd, paint][i]);
      if (response.result) gdiApis['user32.dll!ReleaseDC'](r, (i) => [hwnd, response.result][i]);
      flushGdi(r);
    } finally {
      r.free(paint);
    }
  }
  return result(0, 4);
}
async function beginPaint(r, a, controlColorCallback = false) {
  const w = r.windows.windows.get(a(0)),
    p = a(1);
  if (!w) return r.windows.fail(1400, 2);
  r.check(p, 64, true);
  const dc = controlColorCallback
    ? acquireControlColorDC(r, w.id)
    : gdiApis['user32.dll!GetDC'](r, (i) => (i ? 0 : w.id)).result;
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

// Ordinary DOM-backed controls still execute their native parent's color
// callbacks with a real borrowed HDC. Colors are copied before releasing it.
function colorControl(window) {
  return ['edit', 'static', 'button', 'listbox'].includes(window.controlType);
}
function invalidateControlColors(manager, hwnd) {
  for (const control of manager.windows.values()) {
    if (!colorControl(control)) continue;
    let current = control;
    while (current) {
      if (current.id === hwnd) {
        manager.invalidate(control, null, true);
        break;
      }
      current = manager.windows.get(current.parentId);
    }
  }
}
async function paintControlColors(r, window) {
  const paint = r.allocate(64);
  let dc = 0;
  try {
    dc = (await beginPaint(r, (i) => [window.id, paint][i], true)).result;
    if (!dc) throw Error(`Native control color HDC unavailable (${r.lastError})`);
    if (!r.windows.windows.has(window.id)) return 0;
    const message =
      window.controlType === 'edit'
        ? window.readOnly || !r.windows.isEnabled(window.id)
          ? 0x138
          : 0x133
        : { static: 0x138, button: 0x135, listbox: 0x134 }[window.controlType];
    if (window.fontHandle) gdiApis['gdi32.dll!SelectObject'](r, (i) => [dc, window.fontHandle][i]);
    let brushHandle;
    if (window.parentId)
      brushHandle = await r.windows.send(window.parentId, message, dc, window.id);
    else
      brushHandle = (
        await defaultProc(r, (i) => [window.id, message, dc, window.id][i], window.cls.wide)
      ).result;
    if (!r.windows.windows.has(window.id)) return 0;
    const state = activeGdiDC(r, dc),
      brush = describeGdiBrush(r, brushHandle);
    if (state) {
      window.controlColors = {
        text: state.textColor,
        background: brush && !brush.null ? brush.color : state.backgroundColor,
        transparent: !!brush?.null || !brushHandle,
        hatch: brush?.hatch,
        hatchBackground: state.backgroundColor,
        backgroundMode: state.bkMode,
      };
      r.windows.emit(window);
    }
    return 0;
  } finally {
    if (dc) {
      gdiApis['user32.dll!ReleaseDC'](r, (i) => [window.id, dc][i]);
      releaseControlColorSurface(r, window.id);
    }
    r.free(paint);
  }
}

// SS_OWNERDRAW and BS_OWNERDRAW call the parent's native drawing procedure.
// DRAWITEMSTRUCT is 48 bytes on PE32; its RECT uses child-client coordinates.
async function paintOwnerDraw(r, window, action = 1) {
  const paint = r.allocate(64),
    item = r.allocate(48);
  let dc = 0;
  try {
    dc =
      action === 1 && window.invalid
        ? (await beginPaint(r, (i) => [window.id, paint][i])).result
        : gdiApis['user32.dll!GetDC'](r, () => window.id).result;
    if (!dc) return 0;
    if (window.fontHandle) gdiApis['gdi32.dll!SelectObject'](r, (i) => [dc, window.fontHandle][i]);
    if (window.controlType === 'button')
      await r.windows.send(window.parentId, 0x135, dc, window.id);
    if (!r.windows.windows.has(window.id)) return 0;
    r.data.fill(0, item, item + 48);
    [
      window.controlType === 'button' ? 4 : 5,
      window.controlId,
      0,
      action,
      (r.windows.isEnabled(window.id) ? 0 : 4) |
        (window.pushed ? 1 : 0) |
        (window.buttonFocused ? 16 : 0),
      window.id,
      dc,
      0,
      0,
      window.width,
      window.height,
      0,
    ].forEach((v, i) => r.write32(item + i * 4, v));
    await r.windows.send(window.parentId, 0x2b, window.controlId, item);
    return 0;
  } finally {
    if (dc) gdiApis['user32.dll!ReleaseDC'](r, (i) => [window.id, dc][i]);
    flushGdi(r);
    r.free(item);
    r.free(paint);
  }
}

// Host-side window creation for the dialog module. It builds the same guest
// call the class-create path expects, so register/create/defaultProc all run
// exactly as they do for a guest CreateWindowEx.
export async function createWindowFromHost(r, spec) {
  const wide = !!spec.wide;
  const classPointer =
    typeof spec.className === 'number'
      ? spec.className
      : spec.className
        ? r.allocString(spec.className, wide)
        : 0;
  const titlePointer = spec.title ? r.allocString(spec.title, wide) : 0;
  try {
    const style = (spec.style ?? 0) >>> 0;
    const parent = spec.parent >>> 0;
    const child = !!parent && !spec.owner;
    const args = [
      (spec.exStyle ?? 0) >>> 0,
      classPointer,
      titlePointer,
      child ? style | 0x40000000 : style || 0x00cf0000,
      spec.x | 0,
      spec.y | 0,
      spec.width | 0,
      spec.height | 0,
      parent,
      spec.menuOrId ?? spec.controlId ?? 0,
      spec.instance ?? r.pe.imageBase,
      0,
    ];
    const response = await create(r, (i) => args[i] ?? 0, wide);
    return response.result ? { id: response.result } : { error: r.lastError };
  } finally {
    if (classPointer && typeof spec.className !== 'number') r.free(classPointer);
    if (titlePointer) r.free(titlePointer);
  }
}

/** Register a callable host WNDPROC that survives native module rollback. */
export function registerHostWindowProcedure(r, key, entry) {
  const manager = r.windows;
  manager.controlProcedures ??= new Map();
  manager.controlProcedureEntries ??= new Map();
  if (manager.controlProcedures.has(key)) return manager.controlProcedures.get(key);
  const pointer = registerThunk(r.thunks, entry);
  manager.controlProcedures.set(key, pointer);
  manager.controlProcedureEntries.set(pointer, entry);
  return pointer;
}

// A host-provided top-level class the dialog layer builds its frames with. It
// has no control behaviour and no class procedure: the dialog's own procedure
// receives every message, which is what a DLGPROC expects.
const HOST_WINDOW_CLASSES = new Map([
  [
    'winebrowser-dialog',
    {
      name: 'winebrowser-dialog',
      wide: false,
      proc: 0,
      extra: 30,
      background: 16,
      cursor: 32512,
      icon: 0,
      style: 0,
    },
  ],
]);
const HOST_WIDE_WINDOW_CLASSES = new Map();
function builtinWindowClass(name, wide) {
  name = String(name).toLowerCase();
  const cls = HOST_WINDOW_CLASSES.get(name);
  if (!cls || !wide) return cls ?? null;
  if (!HOST_WIDE_WINDOW_CLASSES.has(name))
    HOST_WIDE_WINDOW_CLASSES.set(name, { ...cls, wide: true });
  return HOST_WIDE_WINDOW_CLASSES.get(name);
}

export const windowApis = { ...cursorApis, ...windowFindApis, ...windowDataApis };
windowApis['user32.dll!IsWindowUnicode'] = (r, a) =>
  result(+!!r.windows.windows.get(a(0))?.cls.wide, 1);

// ---------------------------------------------------------------------------
// Dialog-item accessors. SetDlgItemText/GetDlgItemText forward WM_SETTEXT and
// WM_GETTEXT to the control with the given identifier, and the numeric forms
// convert between the control's text and an integer, exactly like the originals.
function dlgItem(r, hwnd, id) {
  return (
    [...r.windows.windows.values()].find((w) => w.parentId === hwnd && w.controlId === id) ?? null
  );
}
// SetDlgItemText/GetDlgItemText forward WM_SETTEXT and WM_GETTEXT to the
// control with the given identifier; the numeric forms convert between the
// control's text and an integer exactly like the originals do.
async function setDlgItemText(r, a, wide) {
  const control = dlgItem(r, a(0), a(1));
  if (!control) return result(0, 3);
  const value = a(2) ? (wide ? r.wideString(a(2)) : r.string(a(2))) : '';
  const pointer = r.allocString(value, wide);
  const changed = await sendWindowMessage(r, control.id, 0xc, 0, pointer, wide);
  r.free(pointer);
  return result(changed ? 1 : 0, 3);
}
async function getDlgItemText(r, a, wide) {
  const control = dlgItem(r, a(0), a(1));
  if (!control || !a(2)) return result(0, 4);
  return result(await sendWindowMessage(r, control.id, 0xd, a(3), a(2), wide), 4);
}
async function setDlgItemInt(r, a) {
  // SetDlgItemInt(hDlg, nIDDlgItem, uValue, bSigned)
  const text = a(3) ? String(a(2) | 0) : String(a(2) >>> 0);
  const control = dlgItem(r, a(0), a(1));
  if (!control) return result(0, 4);
  const pointer = r.allocString(text, false);
  const changed = await sendWindowMessage(r, control.id, 0xc, 0, pointer, false);
  r.free(pointer);
  return result(changed ? 1 : 0, 4);
}
async function getDlgItemInt(r, a) {
  const control = dlgItem(r, a(0), a(1)),
    translated = a(2),
    signed = !!a(3);
  if (translated) {
    r.check(translated, 4, true);
    r.write32(translated, 0);
  }
  if (!control) return result(0, 4);
  const token = (signed ? /^[+-]?\d+/ : /^\+?\d+/).exec((control.title ?? '').trimStart())?.[0];
  if (!token) return result(0, 4);
  const value = BigInt(token);
  if (value < (signed ? -2147483648n : 0n) || value > (signed ? 2147483647n : 4294967295n))
    return result(0, 4);
  if (translated) r.write32(translated, 1);
  return result(Number(value), 4);
}
for (const wide of [false, true]) {
  const suffix = wide ? 'W' : 'A';
  windowApis[`user32.dll!SetDlgItemText${suffix}`] = (r, a) => setDlgItemText(r, a, wide);
  windowApis[`user32.dll!GetDlgItemText${suffix}`] = (r, a) => getDlgItemText(r, a, wide);
  windowApis[`user32.dll!SetDlgItemInt`] = setDlgItemInt;
  windowApis[`user32.dll!GetDlgItemInt`] = getDlgItemInt;
  windowApis[`user32.dll!GetWindowText${suffix}`] = async (r, a) =>
    result(await sendWindowMessage(r, a(0), 0xd, a(2), a(1), wide), 3);
  windowApis[`user32.dll!GetWindowTextLength${suffix}`] = async (r, a) =>
    result(await r.windows.send(a(0), 0xe), 1);
  Object.assign(windowApis, {
    'user32.dll!GetComboBoxInfo': (r, a) => {
      const w = r.windows.windows.get(a(0));
      if (!w || w.controlType !== 'combobox') return r.windows.fail(1400, 2);
      return result(writeComboInfo(r, w, a(1)), 2);
    },
    [`user32.dll!GetClassInfo${suffix}`]: (r, a) => classInfo(r, a, wide),
    [`user32.dll!UnregisterClass${suffix}`]: (r, a) => classInfo(r, a, wide, true),
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
  'user32.dll!ClipCursor': (r, a) => {
    const rect = a(0) ? readRect(r, a(0)) : null;
    if (rect && (rect[2] < rect[0] || rect[3] < rect[1])) return r.windows.fail(87, 1);
    r.windows.cursorClip = rect;
    const point = r.windows.pointerPosition();
    r.windows.setPointerPosition(point.x, point.y);
    return result(1, 1);
  },
  'user32.dll!GetClipCursor': (r, a) => {
    const mode = currentDisplayMode(r);
    rectangle(r, a(0), r.windows.cursorClip ?? [0, 0, mode.width, mode.height]);
    return result(1, 1);
  },
  'user32.dll!OpenIcon': async (r, a) => {
    if (!r.windows.windows.has(a(0))) return r.windows.fail(1400, 1);
    await show(r, (i) => [a(0), 9][i]);
    return result(1, 1);
  },
  'user32.dll!CloseWindow': async (r, a) => {
    if (!r.windows.windows.has(a(0))) return r.windows.fail(1400, 1);
    await show(r, (i) => [a(0), 6][i]);
    return result(1, 1);
  },
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
  // POINT is passed by value: two dword stack arguments, not a pointer.
  'user32.dll!WindowFromPoint': (r, a) => ({
    result: r.windows.windowFromPoint(a(0) | 0, a(1) | 0) >>> 0,
    argc: 2,
  }),
  'user32.dll!GetPropA': (r, a) => result(getProp(r, a(0), a(1), false), 2),
  'user32.dll!GetPropW': (r, a) => result(getProp(r, a(0), a(1), true), 2),
  'user32.dll!SetPropA': (r, a) => result(setProp(r, a(0), a(1), a(2), false), 3),
  'user32.dll!SetPropW': (r, a) => result(setProp(r, a(0), a(1), a(2), true), 3),
  'user32.dll!RemovePropA': (r, a) => result(removeProp(r, a(0), a(1), false), 2),
  'user32.dll!RemovePropW': (r, a) => result(removeProp(r, a(0), a(1), true), 2),
  'user32.dll!RegisterWindowMessageA': (r, a) => result(registerWindowMessage(r, a(0)), 1),
  'user32.dll!RegisterWindowMessageW': (r, a) => result(registerWindowMessage(r, a(0), true), 1),
  'user32.dll!EnableWindow': async (r, a) => {
    const window = r.windows.windows.get(a(0));
    if (!window) return r.windows.fail(1400, 2);
    const previous = window.enabled !== false;
    window.enabled = a(1) !== 0;
    r.windows.emit(window);
    if (previous !== window.enabled) await r.windows.send(window.id, 0xa, window.enabled ? 1 : 0);
    if (window.ownerDraw) r.windows.invalidate(window, null, true);
    return result(previous ? 0 : 1, 2);
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
      [outerWidth, outerHeight] = outerWindowSize(w);
    rectangle(r, a(1), [x, y, x + outerWidth, y + outerHeight]);
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
        r.windows.windows.get(message.hwnd)?.cls?.wide !== false
          ? message.character.charCodeAt(0)
          : encodeAnsi(message.character).bytes[0],
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
  'user32.dll!SetCapture': async (r, a) => {
    if (!r.windows.windows.has(a(0))) return r.windows.fail(1400, 1);
    return result(await r.windows.changeCapture(a(0)), 1);
  },
  'user32.dll!ReleaseCapture': async (r) => {
    await r.windows.changeCapture(0);
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
  'user32.dll!EqualRect': equalRect,
  'user32.dll!PtInRect': ptInRect,
  'user32.dll!InflateRect': inflateRect,
  'user32.dll!OffsetRect': offsetRect,
  'user32.dll!SetRect': setRect,
  'user32.dll!MapWindowPoints': mapWindowPoints,
  'user32.dll!MoveWindow': moveWindow,
  'user32.dll!DrawEdge': drawEdge,
  'user32.dll!SystemParametersInfoA': (r, a) => systemParametersInfo(r, a, false),
  'user32.dll!SystemParametersInfoW': (r, a) => systemParametersInfo(r, a, true),
  'user32.dll!IsDialogMessageA': isDialogMessage,
  'user32.dll!IsDialogMessageW': isDialogMessage,
  'user32.dll!DefDlgProcA': (r, a) => defDlgProc(r, a, false),
  'user32.dll!DefDlgProcW': (r, a) => defDlgProc(r, a, true),
  'user32.dll!MapDialogRect': mapDialogRect,
  'user32.dll!SendDlgItemMessageA': (r, a) => sendDlgItemMessage(r, a, false),
  'user32.dll!SendDlgItemMessageW': (r, a) => sendDlgItemMessage(r, a, true),
  'user32.dll!RegisterClipboardFormatA': registerClipboardFormat,
  'user32.dll!RegisterClipboardFormatW': registerClipboardFormat,
  'user32.dll!GetMessageTime': getMessageTime,
  'user32.dll!GetQueueStatus': getQueueStatus,
  'user32.dll!CreateCaret': createCaret,
  'user32.dll!DestroyCaret': destroyCaret,
  'user32.dll!ShowCaret': showCaret,
  'user32.dll!HideCaret': hideCaret,
  'user32.dll!SetCaretPos': setCaretPos,
  'user32.dll!GetCaretPos': getCaretPos,
  'user32.dll!GetCaretBlinkTime': getCaretBlinkTime,
  'user32.dll!GetDoubleClickTime': getDoubleClickTime,
  'user32.dll!GetCapture': (r) => result(r.windows.capture),
  'user32.dll!GetKeyboardState': getKeyboardState,
  'user32.dll!SetKeyboardState': setKeyboardState,
  'user32.dll!GetKeyboardLayout': getKeyboardLayout,
  'user32.dll!SetScrollInfo': setScrollInfo,
  'user32.dll!GetScrollInfo': getScrollInfo,
  'user32.dll!GetWindowPlacement': getWindowPlacement,
  'user32.dll!SetWindowPlacement': setWindowPlacement,
  'user32.dll!FlashWindow': (r, a) => {
    if (!r.windows.windows.has(a(0))) return r.windows.fail(1400, 2);
    // The browser desktop already highlights a window on activity; report the
    // previous state as Windows does.
    return result(r.windows.flashState?.[a(0)] ?? 0, 2);
  },
  'user32.dll!IsIconic': (r, a) => {
    const window = r.windows.windows.get(a(0));
    return window
      ? result([2, 6, 7, 11].includes(window.showCmd) ? 1 : 0, 1)
      : r.windows.fail(1400, 1);
  },
  'user32.dll!IsZoomed': (r, a) => {
    const window = r.windows.windows.get(a(0));
    return window ? result(window.showCmd === 3 ? 1 : 0, 1) : r.windows.fail(1400, 1);
  },
  'user32.dll!SetActiveWindow': (r, a) => {
    if (!r.windows.windows.has(a(0))) return r.windows.fail(1400, 1);
    const previous = r.windows.active;
    r.windows.active = a(0) >>> 0;
    return result(previous, 1);
  },
  'user32.dll!SetForegroundWindow': (r, a) => {
    if (!r.windows.windows.has(a(0))) return r.windows.fail(1400, 1);
    r.windows.active = a(0) >>> 0;
    r.windows.raise?.(a(0) >>> 0);
    return result(1, 1);
  },
  'user32.dll!GetSystemMetrics': (r, a) => {
    const metric = a(0) | 0;
    const displayValue = virtualSystemMetric(metric, r);
    if (displayValue !== undefined) return result(displayValue, 1);
    // The remaining metrics describe the browser desktop's fixed visual
    // proportions: a title bar and border from the same frame constants the
    // window manager uses, a standard 16x16 icon, 8-pixel scroll bars, and the
    // menu metrics the menu bar is drawn with. Anything undefined reports 0,
    // which is what Windows itself returns for a metric it does not know.
    const values = {
      2: 17, // SM_CXVSCROLL
      3: 17, // SM_CYHSCROLL
      4: TITLE, // SM_CYCAPTION
      5: BORDER, // SM_CXBORDER
      6: BORDER, // SM_CYBORDER
      7: BORDER, // SM_CXDLGFRAME
      8: BORDER, // SM_CYDLGFRAME
      9: 17, // SM_CYVTHUMB
      10: 17, // SM_CXHTHUMB
      11: 32, // SM_CXICON
      12: 32, // SM_CYICON
      13: 32, // SM_CXCURSOR
      14: 32, // SM_CYCURSOR
      15: MENU_BAR_HEIGHT, // SM_CYMENU
      19: 1, // SM_MOUSEPRESENT
      20: 17, // SM_CYVSCROLL
      21: 17, // SM_CXHSCROLL
      28: 112, // SM_CXMIN
      29: 27, // SM_CYMIN
      30: 16, // SM_CXSIZE
      31: 16, // SM_CYSIZE
      32: BORDER, // SM_CXFRAME
      33: BORDER, // SM_CYFRAME
      34: 112, // SM_CXMINTRACK
      35: 27, // SM_CYMINTRACK
      36: 4, // SM_CXDOUBLECLK
      37: 4, // SM_CYDOUBLECLK
      38: 75, // SM_CXICONSPACING
      39: 75, // SM_CYICONSPACING
      43: 3, // SM_CMOUSEBUTTONS
      45: 2, // SM_CXEDGE
      46: 2, // SM_CYEDGE
      49: 16, // SM_CXSMICON
      50: 16, // SM_CYSMICON
      51: TITLE - 4, // SM_CYSMCAPTION
      54: 16, // SM_CXMENUSIZE
      55: 16, // SM_CYMENUSIZE
      57: 160, // SM_CXMINIMIZED
      58: 24, // SM_CYMINIMIZED
      68: 4, // SM_CXDRAG
      69: 4, // SM_CYDRAG
      71: 13, // SM_CXMENUCHECK
      72: 13, // SM_CYMENUCHECK
      75: 1, // SM_MOUSEWHEELPRESENT
      83: 1, // SM_CXFOCUSBORDER
      84: 1, // SM_CYFOCUSBORDER
    };
    return result(values[metric] ?? 0, 1);
  },
});

// ---------------------------------------------------------------------------
// Caret, capture, scrollbar, placement and input-state services.
// The caret is one blink position per window; the desktop draws it, so the
// runtime records its owner, position and size and reports the system blink.
function createCaret(r, a) {
  const window = r.windows.windows.get(a(0));
  if (!window) return r.windows.fail(1400, 4);
  const bitmap = a(1);
  const width = a(2) | 0,
    height = a(3) | 0;
  if (width < 0 || height < 0) return r.windows.fail(87, 4);
  r.windows.caret = {
    hwnd: a(0),
    bitmap,
    width: width || 2,
    height: height || 16,
    x: 0,
    y: 0,
    visible: true,
  };
  r.windows.emit(window);
  return result(1, 4);
}
function caretWindow(r) {
  const caret = r.windows.caret;
  return caret ? r.windows.windows.get(caret.hwnd) : null;
}
function destroyCaret(r) {
  if (!r.windows.caret) return r.windows.fail(6, 0);
  const window = caretWindow(r);
  r.windows.caret = null;
  if (window) r.windows.emit(window);
  return result(1, 0);
}
function showCaret(r, a) {
  const window = caretWindow(r);
  if (!window) return r.windows.fail(6, 1);
  r.windows.caret.visible = true;
  r.windows.emit(window);
  return result(1, 1);
}
function hideCaret(r, a) {
  const window = caretWindow(r);
  if (!window) return r.windows.fail(6, 1);
  r.windows.caret.visible = false;
  r.windows.emit(window);
  return result(1, 1);
}
function setCaretPos(r, a) {
  const caret = r.windows.caret;
  if (!caret) return r.windows.fail(6, 2);
  caret.x = a(0) | 0;
  caret.y = a(1) | 0;
  const window = caretWindow(r);
  if (window) r.windows.emit(window);
  return result(0, 2);
}
function getCaretPos(r, a) {
  const caret = r.windows.caret;
  if (!caret) return r.windows.fail(6, 1);
  rectangle(r, a(0), [caret.x, caret.y, 0, 0]);
  return result(1, 1);
}
// The system double-click interval the desktop's own input already enforces.
function getDoubleClickTime() {
  return result(500, 0);
}
function getCaretBlinkTime() {
  return result(530, 0);
}
// Get/SetKeyboardState read and write the 256-byte key-state table the runtime
// keeps for GetKeyState and the accelerator path.
function getKeyboardState(r, a) {
  const out = a(0);
  if (!out) return r.windows.fail(87, 1);
  r.check(out, 256, true);
  for (let vk = 0; vk < 256; vk++) r.data[out + vk] = r.windows.keyboardState.get(vk) & 0xff;
  return result(1, 1);
}
function setKeyboardState(r, a) {
  const pointer = a(0);
  if (!pointer) return r.windows.fail(87, 1);
  r.check(pointer, 256);
  for (let vk = 0; vk < 256; vk++) r.windows.keyboardState.set(vk, r.data[pointer + vk]);
  return result(1, 1);
}
// GetKeyboardLayout reports the default layout of the runtime's single locale.
function getKeyboardLayout(r, a) {
  if (a(0)) return r.windows.fail(87, 1);
  return result(0x04090409, 1); // MAKELANGID(en-US, SUBLANG_DEFAULT) twice
}
// Scroll-bar state: Set/GetScrollInfo and the pair helpers. The runtime keeps
// one SCROLLINFO per window and bar so a control's position round-trips.
function scrollBarIndex(bar) {
  return bar === 0 ? 'horizontal' : bar === 1 ? 'vertical' : null;
}
function setScrollInfo(r, a) {
  const window = r.windows.windows.get(a(0));
  if (!window) return r.windows.fail(1400, 4);
  const key = scrollBarIndex(a(1) >>> 0);
  if (!key) return r.windows.fail(87, 4);
  const info = a(2);
  if (!info) return r.windows.fail(87, 4);
  r.check(info, 28);
  if (r.read32(info) !== 28) return r.windows.fail(87, 4);
  const scroll = {
    min: r.read32(info + 4) | 0,
    max: r.read32(info + 8) | 0,
    page: r.read32(info + 12) >>> 0,
    pos: r.read32(info + 16) | 0,
    track: r.read32(info + 20) >>> 0,
  };
  const mask = r.read32(info + 24) >>> 0;
  if (mask & ~0x1f) return r.windows.fail(87, 4);
  window.scrollInfo ??= {};
  const previous = window.scrollInfo[key];
  const merged = { ...(previous ?? { min: 0, max: 0, page: 0, pos: 0, track: 0 }) };
  for (const [bit, field] of [
    [1, 'min'],
    [2, 'max'],
    [4, 'page'],
    [8, 'pos'],
    [16, 'track'],
  ])
    if (mask & bit) merged[field] = scroll[field];
  window.scrollInfo[key] = merged;
  if (a(3)) r.windows.emit(window);
  return result(previous ? previous.pos | 0 : 0, 4);
}
function getScrollInfo(r, a) {
  const window = r.windows.windows.get(a(0));
  if (!window) return r.windows.fail(1400, 3);
  const key = scrollBarIndex(a(1) >>> 0);
  if (!key) return r.windows.fail(87, 3);
  const info = a(2);
  if (!info) return r.windows.fail(87, 3);
  r.check(info, 28, true);
  const mask = r.read32(info + 24) >>> 0;
  if (mask & ~0x1f) return r.windows.fail(87, 3);
  const scroll = window.scrollInfo?.[key];
  if (!scroll) return result(0, 3);
  r.write32(info, 28);
  if (mask & 1) r.write32(info + 4, scroll.min);
  if (mask & 2) r.write32(info + 8, scroll.max);
  if (mask & 4) r.write32(info + 12, scroll.page >>> 0);
  if (mask & 8) r.write32(info + 16, scroll.pos >>> 0);
  if (mask & 16) r.write32(info + 20, scroll.track >>> 0);
  return result(1, 3);
}
// Get/SetWindowPlacement round-trip the placement a minimised or restored
// window reports. The runtime keeps the show state and the normal rectangle.
function getWindowPlacement(r, a) {
  const window = r.windows.windows.get(a(0));
  if (!window) return r.windows.fail(1400, 2);
  const out = a(1);
  if (!out) return r.windows.fail(87, 2);
  r.check(out, 44, true);
  r.data.fill(0, out, out + 44);
  const [x, y] = r.windows.screenPosition(window);
  const outer = outerBounds(window);
  r.write32(out, 44);
  r.write32(out + 4, window.placementFlags ?? 0);
  r.write32(out + 8, window.showCmd ?? (window.visible ? 1 : 0));
  r.write32(out + 12, 0);
  r.write32(out + 16, 0);
  r.write32(out + 20, 0);
  r.write32(out + 24, 0);
  const normal = window.normalRectangle ?? [x, y, outer.width, outer.height];
  r.write32(out + 28, normal[0]);
  r.write32(out + 32, normal[1]);
  r.write32(out + 36, normal[0] + normal[2]);
  r.write32(out + 40, normal[1] + normal[3]);
  return result(1, 2);
}
function setWindowPlacement(r, a) {
  const window = r.windows.windows.get(a(0));
  if (!window) return r.windows.fail(1400, 2);
  const pointer = a(1);
  if (!pointer) return r.windows.fail(87, 2);
  r.check(pointer, 44);
  if (r.read32(pointer) !== 44) return r.windows.fail(87, 2);
  // WINDOWPLACEMENT: length 0, flags 4, showCmd 8, ptMinPosition 12,
  // ptMaxPosition 20, rcNormalPosition 28 (RECT: left/top/right/bottom).
  const show = r.read32(pointer + 8) | 0;
  if (show < 0 || show > 9) return r.windows.fail(87, 2);
  window.showCmd = show;
  const left = r.read32(pointer + 28) | 0;
  const top = r.read32(pointer + 32) | 0;
  const right = r.read32(pointer + 36) | 0;
  const bottom = r.read32(pointer + 40) | 0;
  if (right > left && bottom > top) {
    // The rectangle is the window's restored outer bounds, so the client size
    // follows from the frame the window already uses.
    const frame = frameForWindow(window);
    window.x = left + frame.border;
    window.y = top + frame.border + frame.title;
    window.width = Math.max(1, right - left - 2 * frame.border);
    window.height = Math.max(1, bottom - top - 2 * frame.border - frame.title);
    resizeWindowSurface(r, window.id, window.width, window.height);
  }
  r.windows.emit(window);
  return result(1, 2);
}
function outerBounds(window) {
  const frame = frameForWindow(window);
  return {
    border: frame.border,
    title: frame.title,
    width: window.width + 2 * frame.border,
    height: window.height + 2 * frame.border + frame.title,
  };
}

// ---------------------------------------------------------------------------
// Dialog message handling and the icon/message services GUI code imports.
// IsDialogMessage/DefDlgProc route a dialog's keyboard navigation through the
// same control-focus logic the window manager already applies; MapDialogRect
// converts dialog units to pixels with the runtime's own font metrics.
async function isDialogMessage(r, a) {
  const window = r.windows.windows.get(a(0));
  if (!window) return r.windows.fail(1400, 2);
  const message = a(1);
  if (!message) return r.windows.fail(87, 2);
  r.check(message, 28);
  const hwnd = r.read32(message),
    id = r.read32(message + 4),
    vk = r.read32(message + 8);
  if (hwnd !== window.id && r.windows.topLevel(hwnd) !== window.id) return result(0, 2);
  if (![0x100, 0x101].includes(id) || ![9, 13, 27].includes(vk)) return result(0, 2);
  const focused = r.windows.windows.get(r.windows.focus);
  const code = await r.windows.send(hwnd, 0x87, vk, message);
  if (code & 4 || (vk === 9 && code & 2)) return result(0, 2);
  if (vk === 13 && focused?.multiline && focused.wantReturn) return result(0, 2);
  if (id === 0x101) return result(1, 2);
  const children = [...r.windows.windows.values()].filter(
    (child) => child.parentId === a(0) && child.controlType && child.visible && child.enabled,
  );
  if (vk === 27) {
    r.windows.post(a(0), 0x111, 2, 0);
    return result(1, 2);
  }
  if (vk === 13) {
    const button =
      focused?.controlType === 'button' && focused.buttonType.includes('push')
        ? focused
        : children.find((c) => c.buttonType === 'default-push');
    if (button) await r.windows.send(button.id, 0xf5, 0, 0);
    return result(1, 2);
  }
  const reverse = !!(r.windows.keys.get(16) & 0x8000);
  const next = legacyUiApis['user32.dll!GetNextDlgTabItem'](
    r,
    (i) => [window.id, r.windows.focus, +reverse][i],
  ).result;
  if (!next) return result(0, 2);
  await r.windows.setFocus(next);
  return result(1, 2);
}
// DefDlgProc resets DWLP_MSGRESULT before calling DLGPROC. For most messages
// its return is that slot, not the DLGPROC Boolean; CTLCOLOR and initialization
// are documented exceptions returning the application value directly.
async function dispatchDialogMessage(r, window, message, wp, lp, wide) {
  if (window.extra.byteLength >= 4) window.extra.setUint32(0, 0, true);
  const handled = window.dialogProc
    ? await r.callGuest(window.dialogProc, [window.id, message, wp, lp])
    : 0;
  if (handled || message === 0x110) {
    if (
      (message >= 0x132 && message <= 0x138) ||
      [0x19, 0x2f, 0x2e, 0x39, 0x37, 0x110].includes(message)
    )
      return handled;
    return window.extra.byteLength >= 4 ? window.extra.getUint32(0, true) : 0;
  }
  if (message === 0x31) return window.fontHandle || 0;
  if (message === 0x30) {
    const font = wp ? describeGdiFont(r, wp) : null;
    if (wp && !font) return 0;
    window.fontHandle = wp;
    window.font = font;
    r.windows.emit(window);
    return 0;
  }
  if (message === 0x14) {
    // Wine's DefDlgProc asks the application for WM_CTLCOLORDLG first, then
    // fills the client with the default dialog brush if it returns zero.
    const brush =
      (await r.windows.send(window.id, 0x136, wp, window.id)) ||
      (await defaultProc(r, (i) => [window.id, 0x136, wp, window.id][i], wide)).result;
    const rect = r.allocate(16);
    try {
      rectangle(r, rect, [0, 0, window.width, window.height]);
      gdiApis['user32.dll!FillRect'](r, (i) => [wp, rect, brush][i]);
    } finally {
      r.free(rect);
    }
    return 1;
  }
  if (message === 0x10 && r.dialogs?.byWindow.has(window.id))
    return r.windows.send(window.id, 0x111, 2, 0);
  return (await defaultProc(r, (i) => [window.id, message, wp, lp][i], wide)).result;
}
async function defDlgProc(r, a, wide) {
  const window = r.windows.windows.get(a(0));
  if (!window) return r.windows.fail(1400, 4);
  return result(await dispatchDialogMessage(r, window, a(1), a(2), a(3), wide), 4);
}
// MapDialogRect converts a rectangle from dialog units to pixels.
function mapDialogRect(r, a) {
  const window = r.windows.windows.get(a(0));
  if (!window) return r.windows.fail(1400, 2);
  const pointer = a(1);
  if (!pointer) return r.windows.fail(87, 2);
  r.check(pointer, 16, true);
  const rect = [0, 4, 8, 12].map((i) => r.read32(pointer + i) | 0);
  const units = window.dialogBaseUnits;
  const values = [
    dialogX(units, rect[0]),
    dialogY(units, rect[1]),
    dialogX(units, rect[2]),
    dialogY(units, rect[3]),
  ];
  values.forEach((value, i) => r.write32(pointer + i * 4, value));
  return result(1, 2);
}
// SendDlgItemMessageA/W forwards a message to the identified child control, the
// same way SendMessage does after a GetDlgItem.
function sendDlgItemMessage(r, a, wide) {
  const window = r.windows.windows.get(a(0));
  if (!window) return r.windows.fail(1400, 5);
  const control = [...r.windows.windows.values()].find(
    (child) => child.parentId === a(0) && child.controlId === a(1),
  );
  if (!control) return r.windows.fail(1400, 5);
  // The ANSI/Unicode conversion happens at the callback boundary; textOut-style
  // messages carry a pointer either way, so the raw value is forwarded.
  return sendWindowMessage(r, control.id, a(2) >>> 0, a(3) >>> 0, a(4) >>> 0, wide).then((value) =>
    result(value, 5),
  );
}
// RegisterClipboardFormatA/W assigns a stable integer to a format name within
// the process, which is what an application compares against.
function registerClipboardFormat(r, a) {
  const name = r.string(a(0));
  if (!name) return r.windows.fail(87, 1);
  r.clipboardFormats ??= new Map();
  const existing = r.clipboardFormats.get(name);
  if (existing) return result(existing, 1);
  r.nextClipboardFormat ??= 0xc000;
  const handle = r.nextClipboardFormat++;
  r.clipboardFormats.set(name, handle);
  return result(handle, 1);
}
// GetMessageTime reports the timestamp of the message being dispatched. The
// runtime stamps every queued message with the guest clock.
function getMessageTime(r) {
  const delivered = r.windows.delivered?.values()?.next?.()?.value;
  return result(delivered?.time ?? 0);
}
// GetQueueStatus reports which message types are queued, as a packed
// QS_* mask in the high word with the low word reserved.
function getQueueStatus(r, a) {
  const flags = a(0) >>> 0;
  let status = 0;
  for (const entry of r.windows.queue) {
    const message = entry.message;
    if (message === 0x100 || message === 0x101 || message === 0x102 || message === 0x104)
      status |= 0x400;
    else if (message === 0x200 || message === 0x201 || message === 0x202) status |= 0x800;
    else if (message === 0x113) status |= 0x2000;
    else if (message === 0x12) status |= 0x40;
    else status |= 0x1;
  }
  if ([...r.windows.windows.values()].some((window) => window.invalid)) status |= 0x1;
  return result(((status & flags & 0xffff) << 16) | (status & 0xffff), 1);
}

// SystemParametersInfoA/W(uiAction, uiParam, pvParam, fWinIni). The getters
// answer from the same values GetSystemMetrics and the display module use; a
// setter that would change desktop state is refused rather than silently
// ignored.
function systemParametersInfo(r, a, wide) {
  const action = a(0) >>> 0;
  const param = a(1) >>> 0;
  const output = a(2) >>> 0;
  const winIni = a(3) >>> 0;
  if (winIni & ~0x7) return r.windows.fail(87, 4);
  switch (action) {
    case 0x0004: // SPI_GETBEEP
    case 0x0006: // SPI_GETMOUSE
      if (!output || param < 4) return r.windows.fail(87, 4);
      r.check(output, param, true);
      r.data.fill(0, output, output + param);
      return result(1, 4);
    case 0x0008: // SPI_SETBEEP
    case 0x000a: // SPI_SETMOUSE
      return result(1, 4);
    case 0x000c: // SPI_GETBORDER
      if (!output) return r.windows.fail(87, 4);
      r.check(output, 4, true);
      r.write32(output, BORDER);
      return result(1, 4);
    case 0x000e: // SPI_GETKEYBOARDSPEED
      if (!output) return r.windows.fail(87, 4);
      r.check(output, 4, true);
      r.write32(output, 31);
      return result(1, 4);
    case 0x0010: // SPI_SETKEYBOARDSPEED
    case 0x0014: // SPI_SETKEYBOARDDELAY
    case 0x001c: // SPI_SETSCREENSAVEACTIVE-inverted: accepted as a no-op
      return result(1, 4);
    case 0x0012: // SPI_GETKEYBOARDDELAY
      if (!output) return r.windows.fail(87, 4);
      r.check(output, 4, true);
      r.write32(output, 1);
      return result(1, 4);
    case 0x0016: // SPI_ICONHORIZONTALSPACING
    case 0x0017: // SPI_GETSCREENSAVETIMEOUT
      if (!output) return r.windows.fail(87, 4);
      r.check(output, 4, true);
      r.write32(output, action === 0x0016 ? 75 : 600);
      return result(1, 4);
    case 0x0024: // SPI_GETKEYBOARDPREF
      if (!output) return r.windows.fail(87, 4);
      r.check(output, 4, true);
      r.write32(output, 0);
      return result(1, 4);
    case 0x0026: // SPI_GETSCREENREADER
      if (!output) return r.windows.fail(87, 4);
      r.check(output, 4, true);
      r.write32(output, 0);
      return result(1, 4);
    case 0x002a: // SPI_GETMENUANIMATION
      if (!output) return r.windows.fail(87, 4);
      r.check(output, 4, true);
      r.write32(output, 1);
      return result(1, 4);
    case 0x0032: // SPI_GETDRAGFULLWINDOWS
      if (!output) return r.windows.fail(87, 4);
      r.check(output, 4, true);
      r.write32(output, 1);
      return result(1, 4);
    case 0x0036: // SPI_GETNONCLIENTMETRICS
      return nonClientMetrics(r, param, output, wide);
    case 0x0037: // SPI_SETNONCLIENTMETRICS
      return result(1, 4);
    case 0x0042: // SPI_GETICONTITLELOGFONT
      return iconTitleLogFont(r, param, output, wide);
    case 0x0049: // SPI_GETICONTITLEWRAP
      if (!output) return r.windows.fail(87, 4);
      r.check(output, 4, true);
      r.write32(output, 1);
      return result(1, 4);
    case 0x005a: // SPI_GETMOUSETRAILS
      if (!output) return r.windows.fail(87, 4);
      r.check(output, 4, true);
      r.write32(output, 0);
      return result(1, 4);
    case 0x005c: // SPI_GETWHEELSCROLLLINES
      if (!output) return r.windows.fail(87, 4);
      r.check(output, 4, true);
      r.write32(output, 3);
      return result(1, 4);
    case 0x0060: // SPI_GETWORKAREA
      if (!output) return r.windows.fail(87, 4);
      rectangle(r, output, [0, 0, 1024, 768]);
      return result(1, 4);
    case 0x0064: // SPI_GETMENUSHOWDELAY
      if (!output) return r.windows.fail(87, 4);
      r.check(output, 4, true);
      r.write32(output, 400);
      return result(1, 4);
    default:
      // An unrecognised action is refused rather than answered with a value a
      // caller would then store as a setting.
      return r.windows.fail(87, 4);
  }
}
// NONCLIENTMETRICSA/W: cbSize, six frame metrics, then the caption, small
// caption, menu, status and message LOGFONTs interleaved with the remaining
// metrics. The runtime reports its own frame metrics and default face.
const LOGFONT_BYTES = { ansi: 60, wide: 92 };
function writeLogFont(r, at, wide, height) {
  const size = wide ? 92 : 60;
  r.data.fill(0, at, at + size);
  r.write32(at, -height);
  r.write32(at + 16, 400);
  r.data[at + 23] = 0x31; // DEFAULT_CHARSET
  const face = 'MS Shell Dlg';
  if (wide) {
    for (let i = 0; i < face.length; i++)
      r.guestMemory.write(at + 28 + i * 2, face.charCodeAt(i), 2);
  } else {
    for (let i = 0; i < face.length; i++) r.data[at + 28 + i] = face.charCodeAt(i);
  }
}
// NONCLIENTMETRICSA is 344 bytes and NONCLIENTMETRICSW is 504 on i386, both
// confirmed against the MinGW-w64 headers. The layout is cbSize, six frame
// metrics, then the caption font, the small-caption metrics and font, the menu
// metrics and font, and the status and message fonts, with a trailing
// iPaddedBorderWidth.
const NONCLIENTMETRICS_BYTES = { ansi: 344, wide: 504 };
function nonClientMetrics(r, size, output, wide) {
  if (!output) return r.windows.fail(87, 4);
  const font = wide ? 92 : 60;
  const total = wide ? NONCLIENTMETRICS_BYTES.wide : NONCLIENTMETRICS_BYTES.ansi;
  if (size < total) return r.windows.fail(87, 4);
  r.check(output, total, true);
  r.data.fill(0, output, output + total);
  r.write32(output, total);
  let at = output + 4;
  // iBorderWidth, iScrollWidth, iScrollHeight, iCaptionWidth, iCaptionHeight.
  for (const value of [BORDER, 17, 17, TITLE, TITLE]) {
    r.write32(at, value);
    at += 4;
  }
  writeLogFont(r, at, wide, 12); // lfCaptionFont
  at += font;
  r.write32(at, 13); // iSmCaptionWidth
  r.write32(at + 4, 13); // iSmCaptionHeight
  at += 8;
  writeLogFont(r, at, wide, 12); // lfSmCaptionFont
  at += font;
  r.write32(at, 17); // iMenuWidth
  r.write32(at + 4, 17); // iMenuHeight
  at += 8;
  writeLogFont(r, at, wide, 12); // lfMenuFont
  at += font;
  writeLogFont(r, at, wide, 12); // lfStatusFont
  at += font;
  writeLogFont(r, at, wide, 12); // lfMessageFont
  at += font;
  r.write32(at, 0); // iPaddedBorderWidth
  return result(1, 4);
}
function iconTitleLogFont(r, size, output, wide) {
  const font = wide ? 92 : 60;
  if (!output) return r.windows.fail(87, 4);
  if (size < font) return r.windows.fail(87, 4);
  r.check(output, font, true);
  writeLogFont(r, output, wide, 12);
  return result(1, 4);
}

function adjustRect(r, a, extended) {
  // AdjustWindowRect(Ex) grows a client rectangle into the window rectangle
  // that would produce it. A menu adds the menu-bar height above the client
  // area, which is why the caller passes bMenu TRUE for a window with a menu.
  const menu = !!a(2);
  if (extended && a(3) & ~0x40308) throw Error('Unsupported extended window styles');
  r.check(a(0), 16, true);
  const rect = [0, 4, 8, 12].map((i) => r.read32(a(0) + i) | 0);
  const { border, title } = windowFrame(a(1), false, extended ? a(3) : 0);
  rectangle(r, a(0), [
    rect[0] - border,
    rect[1] - title - border - (menu ? MENU_BAR_HEIGHT : 0),
    rect[2] + border,
    rect[3] + border,
  ]);
  return result(1, extended ? 4 : 3);
}
