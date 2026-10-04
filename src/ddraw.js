import { createD3D7 } from './d3d7.js';
import { ComObjects, readGuid } from './com.js';
import { DDRAW_ABI } from './ddraw-abi.js';
import { frameForWindow } from './window-frame.js';
import { VIRTUAL_DISPLAY_MODES, currentDisplayMode } from './win32-display.js';

export const DD = {
  INVALID: 0x80070057,
  UNSUPPORTED: 0x80004001,
  BUSY: 0x887601ae,
  NOTLOCKED: 0x88760248,
  NOTFOUND: 0x887600ff,
};
const UNKNOWN = '00000000-0000-0000-c000-000000000046';
const DRAW_IDS = {
  1: '6c14db80-a733-11ce-a521-0020af0be560',
  7: '15e65ec0-3b9c-11d2-b92f-00609797ea5b',
};
const SURFACE_IDS = {
  1: '6c14db81-a733-11ce-a521-0020af0be560',
  7: '06675a80-3b9b-11d2-b92f-00609797ea5b',
};
const CAP = { PRIMARY: 0x200, BACK: 4, FLIP: 0x10, TEXTURE: 0x1000, Z: 0x20000, MIP: 0x400000 };
const MAX_BYTES = 32 * 1024 * 1024;
const states = new WeakMap();
export function directDrawState(r) {
  r.comObjects ??= new ComObjects(r);
  let s = states.get(r);
  if (!s) states.set(r, (s = { bytes: 0 }));
  return s;
}
export function ddObject(r, p, kind) {
  const o = r.comObjects?.objects.get(p);
  return o?.refs && o.state.kind === kind ? o : null;
}
const methods = (name, handlers) =>
  Object.fromEntries(
    DDRAW_ABI[name].map(([method, argc], slot) => [
      slot,
      {
        argc,
        invoke:
          handlers[method] ??
          ((r) => {
            r.emit?.({ type: 'log', text: `Unsupported ${name}.${method}` });
            return DD.UNSUPPORTED;
          }),
      },
    ]),
  );
export function writeDDPixelFormat(r, p, format) {
  r.check(p, 32, true);
  r.data.fill(0, p, p + 32);
  [32, ...format].forEach((v, i) => r.write32(p + i * 4, v));
}
export const ddFormat = (bits = 32) =>
  bits === 16 ? [0x40, 0, 16, 0xf800, 0x7e0, 0x1f, 0] : [0x40, 0, bits, 0xff0000, 0xff00, 0xff, 0];
function readFormat(r, p) {
  r.check(p, 32);
  if (r.read32(p) !== 32) return null;
  const f = Array.from({ length: 7 }, (_, i) => r.read32(p + 4 + i * 4));
  if (f.every((v, i) => v === [0x400, 0, 16, 0, 0xffff, 0, 0][i])) return f;
  if (!(f[0] & 0x40) || ![16, 24, 32].includes(f[2]) || f[0] & ~0x41 || f[1]) return null;
  // dwRGBAlphaBitMask is meaningful only with DDPF_ALPHAPIXELS. Callers
  // commonly leave union fields populated when asking for opaque RGB.
  if (!(f[0] & 1)) f[6] = 0;
  const masks = f.slice(3);
  if (masks.slice(0, 3).some((m) => !m) || !!(f[0] & 1) !== !!masks[3]) return null;
  const limit = 2 ** f[2] - 1;
  if (
    masks.some((m) => {
      if (!m) return false;
      const normalized = m >>> (31 - Math.clz32(m & -m));
      return m > limit || (normalized & (normalized + 1)) !== 0;
    })
  )
    return null;
  if (masks.some((m, i) => masks.slice(i + 1).some((n) => m & n))) return null;
  return f;
}
function descriptor(r, p, s, pointer = 0) {
  const size = r.read32(p);
  if (![108, 124].includes(size)) return DD.INVALID;
  r.check(p, size, true);
  r.data.fill(0, p, p + size);
  r.write32(p, size);
  r.write32(p + 4, 0x100f | (pointer ? 0x800 : 0));
  r.write32(p + 8, s.height);
  r.write32(p + 12, s.width);
  r.write32(p + 16, s.pitch);
  r.write32(p + 36, pointer);
  writeDDPixelFormat(r, p + 72, s.format);
  r.write32(p + 104, s.caps);
  if (size === 124) r.write32(p + 108, s.caps2 || 0);
  return 0;
}
const output = (r, p, value) => {
  if (!p) return DD.INVALID;
  r.write32(p, value);
  return 0;
};
function region(r, p, s) {
  if (!p) return { x: 0, y: 0, w: s.width, h: s.height };
  r.check(p, 16);
  const v = Array.from({ length: 4 }, (_, i) => r.view.getInt32(p + i * 4, true));
  if (v[0] < 0 || v[1] < 0 || v[2] > s.width || v[3] > s.height || v[0] >= v[2] || v[1] >= v[3])
    return null;
  return { x: v[0], y: v[1], w: v[2] - v[0], h: v[3] - v[1] };
}
function rawPixel(r, s, x, y) {
  const p = s.memory + y * s.pitch + x * s.bpp;
  let v = 0;
  for (let i = 0; i < s.bpp; i++) v |= r.data[p + i] << (8 * i);
  return v >>> 0;
}
function storePixel(r, s, x, y, v) {
  const p = s.memory + y * s.pitch + x * s.bpp;
  for (let i = 0; i < s.bpp; i++) r.data[p + i] = (v >>> (8 * i)) & 255;
}
const channel = (v, m) => {
  if (!m) return 255;
  const shift = 31 - Math.clz32(m & -m),
    max = m >>> shift;
  return Math.round((((v & m) >>> shift) * 255) / max);
};
const pack = (c, m) => {
  if (!m) return 0;
  const shift = 31 - Math.clz32(m & -m),
    max = m >>> shift;
  return (Math.round((c * max) / 255) << shift) >>> 0;
};
export function ddSurfacePixels(r, s) {
  const rgba = new Uint8ClampedArray(s.width * s.height * 4);
  for (let y = 0; y < s.height; y++)
    for (let x = 0; x < s.width; x++) {
      const v = rawPixel(r, s, x, y),
        p = (y * s.width + x) * 4;
      for (let i = 0; i < 3; i++) rgba[p + i] = channel(v, s.format[3 + i]);
      rgba[p + 3] = s.format[6] ? channel(v, s.format[6]) : 255;
    }
  return rgba;
}
export function setDDSurfacePixels(r, s, rgba) {
  if (rgba.length !== s.width * s.height * 4) throw Error('Invalid DirectDraw readback');
  for (let y = 0; y < s.height; y++)
    for (let x = 0; x < s.width; x++) {
      const p = (y * s.width + x) * 4;
      let v = 0;
      for (let i = 0; i < 4; i++) v |= pack(rgba[p + i], s.format[3 + i]);
      storePixel(r, s, x, y, v);
    }
  s.dirty = true;
  s.revision++;
}
async function present(r, s) {
  if (s.presentGPU) return s.presentGPU();
  const hwnd = s.clipper?.state.window || s.owner.window;
  if (!hwnd || !r.windows?.windows.has(hwnd)) return DD.INVALID;
  let pixels = ddSurfacePixels(r, s),
    width = s.width,
    height = s.height;
  if (!(s.owner.cooperative & 0x10)) {
    // Windowed primary coordinates are virtual-screen coordinates; display
    // only the client rectangle instead of stretching the entire screen.
    const window = r.windows.windows.get(hwnd);
    const rect = clipBounds(r, { window: hwnd });
    width = window.width;
    height = window.height;
    const client = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const sx = rect.x + x,
          sy = rect.y + y;
        if (sx >= 0 && sy >= 0 && sx < s.width && sy < s.height)
          client.set(
            pixels.subarray((sy * s.width + sx) * 4, (sy * s.width + sx) * 4 + 4),
            (y * width + x) * 4,
          );
      }
    pixels = client;
  }
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  r.emit?.({
    type: 'frame',
    windowId: hwnd,
    width,
    height,
    pixels,
    graphicsApi: 'directdraw',
    renderer: 'directdraw',
    graphicsFrames: ++s.owner.frames,
  });
  await new Promise((resolve) => setTimeout(resolve, 16));
  return 0;
}
export async function ddBlt(r, dst, dest, src, source, flags, fx) {
  const d = dst.state;
  if (d.presentGPU) return DD.UNSUPPORTED;
  if (d.locked || src?.state.locked) return DD.BUSY;
  const dr = region(r, dest, d),
    sr = src ? region(r, source, src.state) : null;
  if (!dr || (src && !sr)) return DD.INVALID;
  const clip = d.clipper ? clipBounds(r, d.clipper.state) : null;
  if (d.clipper && !clip) return DD.INVALID;
  const visible = (x, y) =>
    !clip || (x >= clip.x && x < clip.x + clip.w && y >= clip.y && y < clip.y + clip.h);
  if (flags & ~(0x1000000 | 0x8000000 | 0x400 | 0x8000)) return DD.UNSUPPORTED;
  if (flags & 0x400) {
    if (src || !fx) return DD.INVALID;
    r.check(fx, 100);
    if (r.read32(fx) !== 100) return DD.INVALID;
    const color = r.read32(fx + 80);
    for (let y = dr.y; y < dr.y + dr.h; y++)
      for (let x = dr.x; x < dr.x + dr.w; x++) if (visible(x, y)) storePixel(r, d, x, y, color);
  } else {
    if (!src) return DD.INVALID;
    if (src.state.syncGPU) await src.state.syncGPU();
    const s = src.state;
    const copy = new Uint32Array(sr.w * sr.h);
    for (let y = 0; y < sr.h; y++)
      for (let x = 0; x < sr.w; x++) copy[y * sr.w + x] = rawPixel(r, s, sr.x + x, sr.y + y);
    if (flags & 0x8000 && !s.sourceKey) return 0x887600d7;
    for (let y = 0; y < dr.h; y++)
      for (let x = 0; x < dr.w; x++) {
        if (!visible(dr.x + x, dr.y + y)) continue;
        let v = copy[Math.floor((y * sr.h) / dr.h) * sr.w + Math.floor((x * sr.w) / dr.w)];
        if (flags & 0x8000 && v >= s.sourceKey[0] && v <= s.sourceKey[1]) continue;
        if (s.format.some((v, i) => v !== d.format[i])) {
          let converted = 0;
          for (let i = 0; i < 4; i++)
            converted |= pack(channel(v, s.format[3 + i]), d.format[3 + i]);
          v = converted;
        }
        storePixel(r, d, dr.x + x, dr.y + y, v);
      }
  }
  d.dirty = true;
  d.revision++;
  if (d.caps & CAP.PRIMARY) return present(r, d);
  return 0;
}
function reaches(source, target, seen = new Set()) {
  if (source === target) return true;
  if (seen.has(source)) return false;
  seen.add(source);
  return [...source.attachments].some((o) => reaches(o.state, target, seen));
}
function clipBounds(r, clipper) {
  const w = r.windows?.windows.get(clipper.window);
  if (!w) return null;
  const [x, y] = r.windows.screenPosition(w),
    { border, title } = frameForWindow(w);
  return {
    x: x + border,
    y: y + border + title,
    w: w.visible ? w.width : 0,
    h: w.visible ? w.height : 0,
  };
}
export async function createDDSurface(
  r,
  owner,
  { width, height, format, caps, caps2 = 0, backCount = 0, version = 7 },
) {
  if (!width || !height || width > 2048 || height > 2048 || backCount > 1) return null;
  const bpp = format[2] / 8,
    pitch = (width * bpp + 3) & ~3,
    size = pitch * height,
    total = directDrawState(r);
  if (total.bytes + size * (1 + backCount) > MAX_BYTES) return null;
  const memory = r.allocate(size, true);
  total.bytes += size;
  const s = {
    kind: 'dd-surface',
    owner,
    width,
    height,
    format: format.slice(),
    caps,
    caps2,
    bpp,
    pitch,
    memory,
    size,
    locked: null,
    attachments: new Set(),
    sourceKey: null,
    dirty: true,
    revision: 0,
  };
  r.comObjects.retain(owner.object);
  let surface;
  const views = [],
    lifetime = { refs: 1 };
  for (const v of [1, 7]) {
    const abi =
      v === 7 ? DDRAW_ABI.IDirectDrawSurface7 : DDRAW_ABI.IDirectDrawSurface7.slice(0, 36);
    const name = v === 7 ? 'IDirectDrawSurface7' : 'IDirectDrawSurface';
    views.push(
      r.comObjects.create({
        name,
        iid: SURFACE_IDS[v],
        methodNames: abi.map((x) => x[0]),
        state: s,
        queryInterface: (iid) => (iid === UNKNOWN ? surface : views.find((o) => o.iid === iid)),
        methods: Object.fromEntries(
          Object.entries(
            methods('IDirectDrawSurface7', {
              GetSurfaceDesc: (r, a) =>
                r.read32(a(1)) === (v === 7 ? 124 : 108) ? descriptor(r, a(1), s) : DD.INVALID,
              GetPixelFormat: (r, a) => {
                writeDDPixelFormat(r, a(1), s.format);
                return 0;
              },
              GetCaps: (r, a) => {
                r.check(a(1), v === 7 ? 16 : 4, true);
                r.data.fill(0, a(1), a(1) + (v === 7 ? 16 : 4));
                r.write32(a(1), s.caps);
                if (v === 7) r.write32(a(1) + 4, s.caps2);
                return 0;
              },
              Lock: async (r, a) => {
                if (s.locked) return DD.BUSY;
                if (
                  r.read32(a(2)) !== (v === 7 ? 124 : 108) ||
                  a(4) ||
                  a(3) & ~(1 | 0x10 | 0x20 | 0x800 | 0x1000 | 0x2000 | 0x4000)
                )
                  return DD.INVALID;
                if (s.presentGPU && !(a(3) & 0x10)) return DD.UNSUPPORTED;
                const rect = region(r, a(1), s);
                if (!rect) return DD.INVALID;
                if (s.syncGPU) await s.syncGPU();
                const hr = descriptor(r, a(2), s, s.memory + rect.y * s.pitch + rect.x * s.bpp);
                if (!hr) s.locked = { rect, readonly: !!(a(3) & 0x10) };
                return hr;
              },
              Unlock: () => {
                if (!s.locked) return DD.NOTLOCKED;
                if (!s.locked.readonly) {
                  s.dirty = true;
                  s.revision++;
                }
                s.locked = null;
                return 0;
              },
              Blt: (r, a) => {
                const src = a(2) ? ddObject(r, a(2), 'dd-surface') : null;
                if (a(2) && !src) return DD.INVALID;
                return ddBlt(r, surface, a(1), src, a(3), a(4), a(5));
              },
              BltFast: async (r, a) => {
                const src = ddObject(r, a(3), 'dd-surface');
                if (!src || a(5) & ~0x11) return DD.INVALID;
                const sr = region(r, a(4), src.state);
                if (!sr) return DD.INVALID;
                const p = r.allocate(16);
                [a(1), a(2), a(1) + sr.w, a(2) + sr.h].forEach((v, i) => r.write32(p + i * 4, v));
                try {
                  return await ddBlt(r, surface, p, src, a(4), a(5) & 1 ? 0x8000 : 0, 0);
                } finally {
                  r.free(p);
                }
              },
              AddAttachedSurface: (r, a) => {
                const attached = ddObject(r, a(1), 'dd-surface');
                if (
                  !attached ||
                  attached.state === s ||
                  reaches(attached.state, s) ||
                  s.attachments.has(attached) ||
                  attached.state.owner !== owner
                )
                  return DD.INVALID;
                r.comObjects.retain(attached);
                s.attachments.add(attached);
                return 0;
              },
              DeleteAttachedSurface: async (r, a) => {
                const attached = ddObject(r, a(2), 'dd-surface');
                if (a(1) || !s.attachments.delete(attached)) return DD.NOTFOUND;
                await r.comObjects.release(attached);
                return 0;
              },
              GetAttachedSurface: (r, a) => {
                r.check(a(1), v === 7 ? 16 : 4);
                if (!a(2)) return DD.INVALID;
                r.write32(a(2), 0);
                const caps = r.read32(a(1));
                const attached = [...s.attachments].find((o) => (o.state.caps & caps) === caps);
                if (!attached) return DD.NOTFOUND;
                const view = attached.state.views[v === 7 ? 1 : 0];
                r.comObjects.retain(view);
                r.write32(a(2), view.pointer);
                return 0;
              },
              EnumAttachedSurfaces: async (r, a) => {
                if (!a(2)) return DD.INVALID;
                const p = r.allocate(v === 7 ? 124 : 108);
                try {
                  for (const o of s.attachments) {
                    r.write32(p, v === 7 ? 124 : 108);
                    descriptor(r, p, o.state);
                    const view = o.state.views[v === 7 ? 1 : 0];
                    r.comObjects.retain(view);
                    if (!(await r.callGuest(a(2), [view.pointer, p, a(1)]))) break;
                  }
                  return 0;
                } finally {
                  r.free(p);
                }
              },
              Flip: async (r, a) => {
                if (!(s.caps & CAP.FLIP) || a(2) & ~1) return DD.UNSUPPORTED;
                const back = a(1)
                  ? ddObject(r, a(1), 'dd-surface')
                  : [...s.attachments].find((o) => o.state.caps & CAP.BACK);
                if (
                  !back ||
                  !s.attachments.has(back) ||
                  back.state.owner !== owner ||
                  back.state.width !== s.width ||
                  back.state.height !== s.height
                )
                  return DD.INVALID;
                if (s.locked || back.state.locked) return DD.BUSY;
                if (back.state.presentGPU) {
                  await back.state.syncGPU();
                  [s.memory, back.state.memory] = [back.state.memory, s.memory];
                  return back.state.presentGPU();
                }
                [s.memory, back.state.memory] = [back.state.memory, s.memory];
                return present(r, s);
              },
              SetColorKey: (r, a) => {
                if (![8, 12].includes(a(1))) return DD.UNSUPPORTED;
                if (!a(2)) {
                  s.sourceKey = null;
                  return 0;
                }
                r.check(a(2), 8);
                const low = r.read32(a(2)),
                  high = a(1) & 4 ? r.read32(a(2) + 4) : low;
                if (low > high || high >= 2 ** s.format[2]) return DD.INVALID;
                s.sourceKey = [low, high];
                return 0;
              },
              GetColorKey: (r, a) => {
                if (a(1) !== 8 || !s.sourceKey) return 0x887600d7;
                s.sourceKey.forEach((v, i) => r.write32(a(2) + i * 4, v));
                return 0;
              },
              SetClipper: async (r, a) => {
                const clipper = a(1) ? ddObject(r, a(1), 'dd-clipper') : null;
                if (a(1) && !clipper) return DD.INVALID;
                if (clipper) r.comObjects.retain(clipper);
                if (s.clipper) await r.comObjects.release(s.clipper);
                s.clipper = clipper;
                return 0;
              },
              GetClipper: (r, a) => {
                if (!a(1)) return DD.INVALID;
                r.write32(a(1), 0);
                if (!s.clipper) return 0x88760238;
                r.comObjects.retain(s.clipper);
                return output(r, a(1), s.clipper.pointer);
              },
              IsLost: () => 0,
              Restore: () => 0,
              GetBltStatus: (r, a) => (a(1) & ~3 ? DD.INVALID : 0),
              GetFlipStatus: (r, a) => (a(1) & ~3 ? DD.INVALID : 0),
              GetDDInterface: (r, a) => {
                if (!a(1)) return DD.INVALID;
                const view = owner.views[v === 7 ? 1 : 0];
                r.comObjects.retain(view);
                r.write32(a(1), view.pointer);
                return 0;
              },
              SetPrivateData: (r, a) => {
                if (a(4)) return DD.UNSUPPORTED;
                const key = readGuid(r, a(1)),
                  bytes = a(3);
                if (bytes > 65536 || (!a(2) && bytes)) return DD.INVALID;
                if (bytes) r.check(a(2), bytes);
                s.privateData ??= new Map();
                const old = s.privateData.get(key)?.length ?? 0;
                if (
                  (!s.privateData.has(key) && s.privateData.size >= 256) ||
                  (total.privateBytes ?? 0) - old + bytes > 1024 * 1024
                )
                  return 0x8007000e;
                s.privateData.set(key, r.data.slice(a(2), a(2) + bytes));
                total.privateBytes = (total.privateBytes ?? 0) - old + bytes;
                return 0;
              },
              GetPrivateData: (r, a) => {
                if (!a(3)) return DD.INVALID;
                const key = readGuid(r, a(1)),
                  bytes = s.privateData?.get(key);
                if (!bytes) return DD.NOTFOUND;
                const capacity = r.read32(a(3));
                r.write32(a(3), bytes.length);
                if (capacity < bytes.length || (!a(2) && bytes.length)) return 0x887602b2; // DDERR_MOREDATA.
                if (bytes.length) {
                  r.check(a(2), bytes.length, true);
                  r.data.set(bytes, a(2));
                }
                return 0;
              },
              FreePrivateData: (r, a) => {
                const key = readGuid(r, a(1)),
                  bytes = s.privateData?.get(key);
                if (!bytes) return DD.NOTFOUND;
                s.privateData.delete(key);
                total.privateBytes -= bytes.length;
                return 0;
              },
            }),
          ).filter(([slot]) => Number(slot) < abi.length),
        ),
        onRelease: async () => {
          r.comObjects.liveObjects -= views.length - 1;
          if (s.clipper) await r.comObjects.release(s.clipper);
          for (const o of s.attachments) await r.comObjects.release(o);
          s.attachments.clear();
          for (const bytes of s.privateData?.values() ?? []) total.privateBytes -= bytes.length;
          s.privateData?.clear();
          await s.releaseGPU?.();
          for (const t of s.textures?.values() ?? []) if (t.refs) await r.comObjects.release(t);
          r.free(s.memory);
          total.bytes -= size;
          await r.comObjects.release(owner.object);
        },
      }),
    );
  }
  for (const view of views)
    Object.defineProperty(view, 'refs', {
      get: () => lifetime.refs,
      set: (v) => {
        lifetime.refs = v;
      },
    });
  s.views = views;
  surface = views[version === 7 ? 1 : 0];
  if (backCount) {
    const back = await createDDSurface(r, owner, {
      width,
      height,
      format,
      caps: (caps & ~CAP.PRIMARY) | CAP.BACK,
      caps2,
      version,
    });
    if (!back) {
      await r.comObjects.release(surface);
      return null;
    }
    s.attachments.add(back);
  }
  return surface;
}
function clipper(r) {
  return r.comObjects.create({
    name: 'IDirectDrawClipper',
    iid: '6c14db85-a733-11ce-a521-0020af0be560',
    methodNames: DDRAW_ABI.IDirectDrawClipper.map((x) => x[0]),
    state: { kind: 'dd-clipper', window: 0 },
    methods: methods('IDirectDrawClipper', {
      SetHWnd: (r, a, o) => {
        if (a(1) || (a(2) && !r.windows?.windows.has(a(2)))) return DD.INVALID;
        o.state.window = a(2);
        return 0;
      },
      GetHWnd: (r, a, o) => output(r, a(1), o.state.window),
      IsClipListChanged: (r, a) => output(r, a(1), 0),
    }),
  });
}
function drawMethods(owner, version) {
  const descSize = version === 7 ? 124 : 108;
  return {
    SetCooperativeLevel: (r, a) => {
      if (a(1) && !r.windows?.windows.has(a(1))) return DD.INVALID;
      if (a(2) & ~(1 | 2 | 4 | 8 | 0x10 | 0x20 | 0x40 | 0x80 | 0x100 | 0x200 | 0x400 | 0x800))
        return DD.INVALID;
      owner.window = a(1);
      owner.cooperative = a(2);
      return 0;
    },
    SetDisplayMode: async (r, a) => {
      if (![16, 24, 32].includes(a(3)) || !a(1) || !a(2) || a(1) > 2048 || a(2) > 2048)
        return DD.INVALID;
      if (version === 7 && ((a(4) && a(4) !== 60) || a(5))) return DD.UNSUPPORTED;
      owner.previousMode ??= currentDisplayMode(r);
      owner.mode = { ...currentDisplayMode(r), width: a(1), height: a(2), bitsPerPixel: a(3) };
      r.displayMode = owner.mode;
      const window = r.windows?.windows.get(owner.window);
      if (window?.showCmd === 3 && owner.cooperative & 0x10) {
        const args = [window.id, 0, 0, 0, owner.mode.width, owner.mode.height, 0x14];
        await r.apiProvider.get('user32.dll!SetWindowPos')(r, (i) => args[i]);
      }
      return 0;
    },
    RestoreDisplayMode: (r) => {
      if (r.displayMode === owner.mode) r.displayMode = owner.previousMode;
      owner.mode = null;
      owner.previousMode = null;
      return 0;
    },
    GetDisplayMode: (r, a) => {
      if (r.read32(a(1)) !== descSize) return DD.INVALID;
      const mode = owner.mode ?? currentDisplayMode(r);
      return descriptor(r, a(1), {
        width: mode.width,
        height: mode.height,
        pitch: ((mode.width * mode.bitsPerPixel) / 8 + 3) & ~3,
        format: ddFormat(mode.bitsPerPixel),
        caps: CAP.PRIMARY,
      });
    },
    CreateSurface: async (r, a) => {
      if (!a(2) || a(3)) return DD.INVALID;
      r.write32(a(2), 0);
      r.check(a(1), descSize);
      if (r.read32(a(1)) !== descSize) return DD.INVALID;
      const flags = r.read32(a(1) + 4),
        caps = r.read32(a(1) + 104),
        mode = owner.mode ?? currentDisplayMode(r);
      const format = flags & 0x1000 ? readFormat(r, a(1) + 72) : ddFormat(mode.bitsPerPixel);
      if (!format) return 0x88760091;
      if (
        flags & ~(1 | 2 | 4 | 0x20 | 0x1000 | 0x100000) ||
        caps & ~(4 | 8 | 0x10 | 0x20 | 0x40 | 0x200 | 0x800 | 0x1000 | 0x2000 | 0x4000 | 0x20000) ||
        (version === 7 && r.read32(a(1) + 108) & ~(0x1000 | 0x10))
      )
        return DD.UNSUPPORTED;
      if (flags & 0x100000 && (version !== 7 || !(caps & CAP.TEXTURE) || r.read32(a(1) + 120) >= 8))
        return DD.INVALID;
      if (version === 7 && r.read32(a(1) + 108) & 0x10 && !(caps & CAP.TEXTURE)) return DD.INVALID;
      const o = await createDDSurface(r, owner, {
        width: flags & 4 ? r.read32(a(1) + 12) : mode.width,
        height: flags & 2 ? r.read32(a(1) + 8) : mode.height,
        format,
        caps,
        caps2: version === 7 ? r.read32(a(1) + 108) : 0,
        version,
        backCount: flags & 0x20 ? r.read32(a(1) + 20) : 0,
      });
      if (!o) return 0x8007000e;
      r.write32(a(2), o.pointer);
      return 0;
    },
    CreateClipper: (r, a) => {
      if (a(1) || a(3) || !a(2)) return DD.INVALID;
      return output(r, a(2), clipper(r).pointer);
    },
    EnumDisplayModes: async (r, a) => {
      if (a(1) & ~3 || !a(4)) return DD.INVALID;
      if (a(2) && r.read32(a(2)) !== descSize) return DD.INVALID;
      if (a(2)) r.check(a(2), descSize);
      const p = r.allocate(descSize);
      try {
        for (const mode of VIRTUAL_DISPLAY_MODES) {
          if (a(2)) {
            const f = r.read32(a(2) + 4);
            if (f & ~(2 | 4 | 0x1000)) return DD.UNSUPPORTED;
            if (
              (f & 2 && r.read32(a(2) + 8) !== mode.height) ||
              (f & 4 && r.read32(a(2) + 12) !== mode.width) ||
              (f & 0x1000 && r.read32(a(2) + 84) !== mode.bitsPerPixel)
            )
              continue;
          }
          r.write32(p, descSize);
          descriptor(r, p, {
            width: mode.width,
            height: mode.height,
            pitch: ((mode.width * mode.bitsPerPixel) / 8 + 3) & ~3,
            format: ddFormat(mode.bitsPerPixel),
            caps: 0,
          });
          if (!(await r.callGuest(a(4), [p, a(3)]))) break;
        }
        return 0;
      } finally {
        r.free(p);
      }
    },
    GetCaps: (r, a) => {
      for (const p of [a(1), a(2)]) {
        if (!p) continue;
        const size = r.read32(p);
        if (size < 172 || size > 380) return DD.INVALID;
        r.check(p, size, true);
        r.data.fill(0, p, p + size);
        r.write32(p, size);
        r.write32(p + 4, 0x1 | 0x40 | 0x200 | 0x400000 | 0x4000000);
        r.write32(p + 12, 0x200); // DDCKEYCAPS_SRCBLT.
        r.write32(p + 16, 0x14000); // DDFXCAPS_BLTSTRETCHX/Y.
        r.write32(p + 56, 0x400); // DDBD_16 depth.
        r.write32(p + 132, 0x27a7c); // bounded surface caps.
        r.write32(p + 20, 0);
        r.write32(p + 60, MAX_BYTES);
        r.write32(p + 64, MAX_BYTES - directDrawState(r).bytes);
      }
      return 0;
    },
    GetAvailableVidMem: (r, a) => {
      if (a(2)) r.write32(a(2), MAX_BYTES);
      if (a(3)) r.write32(a(3), MAX_BYTES - directDrawState(r).bytes);
      return 0;
    },
    GetFourCCCodes: (r, a) => output(r, a(1), 0),
    GetDeviceIdentifier: (r, a) => {
      // The virtual adapter has no PCI vendor or WHQL certification. Its
      // identity describes this renderer rather than a host graphics card.
      const p = a(1);
      if (!p || a(2) & ~1) return DD.INVALID;
      try {
        r.check(p, 1072, true);
      } catch {
        return DD.INVALID;
      }
      r.data.fill(0, p, p + 1072);
      r.data.set(new TextEncoder().encode('winebrowser-webgpu'), p);
      r.data.set(new TextEncoder().encode('WineBrowser WebGPU Adapter'), p + 512);
      r.data.set([0x57, 0x42, 0x47, 0x50, 0x55, 0, 0, 0x40, 0x80, 0, 0, 0, 0, 0, 0, 1], p + 1048);
      return 0;
    },
    GetMonitorFrequency: (r, a) => output(r, a(1), 60),
    GetVerticalBlankStatus: (r, a) => output(r, a(1), 0),
    GetScanLine: (r, a) => output(r, a(1), 0),
    TestCooperativeLevel: () => 0,
    RestoreAllSurfaces: () => 0,
    WaitForVerticalBlank: async (r, a) => {
      if (a(1) & ~5 || a(2)) return DD.INVALID;
      await new Promise((res) => setTimeout(res, 16));
      return 0;
    },
  };
}
function factory(r, version) {
  directDrawState(r);
  const owner = { kind: 'ddraw', window: 0, mode: null, frames: 0, version };
  const views = [],
    lifetime = { refs: 1 };
  owner.query = (iid) => (iid === UNKNOWN ? owner.object : views.find((o) => o.iid === iid));
  owner.dispose = () => {
    if (r.displayMode === owner.mode) r.displayMode = owner.previousMode;
    r.comObjects.liveObjects -= views.length - 1;
  };
  for (const v of [1, 7]) {
    const name = v === 7 ? 'IDirectDraw7' : 'IDirectDraw';
    views.push(
      r.comObjects.create({
        name,
        iid: DRAW_IDS[v],
        methodNames: DDRAW_ABI[name].map((x) => x[0]),
        state: owner,
        methods: methods(name, drawMethods(owner, v)),
        queryInterface: (iid) =>
          iid === UNKNOWN ? owner.object : views.find((o) => o.iid === iid),
        onRelease: owner.dispose,
      }),
    );
  }
  views.push(createD3D7(r, owner));
  // DirectDraw and Direct3D are views of one COM identity/lifetime.
  for (const view of views)
    Object.defineProperty(view, 'refs', {
      get: () => lifetime.refs,
      set: (v) => {
        lifetime.refs = v;
      },
    });
  owner.views = views;
  owner.object = views[version === 7 ? 1 : 0];
  return owner.object;
}
export const ddrawApis = {
  'ddraw.dll!DirectDrawCreateEx': (r, a) => {
    if (!a(1)) return { result: DD.INVALID, argc: 4 };
    r.write32(a(1), 0);
    if (a(3)) return { result: 0x80040110, argc: 4 };
    if (a(0)) return { result: DD.INVALID, argc: 4 };
    if (readGuid(r, a(2)) !== DRAW_IDS[7]) return { result: 0x80004002, argc: 4 };
    r.write32(a(1), factory(r, 7).pointer);
    return { result: 0, argc: 4 };
  },
  'ddraw.dll!DirectDrawCreate': (r, a) => {
    if (!a(1)) return { result: DD.INVALID, argc: 3 };
    r.write32(a(1), 0);
    if (a(0) || a(2)) return { result: DD.INVALID, argc: 3 };
    r.write32(a(1), factory(r, 1).pointer);
    return { result: 0, argc: 3 };
  },
  'ddraw.dll!DirectDrawCreateClipper': (r, a) => {
    directDrawState(r);
    if (a(0) || a(2) || !a(1)) return { result: DD.INVALID, argc: 3 };
    r.write32(a(1), clipper(r).pointer);
    return { result: 0, argc: 3 };
  },
};
for (const suffix of ['A', 'W', 'ExA', 'ExW'])
  ddrawApis['ddraw.dll!DirectDrawEnumerate' + suffix] = async (r, a) => {
    const argc = suffix.startsWith('Ex') ? 3 : 2;
    if (!a(0) || (argc === 3 && a(2) & ~7)) return { result: DD.INVALID, argc };
    const wide = suffix.endsWith('W'),
      text = 'WineBrowser DirectDraw',
      bytes = (text.length + 1) * (wide ? 2 : 1),
      p = r.allocate(bytes, true);
    for (let i = 0; i < text.length; i++) {
      if (wide) r.view.setUint16(p + i * 2, text.charCodeAt(i), true);
      else r.data[p + i] = text.charCodeAt(i);
    }
    try {
      await r.callGuest(a(0), [0, p, p, a(1), ...(argc === 3 ? [0] : [])]);
      return { result: 0, argc };
    } finally {
      r.free(p);
    }
  };
