import { supportsGuestFormat } from './d3d-pixel-format.js';
import { readGuid } from './com.js';
import { compressedFormat } from './d3d-compressed.js';
import { levelGeometry, textureBytesPerPixel, freeTexture, invalidate } from './d3d9-textures.js';
import { releaseComReference } from './d3d9-programmable.js';

const INVALID = 0x8876086c;
const BASE =
  'QueryInterface AddRef Release GetDevice SetPrivateData GetPrivateData FreePrivateData SetPriority GetPriority PreLoad GetType SetLOD GetLOD GetLevelCount';
const VOLUME =
  'QueryInterface AddRef Release GetDevice SetPrivateData GetPrivateData FreePrivateData GetContainer GetDesc LockBox UnlockBox'.split(
    ' ',
  );

function box(r, pointer, level) {
  if (!pointer)
    return {
      left: 0,
      top: 0,
      right: level.width,
      bottom: level.height,
      front: 0,
      back: level.depth,
    };
  r.check(pointer, 24);
  const [left, top, right, bottom, front, back] = Array.from({ length: 6 }, (_, i) =>
    r.read32(pointer + i * 4),
  );
  return left < right &&
    right <= level.width &&
    top < bottom &&
    bottom <= level.height &&
    front < back &&
    back <= level.depth
    ? { left, top, right, bottom, front, back }
    : null;
}
function desc(r, out, s, level) {
  const values = [
    s.format,
    2,
    s.usage,
    s.pool,
    ...(s.version === 8 ? [level.slicePitch * level.depth] : []),
    level.width,
    level.height,
    level.depth,
  ];
  r.check(out, values.length * 4, true);
  values.forEach((v, i) => r.write32(out + i * 4, v));
}
function lock(r, s, level, out, regionPointer, flags) {
  if (
    !level ||
    !out ||
    level.locked ||
    (s.pool === 0 && !s.usage) ||
    flags & ~(0x10 | 0x800 | 0x1000 | 0x2000) ||
    (flags & 0x2000 && (!s.usage || regionPointer || flags & 0x10))
  )
    return INVALID;
  const region = box(r, regionPointer, level);
  if (!region) return INVALID;
  r.check(out, 12, true);
  r.write32(out, level.pitch);
  r.write32(out + 4, level.slicePitch);
  r.write32(
    out + 8,
    s.base +
      level.offset +
      region.front * level.slicePitch +
      region.top * level.pitch +
      region.left * s.bpp,
  );
  level.locked = { flags };
  return 0;
}
function unlock(o, level) {
  if (!level?.locked) return INVALID;
  if (!(level.locked.flags & 0x10)) invalidate(o);
  level.locked = null;
  return 0;
}
function getDevice(r, out, device) {
  r.check(out, 4, true);
  if (device.refs >= 0x7fffffff) throw Error('D3D device reference limit exceeded');
  device.refs++;
  r.write32(out, device.pointer);
  return 0;
}
function volume(r, texture, index) {
  const level = texture.state.levels[index];
  if (!level) return null;
  if (texture.refs >= 0x7fffffff) throw Error('D3D texture reference limit exceeded');
  texture.refs++;
  try {
    return r.comObjects.create({
      name: `IDirect3DVolume${texture.state.version}`,
      iid:
        texture.state.version === 8
          ? 'bd7349f5-14f1-42e4-9c79-972380db40c0'
          : '24f416e6-1f67-4aa7-b88e-d33f6f3128a1',
      methodNames: VOLUME,
      methods: {
        3: { argc: 2, invoke: (r, a) => getDevice(r, a(1), texture.state.device) },
        7: {
          argc: 3,
          invoke(r, a) {
            r.check(a(2), 4, true);
            r.write32(a(2), 0);
            if (![texture.iid, ...texture.iids].includes(readGuid(r, a(1)))) return 0x80004002;
            if (texture.refs >= 0x7fffffff) throw Error('D3D texture reference limit exceeded');
            texture.refs++;
            r.write32(a(2), texture.pointer);
            return 0;
          },
        },
        8: {
          argc: 2,
          invoke(r, a) {
            desc(r, a(1), texture.state, level);
            return 0;
          },
        },
        9: { argc: 4, invoke: (r, a) => lock(r, texture.state, level, a(1), a(2), a(3) >>> 0) },
        10: { argc: 1, invoke: () => unlock(texture, level) },
      },
      state: { texture, level, device: texture.state.device },
      onRelease: () => releaseComReference(texture),
    });
  } catch (error) {
    texture.refs--;
    throw error;
  }
}
export function createVolumeTextureMethod(version) {
  return {
    argc: version === 8 ? 9 : 10,
    invoke(r, a, device) {
      const [width, height, depth, requested, usage, format, pool, output] = Array.from(
        { length: 8 },
        (_, i) => a(i + 1) >>> 0,
      );
      if (!output) return INVALID;
      r.check(output, 4, true);
      r.write32(output, 0);
      const bpp = textureBytesPerPixel(format),
        fullCount = 1 + Math.floor(Math.log2(Math.max(width, height, depth))),
        count = requested || fullCount;
      if (
        ![width, height, depth].every((v) => v > 0 && v <= 256) ||
        !bpp ||
        !supportsGuestFormat(r, format) ||
        compressedFormat(format) ||
        ![0, 1, 2, 3].includes(pool) ||
        ![0, 0x200].includes(usage) ||
        (usage && pool !== 0) ||
        count < 1 ||
        count > fullCount ||
        (version === 9 && a(9))
      )
        return INVALID;
      let bytes = 0;
      const levels = Array.from({ length: count }, (_, i) => {
        const w = Math.max(1, width >> i),
          h = Math.max(1, height >> i),
          d = Math.max(1, depth >> i),
          { pitch } = levelGeometry(format, bpp, w, h);
        const level = {
          width: w,
          height: h,
          depth: d,
          pitch,
          slicePitch: pitch * h,
          offset: bytes,
          locked: null,
        };
        bytes += level.slicePitch * d;
        return level;
      });
      if ((r.d3dTextureBytes ?? 0) + bytes > 32 * 1024 * 1024) return 0x8876017c;
      if (device.refs >= 0x7fffffff) throw Error('D3D device reference limit exceeded');
      const base = r.allocate(bytes);
      r.d3dTextureBytes = (r.d3dTextureBytes ?? 0) + bytes;
      device.refs++;
      try {
        const shift = version === 8 ? 0 : 3;
        const object = r.comObjects.create({
          name: `IDirect3DVolumeTexture${version}`,
          iid:
            version === 8
              ? '4b8aaafa-140f-42ba-9131-597eafaa2ead'
              : '2518526c-e789-4111-a7b9-47ef328d13e6',
          iids:
            version === 8
              ? ['b4211cfa-51b9-4a9f-ab78-db99b2bb678e', '1b36bb7b-09b7-410a-b445-7d1430d7b33f']
              : ['580ca87e-1d3c-4d54-991d-b7d3e3c298ce', '05eec05d-8f7d-4362-b999-d1baf357c704'],
          methodNames:
            `${BASE} ${version === 9 ? 'SetAutoGenFilterType GetAutoGenFilterType GenerateMipSubLevels ' : ''}GetLevelDesc GetVolumeLevel LockBox UnlockBox AddDirtyBox`.split(
              ' ',
            ),
          methods: {
            3: { argc: 2, invoke: (r, a) => getDevice(r, a(1), device) },
            7: {
              argc: 2,
              invoke(_r, a, o) {
                const old = o.state.priority;
                o.state.priority = a(1) >>> 0;
                return old;
              },
            },
            8: { argc: 1, invoke: (_r, _a, o) => o.state.priority },
            10: { argc: 1, invoke: () => 4 },
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
              invoke(r, a, o) {
                const level = levels[a(1) >>> 0];
                if (!level || !a(2)) return INVALID;
                desc(r, a(2), o.state, level);
                return 0;
              },
            },
            [15 + shift]: {
              argc: 3,
              invoke(r, a, o) {
                if (!a(2)) return INVALID;
                r.check(a(2), 4, true);
                r.write32(a(2), 0);
                const view = volume(r, o, a(1) >>> 0);
                if (!view) return INVALID;
                r.write32(a(2), view.pointer);
                return 0;
              },
            },
            [16 + shift]: {
              argc: 5,
              invoke: (r, a, o) => lock(r, o.state, levels[a(1) >>> 0], a(2), a(3), a(4) >>> 0),
            },
            [17 + shift]: { argc: 2, invoke: (_r, a, o) => unlock(o, levels[a(1) >>> 0]) },
            [18 + shift]: {
              argc: 2,
              invoke(r, a, o) {
                if (!box(r, a(1), levels[0])) return INVALID;
                invalidate(o);
                return 0;
              },
            },
          },
          state: {
            kind: 'texture3d',
            device,
            width,
            height,
            depth,
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
