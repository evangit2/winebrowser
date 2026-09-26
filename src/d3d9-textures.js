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
  ({ 21: 4, 22: 4, 23: 2, 24: 2, 25: 2, 26: 2, 28: 1 })[format];
export function initTextures() {
  return {
    textures: Array(8).fill(null),
    samplers: Array.from({ length: 8 }, defaultSampler),
    textureStages: Array.from({ length: 8 }, (_, i) => defaultStage(i)),
    textureSnapshots: new Set(),
    frameTextureBytes: 0,
  };
}
function freeTexture(r, o) {
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
  if (pointer && (!next?.refs || next.state.kind !== 'texture2d' || next.state.device !== device))
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
  return left >= 0 &&
    top >= 0 &&
    right > left &&
    bottom > top &&
    right <= level.width &&
    bottom <= level.height
    ? { left, top, right, bottom }
    : null;
}
function invalidate(o) {
  o.state.revision++;
  o.state.snapshot = null;
}
export function createTextureMethod(version) {
  return {
    argc: version === 8 ? 8 : 9,
    invoke(r, a, device) {
      const [width, height, requested, usage, format, pool, output] = [1, 2, 3, 4, 5, 6, 7].map(
        (i) => a(i) >>> 0,
      );
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
        (version === 9 && a(8))
      )
        return INVALID;
      let bytes = 0;
      const levels = Array.from({ length: count }, (_, i) => {
        const w = Math.max(1, width >> i),
          h = Math.max(1, height >> i),
          pitch = (w * bpp + 3) & ~3;
        const level = { width: w, height: h, pitch, offset: bytes, locked: null };
        bytes += pitch * h;
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
          10: { argc: 1, invoke: () => 3 },
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
              const level = levels[a(1) >>> 0];
              if (!level || !a(2)) return INVALID;
              r.check(a(2), 32, true);
              const values =
                version === 8
                  ? [
                      format,
                      1,
                      usage,
                      pool,
                      level.pitch * level.height,
                      0,
                      level.width,
                      level.height,
                    ]
                  : [format, 1, usage, pool, 0, 0, level.width, level.height];
              values.forEach((v, i) => r.write32(a(2) + i * 4, v));
              return 0;
            },
          },
          [16 + shift]: {
            argc: 5,
            invoke(r, a, o) {
              const level = levels[a(1) >>> 0],
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
                base + level.offset + region.top * level.pitch + region.left * bpp,
              );
              level.locked = { flags };
              return 0;
            },
          },
          [17 + shift]: {
            argc: 2,
            invoke(_r, a, o) {
              const level = levels[a(1) >>> 0];
              if (!level?.locked) return INVALID;
              if (!(level.locked.flags & 0x10)) invalidate(o);
              level.locked = null;
              return 0;
            },
          },
          [18 + shift]: {
            argc: 2,
            invoke(r, a, o) {
              if (!rect(r, a(1), levels[0])) return INVALID;
              invalidate(o);
              return 0;
            },
          },
        };
        const object = r.comObjects.create({
          name: `IDirect3DTexture${version}`,
          iid:
            version === 8
              ? 'e4cdd575-2866-4f01-b12e-7eece1ec9358'
              : '85c31227-3de5-4f00-9b3a-f11ac38c18b5',
          iids:
            version === 8
              ? ['b4211cfa-51b9-4a9f-ab78-db99b2bb678e', '1b36bb7b-09b7-410a-b445-7d1430d7b33f']
              : ['580ca87e-1d3c-4d54-991d-b7d3e3c298ce', '05eec05d-8f7d-4362-b999-d1baf357c704'],
          methodNames:
            `${BASE_METHODS} ${version === 9 ? 'SetAutoGenFilterType GetAutoGenFilterType GenerateMipSubLevels ' : ''}${TAIL_METHODS}`.split(
              ' ',
            ),
          methods,
          state: {
            kind: 'texture2d',
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
export function textureSnapshot(r, object) {
  const s = object.state;
  if (s.levels.some((l) => l.locked)) throw Error('D3D draw uses a locked texture');
  if (s.freed) throw Error('D3D draw uses a freed texture');
  if (!s.snapshot) {
    const levels = s.levels.map((l) => {
      const rgba = new Uint8Array(l.width * l.height * 4);
      for (let y = 0; y < l.height; y++)
        for (let x = 0; x < l.width; x++) {
          const p = s.base + l.offset + y * l.pitch + x * s.bpp,
            q = (y * l.width + x) * 4;
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
          } else {
            rgba[q] = rgba[q + 1] = rgba[q + 2] = 255;
            rgba[q + 3] = r.data[p];
          }
        }
      return { width: l.width, height: l.height, rgba };
    });
    s.snapshot = { id: object.pointer, revision: s.revision, levels };
  }
  return s.snapshot;
}
export function fixedTextureDraw(r, state) {
  const stage = state.textureStages[0],
    texture = state.textures[0];
  // D3D disables this and following stages when COLOROP is disabled, or a
  // color argument used by the operation requests an unbound texture.
  const uses = (op, a, b) => (op !== 3 && (a & 15) === 2) || (op !== 2 && (b & 15) === 2);
  if (stage[1] === 1 || (!texture && uses(stage[1], stage[2], stage[3]))) return null;
  if (state.textureStages[1][1] !== 1)
    throw Error('Multiple D3D texture stages are not yet supported');
  if (stage[4] === 1) throw Error('D3D alpha operation disabled while color operation is enabled');
  if (texture?.state.pool >= 2) throw Error('System-memory D3D textures cannot be sampled');
  const snapshot = texture ? textureSnapshot(r, texture) : null;
  return {
    texture: snapshot,
    stage: { ...stage },
    sampler: { ...state.samplers[0] },
    lod: texture?.state.lod ?? 0,
  };
}
