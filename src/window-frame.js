// Client-area bounds shared by native window creation, resizing and GDI.
// The desktop display mode is independent: applications may create larger windows.
export const MAX_WINDOW_WIDTH = 2048;
export const MAX_WINDOW_HEIGHT = 2048;

// Geometry of the browser desktop theme, in guest pixels. Overlapped windows
// receive the default caption; WS_POPUP only gets explicitly requested chrome.
export function windowFrame(style = 0, menu = false, exStyle = 0) {
  const popup = !!(style & 0x80000000);
  return {
    border: (!popup || style & 0x00c40000 ? 1 : 0) + (exStyle & 0x200 ? 2 : 0),
    title: (!popup || (style & 0x00c00000) === 0x00c00000 ? 28 : 0) + (menu ? 20 : 0),
    menu: menu ? 20 : 0,
    resizable: !popup || !!(style & 0x00040000),
  };
}

export function frameForWindow(window) {
  return window.parentId
    ? {
        border: window.pendingControlBorder ?? window.controlBorder ?? 0,
        title: 0,
        resizable: false,
      }
    : windowFrame(window.style, !!window.menu, window.exStyle);
}

export function compareWindowOrder(a, b) {
  return Number(!!b.topmost) - Number(!!a.topmost) || (b.zOrder ?? 0) - (a.zOrder ?? 0);
}

// Outer geometry follows the active frame, including borderless tiny controls.
export function outerWindowSize(window) {
  const frame = frameForWindow(window);
  return [window.width + 2 * frame.border, window.height + 2 * frame.border + frame.title];
}

export function effectiveControlBorder(border, width, height) {
  return width >= 2 * border && height >= 2 * border ? border : 0;
}
