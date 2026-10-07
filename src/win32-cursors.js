import { CURSOR_STYLES } from './cursors.js';
import { readPEResource } from './pe-resources.js';
import {
  iconForHandle,
  registerSharedCursor,
  rememberCursorSelection,
  destroyImageHandle,
} from './win32-icons.js';
import {
  parseGroupCursor,
  cursorCandidate,
  selectCursor,
  decodeCursorResource,
} from './cursor-resources.js';
const states = new WeakMap();
const result = (value, argc) => ({ result: value >>> 0, argc });
function state(r) {
  let value = states.get(r);
  if (!value)
    states.set(
      r,
      (value = {
        handle: 32512,
        count: 0,
        css: 'default',
        image: null,
        cache: new WeakMap(),
      }),
    );
  return value;
}
function publish(r, value) {
  const css =
    !value.handle || value.count < 0 ? 'none' : (CURSOR_STYLES.get(value.handle) ?? value.handle);
  if (css !== value.css) {
    value.css = css;
    if (typeof css === 'string') r.emit({ type: 'cursor', css });
    else {
      const image = value.image;
      r.emit({
        type: 'cursor',
        image: {
          ...image,
          pixels: image.pixels.slice(),
          ...(image.native
            ? {
                native: {
                  ...image.native,
                  mask: image.native.mask.slice(),
                  color: image.native.color.slice(),
                },
              }
            : {}),
        },
        handle: css,
      });
    }
  }
}
export function setCursor(r, handle) {
  handle >>>= 0;
  const image = handle && !CURSOR_STYLES.has(handle) ? iconForHandle(r, handle) : null;
  if (handle && !CURSOR_STYLES.has(handle) && !image) {
    r.lastError = 1402;
    return 0;
  }
  const value = state(r),
    previous = value.handle;
  value.handle = handle;
  value.image = image
    ? {
        ...image,
        hotX: image.hotX ?? Math.floor(image.width / 2),
        hotY: image.hotY ?? Math.floor(image.height / 2),
      }
    : null;
  rememberCursorSelection(r, handle);
  publish(r, value);
  return previous;
}
function load(r, a, wide) {
  if (a(0)) return loadResource(r, a, wide);
  const id = a(1) >>> 0;
  if (id > 0xffff) throw Error('Named system cursor resources are unsupported');
  if (!CURSOR_STYLES.has(id)) {
    r.lastError = 1814;
    return result(0, 2);
  }
  return result(id, 2);
}
function loadResource(r, a, wide) {
  const fail = (error) => {
    r.lastError = error;
    return result(0, 2);
  };
  const module = [...(r.graph?.modules?.values() ?? [])].find(
    (m) => !m.host && m.base === a(0) >>> 0,
  );
  if (!module?.bytes) return fail(6);
  let name;
  try {
    const p = a(1) >>> 0;
    name = p <= 0xffff ? p : wide ? r.wideString(p) : r.string(p);
  } catch {
    return fail(1814);
  }
  const value = state(r),
    key = typeof name + ':' + String(name).toLowerCase();
  let cache = value.cache.get(module);
  if (cache?.has(key)) return result(cache.get(key), 2);
  try {
    const group = readPEResource(module.bytes, 12, name);
    if (!group) return fail(1814);
    const entries = parseGroupCursor(group).map((entry) =>
      cursorCandidate(readPEResource(module.bytes, 1, entry.id), entry),
    );
    const selected = selectCursor(entries),
      image = decodeCursorResource(selected.resource, selected);
    const handle = registerSharedCursor(r, image);
    if (!cache) value.cache.set(module, (cache = new Map()));
    cache.set(key, handle);
    return result(handle, 2);
  } catch (error) {
    if (/unsupported|limit exceeded/i.test(error.message)) throw error;
    return fail(13);
  }
}
export const cursorApis = {
  'user32.dll!LoadCursorA': (r, a) => load(r, a, false),
  'user32.dll!LoadCursorW': (r, a) => load(r, a, true),
  'user32.dll!SetCursor': (r, a) => result(setCursor(r, a(0)), 1),
  'user32.dll!GetCursor': (r) => result(state(r).handle, 0),
  'user32.dll!DestroyCursor': (r, a) => result(destroyImageHandle(r, a(0)), 1),
  'user32.dll!ShowCursor': (r, a) => {
    const value = state(r);
    value.count = (value.count + (a(0) ? 1 : -1)) | 0;
    publish(r, value);
    return result(value.count, 1);
  },
};
