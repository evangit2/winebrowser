import { readGuid } from './com.js';
const INVALID = 0x80070057,
  NOT_FOUND = 0x887a0002,
  MORE_DATA = 0x887a0003;
async function replace(r, object, key, value) {
  const entries = (object.state.privateData ??= new Map());
  if (value && !entries.has(key) && entries.size >= 64) return 0x8007000e;
  const total = [...entries].reduce(
    (sum, [k, v]) => sum + (k === key ? 0 : (v.bytes?.length ?? 4)),
    0,
  );
  if (total + (value?.bytes?.length ?? (value ? 4 : 0)) > 1024 * 1024) return 0x8007000e;
  if (value?.object) r.comObjects.retain(value.object);
  const previous = entries.get(key);
  if (value) entries.set(key, value);
  else entries.delete(key);
  if (previous?.object) await r.comObjects.release(previous.object);
  return 0;
}
export async function releasePrivateData(r, object) {
  const entries = object.state.privateData;
  if (!entries) return;
  object.state.privateData = new Map();
  for (const value of entries.values()) if (value.object) await r.comObjects.release(value.object);
}
export const privateDataMethods = {
  GetPrivateData: {
    argc: 4,
    invoke(r, a, object) {
      const key = readGuid(r, a(1) >>> 0),
        sizePointer = a(2) >>> 0,
        dataPointer = a(3) >>> 0;
      if (!sizePointer) return INVALID;
      r.check(sizePointer, 4, true);
      const capacity = r.read32(sizePointer),
        value = object.state.privateData?.get(key);
      if (!value) {
        r.write32(sizePointer, 0);
        return NOT_FOUND;
      }
      const required = value.object ? 4 : value.bytes.length;
      if (dataPointer && capacity >= required) r.check(dataPointer, required, true);
      r.write32(sizePointer, required);
      if (!dataPointer) return 0;
      if (capacity < required) return MORE_DATA;
      if (value.object) {
        r.comObjects.retain(value.object);
        r.write32(dataPointer, value.object.pointer);
      } else r.data.set(value.bytes, dataPointer);
      return 0;
    },
  },
  SetPrivateData: {
    argc: 4,
    invoke(r, a, object) {
      const key = readGuid(r, a(1) >>> 0),
        size = a(2) >>> 0,
        pointer = a(3) >>> 0;
      if (size > 65536 || (size && !pointer)) return INVALID;
      if (size) r.check(pointer, size);
      return replace(
        r,
        object,
        key,
        size ? { bytes: r.data.slice(pointer, pointer + size) } : null,
      );
    },
  },
  SetPrivateDataInterface: {
    argc: 3,
    invoke(r, a, object) {
      const key = readGuid(r, a(1) >>> 0),
        pointer = a(2) >>> 0;
      const value = pointer ? r.comObjects?.objects.get(pointer) : null;
      if (pointer && !value?.refs) return INVALID;
      return replace(r, object, key, value ? { object: value } : null);
    },
  },
};
