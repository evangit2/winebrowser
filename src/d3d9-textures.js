import { readGuid } from './com.js';
import { compressedFormat, decodeCompressed } from './d3d-compressed.js';
import { releaseComReference } from './d3d9-programmable.js';
import {
  defaultSampler,
  defaultStage,
  INVALID_TEXTURE_CALL as INVALID,
} from './d3d-texture-state.js';

const MAX_BYTES = 32 * 1024 * 1024;
const BASE_METHODS =
  'QueryInterface AddRef Release GetDevice SetPrivateData GetPrivateData FreePrivateData SetPriority GetPriority PreLoad GetType SetLOD GetLOD GetLevelCount';
const TAIL_METHODS = 'GetLevelDesc GetSurfaceLevel LockRect UnlockRect AddDirtyRect';
export const textureBytesPerPixel = (format) =>
  compressedFormat(format)?.blockBytes ??
  { 21: 4, 22: 4, 23: 2, 24: 2, 25: 2, 26: 2, 28: 1, 50: 1, 51: 2, 52: 1 }[format];

// Row length and row count for one mip level. Compressed formats store 4x4
// texel blocks, so their rows are block rows and a level holds
// ceil(width/4) * ceil(height/4) blocks. Uncompressed levels use the D3D
// DWORD-aligned pitch and one row per pixel row.
export function levelGeometry(format, bpp, width, height) {
  const compressed = compressedFormat(format);
  if (compressed)
    return {
      pitch: Math.ceil(width / 4) * compressed.blockBytes,
      rows: Math.ceil(height / 4),
      blockBytes: compressed.blockBytes,
    };
  return { pitch: (width * bpp + 3) & ~3, rows: height, blockBytes: 0 };
}
const SURFACE_METHODS_8 =
  'QueryInterface AddRef Release GetDevice SetPrivateData GetPrivateData FreePrivateData GetContainer GetDesc LockRect UnlockRect'.split(
    ' ',
  );
const SURFACE_METHODS_9 =
  'QueryInterface AddRef Release GetDevice SetPrivateData GetPrivateData FreePrivateData SetPriority GetPriority PreLoad GetType GetContainer GetDesc LockRect UnlockRect GetDC ReleaseDC'.split(
    ' ',
  );
const SURFACE_IIDS = {
  8: 'b96eebca-b326-4ea5-882f-2ff5bae021dd',
  9: '0cfbaf3a-9ff6-429a-99b3-a2796af8b89b',
};
// D3DSURFACE_DESC: Format, Type, Usage, Pool, [MultiSampleType for D3D8 sits
// after a DWORD of padding], MultiSampleQuality (D3D9), Width, Height.
function writeSurfaceDesc(r, pointer, version, level, state) {
  r.check(pointer, 32, true);
  r.data.fill(0, pointer, pointer + 32);
  r.write32(pointer, state.format);
  r.write32(pointer + 4, 1); // D3DRTYPE_SURFACE
  r.write32(pointer + 8, state.usage ?? 0); // Texture levels carry no extra usage.
  r.write32(pointer + 12, state.pool);
  r.write32(pointer + (version === 8 ? 20 : 16), 0); // D3DMULTISAMPLE_NONE
  r.write32(pointer + 20, 0); // MultiSampleQuality.
  r.write32(pointer + 24, level.width);
  r.write32(pointer + 28, level.height);
}

// A texture level surface is a view onto the texture's own level storage, so
// LockRect through the surface or the texture mutates the same bytes. The
// surface exposes GetContainer back to the texture that created it.
function surfaceMethods(version, texture) {
  const shift = version === 8 ? 0 : 4;
  return {
    3: {
      argc: 2,
      invoke(r, a, surface) {
        r.check(a(1), 4, true);
        const device = texture.state.device;
        if (device.refs >= 0x7fffffff) throw Error('D3D device reference limit exceeded');
        device.refs++;
        r.write32(a(1), device.pointer);
        return 0;
      },
    },
    [7 + shift]: {
      // GetContainer: hand back the texture that owns this level.
      argc: 3,
      invoke(r, a, surface) {
        const out = a(2) >>> 0;
        r.check(out, 4, true);
        r.write32(out, 0);
        if (readGuid(r, a(1)) !== texture.iid) return 0x80004002;
        if (texture.refs >= 0x7fffffff) throw Error('D3D texture reference limit exceeded');
        texture.refs++;
        r.write32(out, texture.pointer);
        return 0;
      },
    },
    [8 + shift]: {
      argc: 2,
      invoke: (r, a, surface) => {
        writeSurfaceDesc(r, a(1), version, surface.state.level, texture.state);
        return 0;
      },
    },
    [9 + shift]: {
      argc: 4,
      invoke(r, a, surface) {
        const { state } = texture;
        const { level } = surface.state;
        const flags = a(3) >>> 0;
        if (
          level.locked ||
          !a(1) ||
          (state.pool === 0 && !state.usage) ||
          flags & ~(0x10 | 0x800 | 0x1000 | 0x2000) ||
          (flags & 0x2000 && (!state.usage || a(2) || flags & 0x10))
        )
          return INVALID;
        const region = rect(r, a(2), level);
        if (!region) return INVALID;
        r.check(a(1), 8, true);
        r.write32(a(1), level.pitch);
        r.write32(
          a(1) + 4,
          state.base + level.offset + levelOffset(level, region.left, region.top, state.bpp),
        );
        level.locked = { flags };
        return 0;
      },
    },
    [10 + shift]: {
      argc: 1,
      invoke(_r, _a, surface) {
        const { level } = surface.state;
        if (!level.locked) return INVALID;
        if (!(level.locked.flags & 0x10)) invalidate(texture);
        level.locked = null;
        return 0;
      },
    },
  };
}

function surfaceName(version) {
  return `IDirect3DSurface${version}`;
}

function createSurface(r, texture, levelIndex) {
  const version = texture.state.version;
  const level = texture.state.levels[levelIndex];
  if (!level) return null;
  if (texture.refs >= 0x7fffffff) throw Error('D3D texture reference limit exceeded');
  // A surface keeps its texture alive and, with it, the shared level bytes.
  texture.refs++;
  const methodNames = version === 8 ? SURFACE_METHODS_8 : SURFACE_METHODS_9;
  try {
    return r.comObjects.create({
      name: surfaceName(version),
      iid: SURFACE_IIDS[version],
      iids:
        version === 8
          ? ['1b36bb7b-09b7-410a-b445-7d1430d7b33f']
          : ['580ca87e-1d3c-4d54-991d-b7d3e3c298ce'],
      methodNames,
      methods: surfaceMethods(version, texture),
      state: { device: texture.state.device, texture, level, internalRefs: 0 },
      onRelease: async () => releaseComReference(texture),
    });
  } catch (error) {
    texture.refs--;
    throw error;
  }
}

// A device-level surface (the implicit backbuffer, an implicit depth-stencil
// buffer, or a CreateRenderTarget/CreateDepthStencilSurface/CreateOffscreenPlain
// result) owns a private level-shaped buffer and exposes the same
// IDirect3DSurface ABI as a texture level view, but has no container texture.
const SURFACE_SECONDARY_IID = {
  8: '1b36bb7b-09b7-410a-b445-7d1430d7b33f',
  9: '580ca87e-1d3c-4d54-991d-b7d3e3c298ce',
};
function deviceSurfaceMethods(version) {
  const shift = version === 8 ? 0 : 4;
  return {
    3: {
      argc: 2,
      invoke(r, a, surface) {
        r.check(a(1), 4, true);
        const device = surface.state.device;
        if (device.refs >= 0x7fffffff) throw Error('D3D device reference limit exceeded');
        device.refs++;
        r.write32(a(1), device.pointer);
        return 0;
      },
    },
    [7 + shift]: {
      // GetContainer: a device surface is not owned by a texture.
      argc: 3,
      invoke(r, a) {
        r.check(a(2), 4, true);
        r.write32(a(2), 0);
        return 0x80004002;
      },
    },
    [8 + shift]: {
      argc: 2,
      invoke: (r, a, surface) => {
        writeSurfaceDesc(r, a(1), version, surface.state.level, surface.state);
        return 0;
      },
    },
    [9 + shift]: {
      argc: 4,
      invoke(r, a, surface) {
        const { level, bpp } = surface.state;
        const flags = a(3) >>> 0;
        if (level.locked || !a(1) || flags & ~(0x10 | 0x800 | 0x1000 | 0x2000)) return INVALID;
        const region = rect(r, a(2), level);
        if (!region) return INVALID;
        const base = surfaceStorage(r, surface);
        if (!base) return INVALID;
        r.check(a(1), 8, true);
        r.write32(a(1), level.pitch);
        r.write32(a(1) + 4, base + levelOffset(level, region.left, region.top, bpp));
        level.locked = { flags };
        return 0;
      },
    },
    [10 + shift]: {
      argc: 1,
      invoke(_r, _a, surface) {
        if (!surface.state.level.locked) return INVALID;
        surface.state.level.locked = null;
        return 0;
      },
    },
  };
}

export function createDeviceSurface(
  r,
  device,
  { width, height, format, pool = 0, usage = 0, bpp = 4 },
) {
  const version = device.state.version;
  if (device.refs >= 0x7fffffff) throw Error('D3D device reference limit exceeded');
  const { pitch, rows, blockBytes } = levelGeometry(format, bpp, width, height);
  const bytes = pitch * rows;
  // Storage is allocated lazily: a device creates an implicit backbuffer and
  // depth surface at startup, but many programs never read their pixels. This
  // keeps creation cheap and avoids reserving megabytes for untouched targets.
  return r.comObjects.create({
    name: surfaceName(version),
    iid: SURFACE_IIDS[version],
    iids: [SURFACE_SECONDARY_IID[version]],
    methodNames: version === 8 ? SURFACE_METHODS_8 : SURFACE_METHODS_9,
    methods: deviceSurfaceMethods(version),
    state: {
      device,
      format,
      pool,
      usage,
      base: 0,
      bpp,
      bytes,
      level: { width, height, pitch, rows, blockBytes, offset: 0, locked: null },
      internalRefs: 0,
      freed: false,
    },
    onRelease: () => releaseDeviceSurface(r, { state: { base: 0, bytes: 0 } }),
  });
}
// Materialize a device surface's pixel storage on first use. Returns the base
// guest address, or null when the term budget or size limit is exceeded.
export function surfaceStorage(r, surface) {
  const state = surface.state;
  if (state.freed) return null;
  if (state.base) return state.base;
  if ((r.d3dTextureBytes ?? 0) + state.bytes > MAX_BYTES) return null;
  state.base = r.allocate(state.bytes);
  r.d3dTextureBytes = (r.d3dTextureBytes ?? 0) + state.bytes;
  return state.base;
}
// Release a device-level surface's private storage exactly once, whatever ref
// count path reached zero. Implicit backbuffer/depth targets are owned by the
// device itself, so they never hold a reference of their own.
export function releaseDeviceSurface(r, surface) {
  const state = surface.state;
  if (!state || state.freed) return;
  state.freed = true;
  if (state.base) {
    r.free(state.base);
    r.d3dTextureBytes = (r.d3dTextureBytes ?? 0) - state.bytes;
    state.base = 0;
  }
}

export function deviceSurface(r, pointer, device) {
  const object = r.comObjects?.objects.get(pointer >>> 0);
  if (
    !object ||
    !object.refs ||
    (object.name !== 'IDirect3DSurface8' && object.name !== 'IDirect3DSurface9') ||
    object.state.device !== device ||
    object.state.texture
  )
    return null;
  return object;
}

export function initTextures() {
  return {
    textures: Array(8).fill(null),
    samplers: Array.from({ length: 8 }, defaultSampler),
    textureStages: Array.from({ length: 8 }, (_, i) => defaultStage(i)),
    textureSnapshots: new Set(),
    frameTextureBytes: 0,
  };
}
export function freeTexture(r, o) {
  const s = o.state;
  if (o.refs || s.internalRefs || s.freed) return;
  r.free(s.base);
  r.d3dTextureBytes -= s.bytes;
  s.snapshot = null;
  s.freed = true;
}
export function unbindTextures(r, device) {
  for (const o of device.state.textures)
    if (o) {
      o.state.internalRefs--;
      freeTexture(r, o);
    }
  device.state.textures.fill(null);
}
export function bindTexture(r, device, stage, pointer) {
  if (stage >= 8) return INVALID;
  const next = pointer ? r.comObjects.objects.get(pointer) : null;
  if (
    pointer &&
    (!next?.refs ||
      !['texture2d', 'texture3d', 'texturecube'].includes(next.state.kind) ||
      next.state.device !== device)
  )
    return INVALID;
  const prev = device.state.textures[stage];
  if (prev === next) return 0;
  if (next) next.state.internalRefs++;
  device.state.textures[stage] = next;
  if (prev) {
    prev.state.internalRefs--;
    freeTexture(r, prev);
  }
  return 0;
}
export function getTexture(r, device, stage, output) {
  if (stage >= 8) return INVALID;
  r.check(output, 4, true);
  const o = device.state.textures[stage];
  if (o) {
    if (o.refs >= 0x7fffffff || (!o.refs && device.refs >= 0x7fffffff))
      throw Error('D3D texture reference limit exceeded');
    if (!o.refs) device.refs++;
    o.refs++;
  }
  r.write32(output, o?.pointer ?? 0);
  return 0;
}
function rect(r, pointer, level) {
  if (!pointer) return { left: 0, top: 0, right: level.width, bottom: level.height };
  r.check(pointer, 16);
  const [left, top, right, bottom] = [0, 4, 8, 12].map((i) => r.read32(pointer + i) | 0);
  if (!(
    left >= 0 &&
    top >= 0 &&
    right > left &&
    bottom > top &&
    right <= level.width &&
    bottom <= level.height
  ))
    return null;
  // A block-compressed level is addressed in 4x4 blocks, and D3D rejects a
  // lock rectangle that would split one.
  if (level.blockBytes && (left % 4 || top % 4 || right % 4 || bottom % 4)) return null;
  return { left, top, right, bottom };
}
// Byte offset of the texel (or block) at (left, top) inside one level.
function levelOffset(level, left, top, bpp) {
  return level.blockBytes
    ? (top >> 2) * level.pitch + (left >> 2) * level.blockBytes
    : top * level.pitch + left * bpp;
}
export function invalidate(o) {
  o.state.revision++;
  o.state.snapshot = null;
}
export function createTextureMethod(version, cube = false) {
  return {
    argc: (version === 8 ? 8 : 9) - (cube ? 1 : 0),
    invoke(r, a, device) {
      const width = a(1) >>> 0,
        height = cube ? width : a(2) >>> 0,
        delta = cube ? 1 : 0;
      const [requested, usage, format, pool, output] = [3, 4, 5, 6, 7].map(
        (i) => a(i - delta) >>> 0,
      );
      if (!output) return INVALID;
      r.check(output, 4, true);
      r.write32(output, 0);
      const bpp = textureBytesPerPixel(format);
      const count = requested || 1 + Math.floor(Math.log2(Math.max(width, height)));
      if (
        !width ||
        !height ||
        width > 2048 ||
        height > 2048 ||
        !bpp ||
        ![0, 1, 2, 3].includes(pool) ||
        ![0, 0x200].includes(usage) ||
        (usage && pool !== 0) ||
        count < 1 ||
        count > 1 + Math.floor(Math.log2(Math.max(width, height))) ||
        (version === 9 && a(8 - delta))
      )
        return INVALID;
      let bytes = 0;
      const faces = cube ? 6 : 1;
      const levelIndex = (face, mip) => (face < faces && mip < count ? mip * faces + face : -1);
      const levels = Array.from({ length: count * faces }, (_, index) => {
        const i = Math.floor(index / faces),
          w = Math.max(1, width >> i),
          h = Math.max(1, height >> i),
          { pitch, rows, blockBytes } = levelGeometry(format, bpp, w, h);
        const level = {
          width: w,
          height: h,
          pitch,
          rows,
          blockBytes,
          offset: bytes,
          locked: null,
        };
        bytes += pitch * rows;
        return level;
      });
      if ((r.d3dTextureBytes ?? 0) + bytes > MAX_BYTES) return 0x8876017c;
      if (device.refs >= 0x7fffffff) throw Error('D3D device reference limit exceeded');
      const base = r.allocate(bytes);
      r.d3dTextureBytes = (r.d3dTextureBytes ?? 0) + bytes;
      device.refs++;
      try {
        const shift = version === 8 ? 0 : 3;
        const methods = {
          3: {
            argc: 2,
            invoke(r, a) {
              r.check(a(1), 4, true);
              if (device.refs >= 0x7fffffff) throw Error('D3D device reference limit exceeded');
              device.refs++;
              r.write32(a(1), device.pointer);
              return 0;
            },
          },
          7: {
            argc: 2,
            invoke(_r, a, o) {
              const old = o.state.priority;
              o.state.priority = a(1) >>> 0;
              return old;
            },
          },
          8: { argc: 1, invoke: (_r, _a, o) => o.state.priority },
          10: { argc: 1, invoke: () => (cube ? 5 : 3) },
          11: {
            argc: 2,
            invoke(_r, a, o) {
              const old = o.state.lod;
              if (pool === 1) o.state.lod = Math.min(a(1) >>> 0, count - 1);
              return old;
            },
          },
          12: { argc: 1, invoke: (_r, _a, o) => o.state.lod },
          13: { argc: 1, invoke: () => count },
          [14 + shift]: {
            argc: 3,
            invoke(r, a) {
              const level = levels[levelIndex(0, a(1) >>> 0)];
              if (!level || !a(2)) return INVALID;
              r.check(a(2), 32, true);
              const values =
                version === 8
                  ? [format, 1, usage, pool, level.pitch * level.rows, 0, level.width, level.height]
                  : [format, 1, usage, pool, 0, 0, level.width, level.height];
              values.forEach((v, i) => r.write32(a(2) + i * 4, v));
              return 0;
            },
          },
          [15 + shift]: {
            // Cube surfaces address a face plus mip; 2D surfaces only a mip.
            argc: cube ? 4 : 3,
            invoke(r, a, o) {
              const out = a(cube ? 3 : 2) >>> 0;
              if (!out) return INVALID;
              r.check(out, 4, true);
              r.write32(out, 0);
              const index = cube ? levelIndex(a(1) >>> 0, a(2) >>> 0) : levelIndex(0, a(1) >>> 0);
              if (!levels[index]) return INVALID;
              const surface = createSurface(r, o, index);
              r.write32(out, surface.pointer);
              return 0;
            },
          },
          [16 + shift]: {
            argc: cube ? 6 : 5,
            invoke(r, argument, o) {
              const a = (i) => argument(i + (cube ? 1 : 0));
              const index = cube
                ? levelIndex(argument(1) >>> 0, a(1) >>> 0)
                : levelIndex(0, a(1) >>> 0);
              const level = levels[index],
                flags = a(4) >>> 0;
              if (
                !level ||
                level.locked ||
                !a(2) ||
                (pool === 0 && !usage) ||
                flags & ~(0x10 | 0x800 | 0x1000 | 0x2000) ||
                (flags & 0x2000 && (!usage || a(3) || flags & 0x10))
              )
                return INVALID;
              const region = rect(r, a(3), level);
              if (!region) return INVALID;
              r.check(a(2), 8, true);
              r.write32(a(2), level.pitch);
              r.write32(
                a(2) + 4,
                base + level.offset + levelOffset(level, region.left, region.top, bpp),
              );
              level.locked = { flags };
              return 0;
            },
          },
          [17 + shift]: {
            argc: cube ? 3 : 2,
            invoke(_r, a, o) {
              const index = cube ? levelIndex(a(1) >>> 0, a(2) >>> 0) : levelIndex(0, a(1) >>> 0);
              const level = levels[index];
              if (!level?.locked) return INVALID;
              if (!(level.locked.flags & 0x10)) invalidate(o);
              level.locked = null;
              return 0;
            },
          },
          [18 + shift]: {
            argc: cube ? 3 : 2,
            invoke(r, a, o) {
              if ((cube && a(1) >>> 0 >= 6) || !rect(r, a(cube ? 2 : 1), levels[0])) return INVALID;
              invalidate(o);
              return 0;
            },
          },
        };
        const object = r.comObjects.create({
          name: `IDirect3D${cube ? 'CubeTexture' : 'Texture'}${version}`,
          iid: cube
            ? version === 8
              ? '3ee5b968-2aca-4c34-8bb5-7e0c3d19b750'
              : 'fff32f81-d953-473a-9223-93d652aba93f'
            : version === 8
              ? 'e4cdd575-2866-4f01-b12e-7eece1ec9358'
              : '85c31227-3de5-4f00-9b3a-f11ac38c18b5',
          iids:
            version === 8
              ? ['b4211cfa-51b9-4a9f-ab78-db99b2bb678e', '1b36bb7b-09b7-410a-b445-7d1430d7b33f']
              : ['580ca87e-1d3c-4d54-991d-b7d3e3c298ce', '05eec05d-8f7d-4362-b999-d1baf357c704'],
          methodNames:
            `${BASE_METHODS} ${version === 9 ? 'SetAutoGenFilterType GetAutoGenFilterType GenerateMipSubLevels ' : ''}${cube ? TAIL_METHODS.replace('GetSurfaceLevel', 'GetCubeMapSurface') : TAIL_METHODS}`.split(
              ' ',
            ),
          methods,
          state: {
            kind: cube ? 'texturecube' : 'texture2d',
            mipCount: count,
            device,
            width,
            height,
            format,
            usage,
            pool,
            base,
            bytes,
            bpp,
            levels,
            version,
            internalRefs: 0,
            priority: 0,
            lod: 0,
            revision: 0,
            snapshot: null,
          },
          onRelease: async (o) => {
            freeTexture(r, o);
            await releaseComReference(device);
          },
        });
        r.write32(output, object.pointer);
        return 0;
      } catch (error) {
        device.refs--;
        r.free(base);
        r.d3dTextureBytes -= bytes;
        throw error;
      }
    },
  };
}
// A device-level surface is either a texture level view or a standalone image
// surface; both publish the same level-shaped state used by CopyRects.
const number = (value) => value >>> 0;
export function surfaceLevel(r, pointer, device) {
  const object = r.comObjects?.objects.get(number(pointer));
  if (
    !object ||
    !object.refs ||
    (object.name !== 'IDirect3DSurface8' && object.name !== 'IDirect3DSurface9') ||
    object.state.device !== device
  )
    return null;
  return object.state.level;
}

// CopyRects(src, srcRects, rectCount, dst, dstPoints): copy `rectCount`
// rectangles from src to dst, or the whole surface when srcRects is NULL.
// A surface's pixels live either in its container texture's storage or, for a
// device-level surface, in its own. Return the level plus the owning bytes so
// copies work uniformly across both.
export function surfaceImage(r, pointer, device) {
  const object = r.comObjects?.objects.get(number(pointer));
  if (
    !object ||
    !object.refs ||
    (object.name !== 'IDirect3DSurface8' && object.name !== 'IDirect3DSurface9') ||
    object.state.device !== device
  )
    return null;
  const texture = object.state.texture;
  return texture
    ? {
        level: object.state.level,
        base: texture.state.base,
        bpp: texture.state.bpp,
        format: texture.state.format,
        invalidate: () => invalidate(texture),
      }
    : {
        level: object.state.level,
        base: surfaceStorage(r, object),
        bpp: object.state.bpp,
        format: object.state.format,
        invalidate: () => {},
      };
}

export function copyRects(
  r,
  device,
  srcPointer,
  srcRectsPointer,
  rectCount,
  dstPointer,
  dstPointsPointer,
) {
  const src = surfaceLevel(r, srcPointer, device),
    dst = surfaceLevel(r, dstPointer, device);
  if (!src || !dst || !rectCount || rectCount > 1024) return INVALID;
  const srcImage = surfaceImage(r, srcPointer, device),
    dstImage = surfaceImage(r, dstPointer, device);
  if (!srcImage || !dstImage) return INVALID;
  if (src.locked || dst.locked) return INVALID;
  if (srcImage.format !== dstImage.format) return INVALID;
  const compressed = compressedFormat(srcImage.format);
  const bpp = srcImage.bpp;
  const first = srcImage.base + src.offset,
    second = dstImage.base + dst.offset;
  // Compressed levels move whole 4x4 blocks, so both the rectangle and the
  // per-row step are expressed in blocks rather than pixels.
  const unit = compressed ? 4 : 1;
  const bytesPerUnit = compressed ? compressed.blockBytes : bpp;
  const copy = (sx, sy, dx, dy, width, height) => {
    if (compressed && (sx % 4 || sy % 4 || dx % 4 || dy % 4 || width % 4 || height % 4))
      return false;
    const rowBytes = (width / unit) * bytesPerUnit;
    for (let row = 0; row < height; row += unit) {
      const from = first + levelOffset(src, sx, sy + row, bpp);
      const to = second + levelOffset(dst, dx, dy + row, bpp);
      r.data.copyWithin(to, from, from + rowBytes);
    }
    return true;
  };
  if (!srcRectsPointer) {
    if (dstPointsPointer) {
      const dx = r.read32(dstPointsPointer) | 0,
        dy = r.read32(dstPointsPointer + 4) | 0;
      if (dx < 0 || dy < 0 || dx + src.width > dst.width || dy + src.height > dst.height)
        return INVALID;
      if (!copy(0, 0, dx, dy, src.width, src.height)) return INVALID;
    } else if (!copy(0, 0, 0, 0, Math.min(src.width, dst.width), Math.min(src.height, dst.height)))
      return INVALID;
  } else {
    r.check(srcRectsPointer, rectCount * 16);
    if (dstPointsPointer) r.check(dstPointsPointer, rectCount * 8);
    for (let i = 0; i < rectCount; i++) {
      const rectPointer = srcRectsPointer + i * 16;
      const [left, top, right, bottom] = [0, 4, 8, 12].map((o) => r.read32(rectPointer + o) | 0);
      const width = right - left,
        height = bottom - top;
      if (
        left < 0 ||
        top < 0 ||
        width <= 0 ||
        height <= 0 ||
        right > src.width ||
        bottom > src.height
      )
        return INVALID;
      const dx = dstPointsPointer ? r.read32(dstPointsPointer + i * 8) | 0 : left;
      const dy = dstPointsPointer ? r.read32(dstPointsPointer + i * 8 + 4) | 0 : top;
      if (dx < 0 || dy < 0 || dx + width > dst.width || dy + height > dst.height) return INVALID;
      if (!copy(left, top, dx, dy, width, height)) return INVALID;
    }
  }
  dstImage.invalidate();
  return 0;
}

export function textureSnapshot(r, object) {
  const s = object.state;
  if (s.levels.some((l) => l.locked)) throw Error('D3D draw uses a locked texture');
  if (s.freed) throw Error('D3D draw uses a freed texture');
  if (!s.snapshot) {
    let levels = s.levels.map((l) => {
      const rgba = new Uint8Array(l.width * l.height * (l.depth ?? 1) * 4);
      if (l.blockBytes) {
        decodeCompressed(r.data, s.base + l.offset, s.format, l.width, l.height, rgba);
        return { width: l.width, height: l.height, ...(l.depth ? { depth: l.depth } : {}), rgba };
      }
      for (let z = 0; z < (l.depth ?? 1); z++)
        for (let y = 0; y < l.height; y++)
          for (let x = 0; x < l.width; x++) {
            const p = s.base + l.offset + z * (l.slicePitch ?? 0) + y * l.pitch + x * s.bpp,
              q = ((z * l.height + y) * l.width + x) * 4;
            const value = s.bpp === 2 ? r.view.getUint16(p, true) : 0;
            if (s.bpp === 4) {
              rgba[q] = r.data[p + 2];
              rgba[q + 1] = r.data[p + 1];
              rgba[q + 2] = r.data[p];
              rgba[q + 3] = s.format === 21 ? r.data[p + 3] : 255;
            } else if (s.format === 23) {
              rgba[q] = Math.round(((value >>> 11) * 255) / 31);
              rgba[q + 1] = Math.round((((value >>> 5) & 63) * 255) / 63);
              rgba[q + 2] = Math.round(((value & 31) * 255) / 31);
              rgba[q + 3] = 255;
            } else if (s.format === 24 || s.format === 25) {
              rgba[q] = Math.round((((value >>> 10) & 31) * 255) / 31);
              rgba[q + 1] = Math.round((((value >>> 5) & 31) * 255) / 31);
              rgba[q + 2] = Math.round(((value & 31) * 255) / 31);
              rgba[q + 3] = s.format === 24 || value & 0x8000 ? 255 : 0;
            } else if (s.format === 26) {
              rgba[q] = ((value >>> 8) & 15) * 17;
              rgba[q + 1] = ((value >>> 4) & 15) * 17;
              rgba[q + 2] = (value & 15) * 17;
              rgba[q + 3] = (value >>> 12) * 17;
            } else if (s.format === 50) {
              // L8 carries one luminance byte and samples as opaque grey.
              rgba[q] = rgba[q + 1] = rgba[q + 2] = r.data[p];
              rgba[q + 3] = 255;
            } else if (s.format === 51) {
              // A8L8: luminance in the low byte, alpha in the high byte.
              const l = r.data[p];
              rgba[q] = rgba[q + 1] = rgba[q + 2] = l;
              rgba[q + 3] = r.data[p + 1];
            } else if (s.format === 52) {
              // A4L4: alpha in the high nibble, luminance in the low nibble.
              const byte = r.data[p],
                l = (byte & 15) * 17;
              rgba[q] = rgba[q + 1] = rgba[q + 2] = l;
              rgba[q + 3] = ((byte >>> 4) & 15) * 17;
            } else {
              rgba[q] = rgba[q + 1] = rgba[q + 2] = 255;
              rgba[q + 3] = r.data[p];
            }
          }
      return { width: l.width, height: l.height, ...(l.depth ? { depth: l.depth } : {}), rgba };
    });
    if (s.kind === 'texturecube') {
      levels = Array.from({ length: s.mipCount }, (_, mip) => {
        const first = levels[mip * 6],
          rgba = new Uint8Array(first.rgba.length * 6);
        for (let face = 0; face < 6; face++)
          rgba.set(levels[mip * 6 + face].rgba, first.rgba.length * face);
        return { width: first.width, height: first.height, rgba };
      });
    }
    s.snapshot = {
      id: object.pointer,
      revision: s.revision,
      ...(s.kind === 'texture3d'
        ? { dimension: '3d' }
        : s.kind === 'texturecube'
          ? { dimension: 'cube' }
          : {}),
      levels,
    };
  }
  return s.snapshot;
}
export function fixedTextureDraw(r, state) {
  const stages = [];
  const uses = (op, a, b) => (op !== 3 && (a & 15) === 2) || (op !== 2 && (b & 15) === 2);
  for (let index = 0; index < 8; index++) {
    const stage = state.textureStages[index],
      texture = state.textures[index];
    // A disabled COLOROP or an unbound texture argument terminates the cascade.
    if (stage[1] === 1 || (!texture && uses(stage[1], stage[2], stage[3]))) break;
    if (stage[4] === 1)
      throw Error('D3D alpha operation disabled while color operation is enabled');
    if (texture?.state.pool >= 2) throw Error('System-memory D3D textures cannot be sampled');
    stages.push({
      texture: texture ? textureSnapshot(r, texture) : null,
      stage: { ...stage },
      sampler: { ...state.samplers[index] },
      lod: texture?.state.lod ?? 0,
    });
  }
  return stages.length ? { ...stages[0], ...(stages.length > 1 ? { stages } : {}) } : null;
}
