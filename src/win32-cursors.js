import { CURSOR_STYLES } from './cursors.js';
const states = new WeakMap();
const result = (value, argc) => ({ result: value >>> 0, argc });
function state(r) {
  let value = states.get(r);
  if (!value) states.set(r, (value = { handle: 32512, count: 0, css: 'default' }));
  return value;
}
function publish(r, value) {
  const css = !value.handle || value.count < 0 ? 'none' : CURSOR_STYLES.get(value.handle);
  if (css !== value.css) {
    value.css = css;
    r.emit({ type: 'cursor', css });
  }
}
export function setCursor(r, handle) {
  handle >>>= 0;
  if (handle && !CURSOR_STYLES.has(handle)) {
    r.lastError = 1402;
    return 0;
  }
  const value = state(r),
    previous = value.handle;
  value.handle = handle;
  publish(r, value);
  return previous;
}
function load(r, a) {
  if (a(0)) throw Error('Packaged custom cursor resources are unsupported');
  const id = a(1) >>> 0;
  if (id > 0xffff) throw Error('Named system cursor resources are unsupported');
  if (!CURSOR_STYLES.has(id)) {
    r.lastError = 1814;
    return result(0, 2);
  }
  return result(id, 2);
}
export const cursorApis = {
  'user32.dll!LoadCursorA': load,
  'user32.dll!LoadCursorW': load,
  'user32.dll!SetCursor': (r, a) => result(setCursor(r, a(0)), 1),
  'user32.dll!GetCursor': (r) => result(state(r).handle, 0),
  'user32.dll!ShowCursor': (r, a) => {
    const value = state(r);
    value.count = (value.count + (a(0) ? 1 : -1)) | 0;
    publish(r, value);
    return result(value.count, 1);
  },
};
