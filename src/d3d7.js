import { ComObjects, readGuid } from './com.js';
import { DDRAW_ABI } from './ddraw-abi.js';
import { d3d9Apis } from './d3d9.js';
import { deviceCaps } from './d3d-caps.js';
import { fvfLayout } from './d3d-fvf.js';
import { readTargetPixels } from './d3d9-targets.js';
import { invalidate } from './d3d9-textures.js';
import {
  DD,
  ddObject,
  ddFormat,
  writeDDPixelFormat,
  ddSurfacePixels,
  setDDSurfacePixels,
  ddBlt,
} from './ddraw.js';
const IID = 'f5049e77-4861-11d2-a407-00a0c90629a8';
const HAL = '84e63de0-46aa-11cf-816f-0000c020156e';
const TNL = 'f5049e78-4861-11d2-a407-00a0c90629a8';
const DEVICE = 'f5049e79-4861-11d2-a407-00a0c90629a8';
const VERTEX_BUFFER = 'f5049e7d-4861-11d2-a407-00a0c90629a8';
const primitives = (type, n) =>
  type === 4 && n % 3 === 0 ? n / 3 : [5, 6].includes(type) && n >= 3 ? n - 2 : null;
export function callD3D(r, object, slot, ...args) {
  const thunk = r.thunks.get(r.read32(object.vtable + slot * 4));
  return thunk.invoke(r, (i) => [object.pointer, ...args][i]).then((v) => v.result >>> 0);
}
function table(name, handlers) {
  return Object.fromEntries(
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
}
function guid(r, p, text) {
  const [a, b, c, ...d] = text.split('-');
  r.write32(p, parseInt(a, 16));
  r.view.setUint16(p + 4, parseInt(b, 16), true);
  r.view.setUint16(p + 6, parseInt(c, 16), true);
  const rest = d.join('');
  for (let i = 0; i < 8; i++) r.data[p + 8 + i] = parseInt(rest.slice(i * 2, i * 2 + 2), 16);
}
function createVertexBuffer(r, owner, factory, a) {
  const desc = a(1),
    out = a(2);
  if (!out) return DD.INVALID;
  r.write32(out, 0);
  if (!desc || a(3)) return DD.INVALID;
  r.check(desc, 16);
  const caps = r.read32(desc + 4),
    fvf = r.read32(desc + 8),
    count = r.read32(desc + 12);
  const layout = fvfLayout(fvf);
  if (r.read32(desc) !== 16 || caps & ~0x10801 || !layout || !count) return DD.INVALID;
  const bytes = count * layout.size;
  if (!Number.isSafeInteger(bytes) || bytes + (r.d3d7VertexBytes ?? 0) > 16 * 1024 * 1024)
    return 0x8007000e;
  const memory = r.allocate(bytes, true);
  r.d3d7VertexBytes = (r.d3d7VertexBytes ?? 0) + bytes;
  r.comObjects.retain(factory);
  const state = {
    kind: 'd3d7-vertex-buffer',
    owner,
    caps,
    fvf,
    count,
    layout,
    bytes,
    memory,
    locked: false,
  };
  const buffer = r.comObjects.create({
    name: 'IDirect3DVertexBuffer7',
    iid: VERTEX_BUFFER,
    methodNames: DDRAW_ABI.IDirect3DVertexBuffer7.map((x) => x[0]),
    state,
    methods: table('IDirect3DVertexBuffer7', {
      Lock: (r, a) => {
        if (!a(2) || a(1) & ~0x3831 || (a(1) & 0x30) === 0x30) return DD.INVALID;
        if (state.locked) return DD.BUSY;
        r.check(a(2), 4, true);
        if (a(3)) r.check(a(3), 4, true);
        r.write32(a(2), memory);
        if (a(3)) r.write32(a(3), bytes);
        state.locked = true;
        return 0;
      },
      Unlock: () => {
        if (!state.locked) return DD.NOTLOCKED;
        state.locked = false;
        return 0;
      },
      GetVertexBufferDesc: (r, a) => {
        if (!a(1) || r.read32(a(1)) !== 16) return DD.INVALID;
        r.check(a(1), 16, true);
        [16, state.caps, fvf, count].forEach((v, i) => r.write32(a(1) + i * 4, v));
        return 0;
      },
      Optimize: (r, a) => {
        const device = ddObject(r, a(1), 'd3d7-device');
        if (!device || device.state.owner !== owner || a(2)) return DD.INVALID;
        if (state.locked) return DD.BUSY;
        state.caps = (state.caps | 0x80000000) >>> 0;
        return 0;
      },
    }),
    onRelease: async () => {
      r.free(memory);
      r.d3d7VertexBytes -= bytes;
      await r.comObjects.release(factory);
    },
  });
  r.write32(out, buffer.pointer);
  return 0;
}
export function writeD3D7Caps(r, p) {
  r.check(p, 236, true);
  r.data.fill(0, p, p + 236);
  const c = deviceCaps(9);
  r.write32(p, c[7]);
  r.write32(p + 4, 56); // Lines remain unadvertised.
  for (const base of [60]) {
    [
      56,
      c[8] & 0x78,
      c[9],
      c[10],
      c[11] & 0x1fff,
      c[12] & 0x7ff,
      0xff,
      c[14],
      0x5, // PERSPECTIVE | ALPHA; 2D level-zero textures only.
      0x03000303, // Point/linear MIN/MAG; no mip chains.
      0, // Legacy texture blend modes are not implemented.
      c[19],
      0,
      0,
    ].forEach((v, i) => r.write32(p + base + i * 4, v));
  }
  for (const [offset, value] of [
    [116, 0x500],
    [120, 0x400],
    [124, 1],
    [128, 1],
    [132, 2048],
    [136, 2048],
    [140, 2048],
    [144, 2048],
    [148, 1],
    [172, 0], // Only D16 is exposed, so no stencil attachment.
    [176, 8],
    [180, c[36]],
    [188, 8],
    [216, c[39]],
  ])
    r.write32(p + offset, value);
  r.view.setUint16(p + 184, 8, true);
  r.view.setUint16(p + 186, 8, true);
  r.view.setFloat32(p + 192, 1e10, true);
  guid(r, p + 196, HAL);
}
async function texture(r, surface, device) {
  const s = surface.state;
  if (!(s.caps & 0x1000) || s.locked) return null;
  s.textures ??= new Map();
  let t = s.textures.get(device.pointer);
  if (!t) {
    const out = r.allocate(4);
    try {
      if (await callD3D(r, device, 23, s.width, s.height, 1, 0, 21, 1, out, 0)) return null;
      t = r.comObjects.objects.get(r.read32(out));
      s.textures.set(device.pointer, t);
    } finally {
      r.free(out);
    }
  }
  // DirectDraw format conversion is shared with CPU presentation. D3D9 texture
  // storage is BGRA, while the shared renderer consumes decoded RGBA snapshots.
  if (t.state.ddRevision === s.revision) return t;
  const pixels = ddSurfacePixels(r, s),
    level = t.state.levels[0],
    base = t.state.base;
  for (let y = 0; y < s.height; y++)
    for (let x = 0; x < s.width; x++) {
      const p = (y * s.width + x) * 4,
        q = base + level.offset + y * level.pitch + x * 4;
      r.data.set([pixels[p + 2], pixels[p + 1], pixels[p], pixels[p + 3]], q);
    }
  t.state.ddRevision = s.revision;
  invalidate(t);
  return t;
}
async function createDevice(r, owner, factory, a) {
  const target = ddObject(r, a(2), 'dd-surface'),
    out = a(3);
  if (!out) return DD.INVALID;
  r.write32(out, 0);
  if (
    !target ||
    target.state.owner !== owner ||
    ![HAL, TNL].includes(readGuid(r, a(1))) ||
    !owner.window
  )
    return DD.INVALID;
  if (target.state.presentGPU || target.state.locked || !(target.state.caps & 0x2000))
    return DD.INVALID;
  const ts = target.state,
    hasDepth = [...ts.attachments].some((o) => o.state.caps & 0x20000),
    params = r.allocate(56, true),
    ptr = r.allocate(4);
  let nativeFactory, native;
  try {
    nativeFactory = r.comObjects.objects.get(
      d3d9Apis['d3d9.dll!Direct3DCreate9'](r, () => 32).result,
    );
    [
      ts.width,
      ts.height,
      ts.format[2] === 16 ? 23 : 22,
      1,
      0,
      0,
      1,
      owner.window,
      1,
      hasDepth ? 1 : 0,
      hasDepth ? 80 : 0,
      0,
      0,
      0,
    ].forEach((v, i) => r.write32(params + i * 4, v));
    const hr = await callD3D(r, nativeFactory, 16, 0, 1, owner.window, 0x20, params, ptr);
    if (hr) return hr;
    native = r.comObjects.objects.get(r.read32(ptr));
  } finally {
    r.free(params);
    r.free(ptr);
    if (nativeFactory) await r.comObjects.release(nativeFactory);
  }
  r.comObjects.retain(factory);
  r.comObjects.retain(target);
  const state = {
    kind: 'd3d7-device',
    native,
    factory,
    target,
    owner,
    textures: new Map(),
    cachedSurfaces: new Set(),
    legacyClipping: true,
  };
  await callD3D(r, native, 57, 7, hasDepth ? 1 : 0); // D3D7 ZENABLE follows the attachment.
  await callD3D(r, native, 69, 0, 7, 0); // D3DTFP_NONE -> D3DTEXF_NONE.
  ts.presentGPU = () => callD3D(r, native, 17, 0, 0, 0, 0);
  ts.syncGPU = async () =>
    setDDSurfacePixels(
      r,
      ts,
      await readTargetPixels(r, native, native.state.renderTarget, { store: false }),
    );
  const refreshTextures = async () => {
    if (ts.locked) return DD.BUSY;
    for (const surface of state.textures.values())
      if (surface && !(await texture(r, surface, native))) return DD.BUSY;
    return 0;
  };
  const h = {
    GetCaps: (r, a) => {
      writeD3D7Caps(r, a(1));
      return 0;
    },
    EnumTextureFormats: async (r, a) => {
      if (!a(1)) return DD.INVALID;
      const p = r.allocate(32);
      try {
        for (const f of [
          ddFormat(32),
          [0x41, 0, 32, 0xff0000, 0xff00, 0xff, 0xff000000],
          ddFormat(16),
          [0x41, 0, 16, 0x7c00, 0x3e0, 0x1f, 0x8000],
          [0x41, 0, 16, 0xf00, 0xf0, 0xf, 0xf000],
        ]) {
          writeDDPixelFormat(r, p, f);
          if (!(await r.callGuest(a(1), [p, a(2)]))) break;
        }
        return 0;
      } finally {
        r.free(p);
      }
    },
    GetDirect3D: (r, a) => {
      if (!a(1)) return DD.INVALID;
      r.comObjects.retain(factory);
      r.write32(a(1), factory.pointer);
      return 0;
    },
    GetRenderTarget: (r, a) => {
      if (!a(1)) return DD.INVALID;
      r.comObjects.retain(state.target);
      r.write32(a(1), state.target.pointer);
      return 0;
    },
    SetRenderTarget: (r, a) => (a(1) === target.pointer && !a(2) ? 0 : DD.UNSUPPORTED),
    SetTransform: (r, a) => callD3D(r, native, 44, a(1) === 1 ? 256 : a(1), a(2)),
    GetTransform: (r, a) => callD3D(r, native, 45, a(1) === 1 ? 256 : a(1), a(2)),
    DrawPrimitive: async (r, a) => {
      if (a(5)) return DD.INVALID;
      const layout = fvfLayout(a(2)),
        count = primitives(a(1), a(4));
      if (!layout || count === null || (!state.legacyClipping && !layout.rhw))
        return DD.UNSUPPORTED;
      const refreshed = await refreshTextures();
      if (refreshed) return refreshed;
      const hr = await callD3D(r, native, 89, a(2));
      return hr || callD3D(r, native, 83, a(1), count, a(3), layout.size);
    },
    DrawIndexedPrimitive: async (r, a) => {
      if (a(7)) return DD.INVALID;
      const layout = fvfLayout(a(2)),
        count = primitives(a(1), a(6));
      if (!layout || count === null || (!state.legacyClipping && !layout.rhw))
        return DD.UNSUPPORTED;
      const refreshed = await refreshTextures();
      if (refreshed) return refreshed;
      const hr = await callD3D(r, native, 89, a(2));
      return hr || callD3D(r, native, 84, a(1), 0, a(4), count, a(5), 101, a(3), layout.size);
    },
    DrawPrimitiveVB: async (r, a) => {
      const vb = ddObject(r, a(2), 'd3d7-vertex-buffer'),
        start = a(3),
        vertices = a(4);
      if (!vb || vb.state.owner !== owner || a(5) || start + vertices > vb.state.count)
        return DD.INVALID;
      if (vb.state.locked) return DD.BUSY;
      const count = primitives(a(1), vertices);
      if (count === null || (!state.legacyClipping && !vb.state.layout.rhw)) return DD.UNSUPPORTED;
      const refreshed = await refreshTextures();
      if (refreshed) return refreshed;
      const hr = await callD3D(r, native, 89, vb.state.fvf);
      return (
        hr ||
        callD3D(
          r,
          native,
          83,
          a(1),
          count,
          vb.state.memory + start * vb.state.layout.size,
          vb.state.layout.size,
        )
      );
    },
    DrawIndexedPrimitiveVB: async (r, a) => {
      const vb = ddObject(r, a(2), 'd3d7-vertex-buffer'),
        start = a(3),
        vertices = a(4);
      if (!vb || vb.state.owner !== owner || a(7) || start + vertices > vb.state.count)
        return DD.INVALID;
      if (vb.state.locked) return DD.BUSY;
      const count = primitives(a(1), a(6));
      if (count === null || (!state.legacyClipping && !vb.state.layout.rhw)) return DD.UNSUPPORTED;
      const refreshed = await refreshTextures();
      if (refreshed) return refreshed;
      const hr = await callD3D(r, native, 89, vb.state.fvf);
      return (
        hr ||
        callD3D(
          r,
          native,
          84,
          a(1),
          0,
          vertices,
          count,
          a(5),
          101,
          vb.state.memory + start * vb.state.layout.size,
          vb.state.layout.size,
        )
      );
    },
    SetTexture: async (r, a) => {
      const stage = a(1),
        surface = a(2) ? ddObject(r, a(2), 'dd-surface') : null;
      if (stage >= 8 || (a(2) && !surface)) return DD.INVALID;
      if (surface) state.cachedSurfaces.add(surface);
      const t = surface ? await texture(r, surface, native) : null;
      if (surface && !t) return DD.UNSUPPORTED;
      const hr = await callD3D(r, native, 65, stage, t?.pointer ?? 0);
      if (!hr) {
        const old = state.textures.get(stage);
        if (surface) r.comObjects.retain(surface);
        if (old) await r.comObjects.release(old);
        state.textures.set(stage, surface);
      }
      return hr;
    },
    GetTexture: (r, a) => {
      if (a(1) >= 8 || !a(2)) return DD.INVALID;
      const surface = state.textures.get(a(1));
      if (surface) r.comObjects.retain(surface);
      r.write32(a(2), surface?.pointer ?? 0);
      return 0;
    },
    SetTextureStageState: async (r, a) => {
      const n = a(2),
        sampler = { 13: 1, 14: 2, 15: 4, 16: 5, 17: 6, 18: 7, 19: 8, 20: 9, 21: 10 }[n];
      if (n === 12) {
        const hr = await callD3D(r, native, 69, a(1), 1, a(3));
        return hr || callD3D(r, native, 69, a(1), 2, a(3));
      }
      if ([16, 17].includes(n) && ![1, 2].includes(a(3))) return DD.UNSUPPORTED;
      if (n === 18 && ![1, 2, 3].includes(a(3))) return DD.UNSUPPORTED;
      if (sampler) return callD3D(r, native, 69, a(1), sampler, n === 18 ? a(3) - 1 : a(3));
      return callD3D(r, native, 67, a(1), n, a(3));
    },
    GetTextureStageState: async (r, a) => {
      const n = a(2),
        sampler = { 12: 1, 13: 1, 14: 2, 15: 4, 16: 5, 17: 6, 18: 7, 19: 8, 20: 9, 21: 10 }[n];
      const hr = await callD3D(r, native, sampler ? 68 : 66, a(1), sampler ?? n, a(3));
      if (!hr && n === 18) r.write32(a(3), r.read32(a(3)) + 1);
      return hr;
    },
    ValidateDevice: (r, a) => {
      if (!a(1)) return DD.INVALID;
      r.write32(a(1), 1);
      return 0;
    },
    PreLoad: async (r, a) => {
      const surface = ddObject(r, a(1), 'dd-surface');
      if (surface) state.cachedSurfaces.add(surface);
      return surface && (await texture(r, surface, native)) ? 0 : DD.INVALID;
    },
    Load: async (r, a) => {
      const dst = ddObject(r, a(1), 'dd-surface'),
        src = ddObject(r, a(3), 'dd-surface');
      if (!dst || !src || a(2) || a(5)) return DD.UNSUPPORTED;
      return ddBlt(r, dst, 0, src, a(4), 0, 0);
    },
  };
  for (const [name, slot] of Object.entries({
    BeginScene: 41,
    EndScene: 42,
    Clear: 43,
    SetViewport: 47,
    GetViewport: 48,
    SetMaterial: 49,
    GetMaterial: 50,
    SetLight: 51,
    GetLight: 52,
    SetRenderState: 57,
    GetRenderState: 58,
    LightEnable: 53,
    GetLightEnable: 54,
  })) {
    const argc = DDRAW_ABI.IDirect3DDevice7.find((x) => x[0] === name)[1];
    h[name] = (r, a) =>
      a(1) === 136 && name === 'SetRenderState'
        ? a(2) <= 1
          ? ((state.legacyClipping = !!a(2)), 0)
          : DD.INVALID
        : a(1) === 136 && name === 'GetRenderState'
          ? (r.write32(a(2), Number(state.legacyClipping)), 0)
          : a(1) === 4 && name === 'SetRenderState'
            ? a(2) === 1
              ? 0
              : DD.UNSUPPORTED // Texture perspective is always enabled by D3D9.
            : a(1) === 4 && name === 'GetRenderState'
              ? (r.write32(a(2), 1), 0)
              : callD3D(r, native, slot, ...Array.from({ length: argc - 1 }, (_, i) => a(i + 1)));
  }
  const o = r.comObjects.create({
    name: 'IDirect3DDevice7',
    iid: DEVICE,
    methodNames: DDRAW_ABI.IDirect3DDevice7.map((x) => x[0]),
    methods: table('IDirect3DDevice7', h),
    state,
    onRelease: async () => {
      delete ts.presentGPU;
      delete ts.syncGPU;
      for (const surface of state.cachedSurfaces) {
        const cached = surface.state.textures?.get(native.pointer);
        if (cached?.refs) await r.comObjects.release(cached);
        surface.state.textures?.delete(native.pointer);
      }
      for (const surface of state.textures.values())
        if (surface) await r.comObjects.release(surface);
      await r.comObjects.release(native);
      await r.comObjects.release(target);
      await r.comObjects.release(factory);
    },
  });
  r.write32(out, o.pointer);
  return 0;
}
export function createD3D7(r, owner) {
  r.comObjects ??= new ComObjects(r);
  let factory;
  factory = r.comObjects.create({
    name: 'IDirect3D7',
    iid: IID,
    methodNames: DDRAW_ABI.IDirect3D7.map((x) => x[0]),
    state: owner,
    queryInterface: owner.query,
    onRelease: owner.dispose,
    methods: table('IDirect3D7', {
      EnumDevices: async (r, a) => {
        if (!a(1)) return DD.INVALID;
        const p = r.allocate(236),
          text = r.allocate(32, true);
        r.data.set(new TextEncoder().encode('WineBrowser WebGPU'), text);
        try {
          writeD3D7Caps(r, p);
          await r.callGuest(a(1), [text, text, p, a(2)]);
          return 0;
        } finally {
          r.free(p);
          r.free(text);
        }
      },
      CreateDevice: (r, a) => createDevice(r, owner, factory, a),
      CreateVertexBuffer: (r, a) => createVertexBuffer(r, owner, factory, a),
      EnumZBufferFormats: async (r, a) => {
        if (![HAL, TNL].includes(readGuid(r, a(1))) || !a(2)) return DD.INVALID;
        const p = r.allocate(32);
        try {
          writeDDPixelFormat(r, p, [0x400, 0, 16, 0, 0xffff, 0, 0]);
          await r.callGuest(a(2), [p, a(3)]);
          return 0;
        } finally {
          r.free(p);
        }
      },
      EvictManagedTextures: () => 0,
    }),
  });
  return factory;
}
