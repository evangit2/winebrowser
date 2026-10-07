// The virtual desktop uses a 96-DPI coordinate space. Keep awareness per guest
// thread so native callers can save/restore their context without changing peers.
import { DESKTOP_WINDOW } from './win32-gdi.js';
const contexts = new Set([0xffffffff, 0xfffffffe, 0xfffffffd, 0xfffffffc, 0xfffffffb]);
const current = (r) => r.threads?.current ?? r;
export const dpiApis = {
  'user32.dll!GetDpiForWindow': (r, a) => {
    const hwnd = a(0) >>> 0;
    if (hwnd !== DESKTOP_WINDOW && !r.windows.windows.has(hwnd)) return r.windows.fail(1400, 1);
    return { result: 96, argc: 1 };
  },
  'user32.dll!SetThreadDpiAwarenessContext': (r, a) => {
    const value = a(0) >>> 0;
    if (!contexts.has(value)) {
      r.lastError = 87;
      return { result: 0, argc: 1 };
    }
    const thread = current(r),
      previous = thread.dpiAwarenessContext ?? 0xffffffff;
    thread.dpiAwarenessContext = value;
    return { result: previous, argc: 1 };
  },
  'user32.dll!GetThreadDpiAwarenessContext': (r) => ({
    result: current(r).dpiAwarenessContext ?? 0xffffffff,
    argc: 0,
  }),
};
