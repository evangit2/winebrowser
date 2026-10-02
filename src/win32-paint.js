// Paint requests and message waits share the guest window manager's queue.
export const paintApis = {
  'user32.dll!ValidateRect': (r, a) => {
    const window = r.windows.windows.get(a(0));
    if (!window) return r.windows.fail(1400, 2);
    if (a(1) && window.invalid) {
      r.check(a(1), 16);
      const rect = [0, 4, 8, 12].map((off) => r.read32(a(1) + off) | 0);
      if (
        rect[0] > window.invalid[0] ||
        rect[1] > window.invalid[1] ||
        rect[2] < window.invalid[2] ||
        rect[3] < window.invalid[3]
      )
        throw Error('Unsupported partial ValidateRect region');
    }
    window.invalid = null;
    window.erase = false;
    return { result: 1, argc: 2 };
  },
  'user32.dll!WaitMessage': async (r) => {
    while (
      !r.windows.queue.length &&
      ![...r.windows.windows.values()].some(
        (window) => window.invalid && r.windows.isVisible(window.id),
      )
    ) {
      await r.threads.block(
        new Promise((resolve) => {
          r.windows.wake = resolve;
        }),
      );
    }
    return { result: 1, argc: 0 };
  },
  'user32.dll!RedrawWindow': async (r, a) => {
    const window = r.windows.windows.get(a(0));
    if (!window) return r.windows.fail(1400, 4);
    const flags = a(3) >>> 0;
    if (a(2) || flags & ~0x13f) throw Error('Unsupported RedrawWindow region or flags');
    let rect = null;
    if (a(1)) {
      r.check(a(1), 16);
      rect = [0, 4, 8, 12].map((off) => r.read32(a(1) + off) | 0);
    }
    if (flags & 1) r.windows.invalidate(window, rect, !!(flags & 4));
    if (flags & 8) window.invalid = null;
    if (flags & 0x20) window.erase = false;
    // Internal paint is a synthesized low-priority WM_PAINT request, not a
    // posted input message. It must not keep WaitMessage awake while paused.
    if (flags & 0x10) window.internalPaint = false;
    if (flags & 2) window.internalPaint = true;
    if (flags & 0x100 && (window.invalid || flags & 2)) {
      r.windows.queue = r.windows.queue.filter((m) => m.hwnd !== window.id || m.message !== 0xf);
      window.internalPaint = false;
      await r.windows.send(window.id, 0xf);
    }
    return { result: 1, argc: 4 };
  },
};
