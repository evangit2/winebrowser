import { VIRTUAL_DISPLAY_MODE, currentDisplayMode } from './win32-display.js';
import { setWindowPos } from './win32-window-position.js';
import { frameForWindow } from './window-frame.js';

function notify(r) {
  const mode = currentDisplayMode(r);
  for (const w of r.windows.windows.values())
    if (!w.parentId)
      r.windows.post(w.id, 0x7e, mode.bitsPerPixel, mode.width | (mode.height << 16));
}
export async function enterFullscreen(r, state, options) {
  const w = r.windows.windows.get(options.windowId);
  state.fullscreen = {
    mode: r.displayMode,
    window: {
      id: w.id,
      style: w.style,
      exStyle: w.exStyle,
      x: w.x,
      y: w.y,
      width: w.width,
      height: w.height,
      topmost: w.topmost,
    },
  };
  r.d3dFullscreen = state;
  r.displayMode = {
    ...VIRTUAL_DISPLAY_MODE,
    width: options.width,
    height: options.height,
    bitsPerPixel: options.colorFormat === 23 ? 16 : 32,
  };
  w.style = ((w.style & ~0x00c40000) | 0x80000000) >>> 0;
  const args = [w.id, 0xffffffff, 0, 0, options.width, options.height, 0x60];
  try {
    if (!(await setWindowPos(r, (i) => args[i])).result)
      throw Error('D3D fullscreen window positioning failed');
    notify(r);
  } catch (error) {
    await leaveFullscreen(r, state);
    throw error;
  }
}
export async function leaveFullscreen(r, state) {
  if (r.d3dFullscreen !== state) return;
  const saved = state.fullscreen;
  r.d3dFullscreen = null;
  r.displayMode = saved.mode;
  const w = r.windows.windows.get(saved.window.id);
  if (w) {
    w.style = saved.window.style;
    w.exStyle = saved.window.exStyle;
    const frame = frameForWindow(w);
    const args = [
      w.id,
      saved.window.topmost ? 0xffffffff : 0xfffffffe,
      saved.window.x,
      saved.window.y,
      saved.window.width + frame.border * 2,
      saved.window.height + frame.border * 2 + frame.title,
      0x30,
    ];
    await setWindowPos(r, (i) => args[i]);
  }
  notify(r);
  state.fullscreen = null;
}
