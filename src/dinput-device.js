import { readGuid } from './com.js';
import { DI } from './dinput-errors.js';
import { directInputKey } from './input-scancodes.js';
import { DESKTOP_WINDOW } from './win32-gdi.js';

const MAX_DATA = 65536,
  MAX_OBJECTS = 1024,
  MAX_BUFFER = 4096;
const KEY_GUID = '55728220-d33c-11cf-bfc7-444553540000';
const BUTTON_GUID = 'a36d02f0-c9f3-11cf-bfc7-444553540000';
const AXES = [0, 1, 2].map((i) => `a36d02e${i}-c9f3-11cf-bfc7-444553540000`);

function objects(device) {
  if (device.kind === 'keyboard')
    return Array.from({ length: 256 }, (_, i) => ({
      id: i,
      instance: i,
      type: 4,
      guid: KEY_GUID,
      width: 1,
    }));
  return [
    ...AXES.map((guid, i) => ({ id: i, instance: i, type: 1, guid, width: 4 })),
    ...Array.from({ length: device.buttons }, (_, i) => ({
      id: i + 3,
      instance: i,
      type: 4,
      guid: BUTTON_GUID,
      width: 1,
    })),
  ];
}

function unacquire(state) {
  const acquired = state.acquired;
  state.acquired = false;
  state.values.fill(0);
  state.queue.length = 0;
  state.overflow = false;
  return acquired ? 0 : 1;
}

class DirectInputState {
  constructor(runtime) {
    this.runtime = runtime;
    this.devices = new Set();
    this.keys = new Uint8Array(256);
    this.mouse = new Int32Array(8);
    this.mousePosition = null;
    this.focused = true;
    this.sequence = 0;
  }
  available(state) {
    const m = this.runtime.windows;
    return (
      this.focused &&
      (!(state.coop & 4) ||
        (m.active === state.hwnd && m.isVisible(state.hwnd) && m.isEnabled(state.hwnd)))
    );
  }
  foregroundChanged() {
    for (const state of this.devices)
      if (state.acquired && !this.available(state)) unacquire(state);
  }
  blur() {
    this.focused = false;
    this.keys.fill(0);
    this.mouse.fill(0);
    this.mousePosition = null;
    for (const state of this.devices) unacquire(state);
  }
  input(event, window) {
    if (event.type === 'focus') {
      this.focused = true;
      this.foregroundChanged();
      return;
    }
    const updates = [],
      mouseEvent = ['mousemove', 'mousedown', 'mouseup', 'wheel'].includes(event.type);
    let kind;
    if (event.type === 'keydown' || event.type === 'keyup') {
      kind = 'keyboard';
      const id = directInputKey(event.code),
        value = event.type === 'keydown' ? 0x80 : 0;
      if (id === null) return false;
      if (this.keys[id] !== value) {
        this.keys[id] = value;
        updates.push([id, value]);
      }
    } else if (mouseEvent) {
      kind = 'mouse';
      if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) return false;
      const origin = this.runtime.windows.clientPosition(window),
        position = [origin[0] + event.x, origin[1] + event.y];
      for (let i = 0; i < 2; i++) {
        const supplied = event[i ? 'movementY' : 'movementX'];
        const delta = Number.isFinite(supplied)
          ? Math.trunc(supplied)
          : this.mousePosition
            ? Math.trunc(position[i] - this.mousePosition[i])
            : 0;
        if (delta) updates.push([i, delta]);
        this.mouse[i] = position[i] | 0;
      }
      this.mousePosition = position;
      if (event.type === 'wheel' && Number.isFinite(event.wheelDelta)) {
        const delta = Math.trunc(event.wheelDelta);
        this.mouse[2] = (this.mouse[2] + delta) | 0;
        if (delta) updates.push([2, delta]);
      }
      if (Number.isInteger(event.buttons))
        for (let i = 0; i < 5; i++) {
          const mask = [1, 2, 4, 8, 16][i],
            value = event.buttons & mask ? 0x80 : 0;
          if (this.mouse[i + 3] === value) continue;
          this.mouse[i + 3] = value;
          updates.push([i + 3, value]);
        }
    } else return false;
    const sequence = ++this.sequence >>> 0;
    const timestamp = Number(this.runtime.performanceClock.read() / 1_000_000n) >>> 0;
    this.foregroundChanged();
    let exclusive = false;
    for (const state of this.devices) {
      if (!state.acquired || state.device.kind !== kind) continue;
      exclusive ||=
        !!(state.coop & 1) ||
        !!(kind === 'keyboard' && state.coop & 16 && event.code?.startsWith('Meta'));
      for (const [id, value] of updates) {
        const axis = kind === 'mouse' && id < 3;
        state.values[id] = axis ? (state.values[id] + value) | 0 : value;
        const field = state.format.fields.find((field) => field.id === id);
        if (!field || !state.bufferSize || state.overflow) continue;
        if (state.queue.length >= state.bufferSize - 1) {
          state.overflow = true;
          continue;
        }
        state.queue.push({
          offset: field.offset,
          value: axis && state.format.absolute ? this.mouse[id] : value,
          timestamp,
          sequence,
        });
      }
    }
    return exclusive;
  }
}

export function inputState(r) {
  return (r.directInput ??= new DirectInputState(r));
}

export function createInputDeviceState(r, device) {
  const input = inputState(r);
  const state = {
    device,
    objects: objects(device),
    acquired: false,
    format: null,
    coop: 10,
    hwnd: 0,
    values: new Int32Array(device.kind === 'keyboard' ? 256 : 8),
    absolute: false,
    bufferSize: 0,
    queue: [],
    overflow: false,
  };
  input.devices.add(state);
  return state;
}
export function releaseInputDevice(r, state) {
  unacquire(state);
  r.directInput.devices.delete(state);
}

function setDataFormat(r, p, state) {
  if (!p) return DI.POINTER;
  r.check(p, 24);
  if (r.read32(p) !== 24 || r.read32(p + 4) !== 16) return DI.INVALID;
  if (state.acquired) return DI.ACQUIRED;
  state.format = null;
  const flags = r.read32(p + 8),
    size = r.read32(p + 12),
    count = r.read32(p + 16),
    array = r.read32(p + 20);
  if (flags > 2 || size > MAX_DATA || count > MAX_OBJECTS || (count && !array)) return DI.INVALID;
  r.check(array, count * 16);
  const fields = [],
    defaults = [],
    matched = new Set();
  for (let i = 0; i < count; i++) {
    const q = array + i * 16,
      guid = r.read32(q) ? readGuid(r, r.read32(q)) : null,
      offset = r.read32(q + 4),
      type = r.read32(q + 8),
      instance = (type >>> 8) & 0xffff,
      objectFlags = r.read32(q + 12);
    if (objectFlags && objectFlags !== 0x100)
      throw Error('DirectInput data format aspects other than position are unsupported');
    if (type & 0x7f000000)
      throw Error('DirectInput output/actuator/alias data formats are unsupported');
    const object = state.objects.find(
      (o) =>
        !matched.has(o.id) &&
        (!guid || guid === o.guid) &&
        (instance === 0xffff || instance === o.instance) &&
        type & 0xff & o.type,
    );
    const width = object?.width ?? (type & 0xc ? 1 : type & 0x13 ? 4 : 0);
    if (!width || offset > size || width > size - offset) return DI.INVALID;
    if (object) {
      matched.add(object.id);
      fields.push({ ...object, offset });
    } else if (!(type & 0x80000000)) return DI.INVALID;
    else if (type & 0x10) defaults.push(offset);
  }
  fields.sort((a, b) => b.id - a.id);
  state.absolute = !!(flags & 1);
  state.format = { size, absolute: state.absolute, fields, defaults };
  state.values.fill(0);
  state.queue.length = 0;
  state.overflow = false;
  return 0;
}

function acquired(r, state) {
  r.directInput.foregroundChanged();
  return state.acquired ? 0 : DI.NOTACQUIRED;
}

function property(r, a, state, set) {
  const id = a(1),
    p = a(2);
  if (!p) return DI.POINTER;
  r.check(p, 16);
  if (r.read32(p + 4) !== 16) return DI.INVALID;
  if (![1, 2].includes(id)) throw Error(`Unsupported DirectInput property ${id}`);
  if (r.read32(p) !== 20 || r.read32(p + 8)) return DI.INVALID;
  if (r.read32(p + 12)) return DI.UNSUPPORTED;
  r.check(p, 20, !set);
  if (!set) {
    r.write32(
      p + 16,
      id === 1 ? state.bufferSize : (state.format?.absolute ?? state.absolute) ? 0 : 1,
    );
    return 0;
  }
  if (state.acquired) return DI.ACQUIRED;
  const value = r.read32(p + 16);
  if (id === 1) {
    if (value > MAX_BUFFER) return DI.INVALID;
    state.bufferSize = value;
    state.queue.length = 0;
    state.overflow = false;
  } else {
    if (value > 1) return DI.INVALID;
    state.absolute = !value;
    if (state.format) state.format.absolute = !value;
    state.values.fill(0);
  }
  return 0;
}

export const deviceStateMethods = {
  5: { argc: 3, invoke: (r, a, o) => property(r, a, o.state, false) },
  6: { argc: 3, invoke: (r, a, o) => property(r, a, o.state, true) },
  7: {
    argc: 1,
    invoke(r, _a, { state }) {
      r.directInput.foregroundChanged();
      if (state.acquired) return 1;
      if (!state.format) return DI.INVALID;
      if (!r.directInput.available(state)) return DI.PRIORITY;
      for (const other of r.directInput.devices)
        if (
          other !== state &&
          other.acquired &&
          other.device.kind === state.device.kind &&
          (state.coop | other.coop) & 1
        )
          return DI.PRIORITY;
      state.values.fill(0);
      if (state.device.kind === 'keyboard') state.values.set(r.directInput.keys);
      else state.values.set(r.directInput.mouse.subarray(3), 3);
      state.queue.length = 0;
      state.overflow = false;
      state.acquired = true;
      return 0;
    },
  },
  8: { argc: 1, invoke: (_r, _a, o) => unacquire(o.state) },
  9: {
    argc: 3,
    invoke(r, a, { state }) {
      const size = a(1),
        p = a(2);
      if (!p) return DI.INVALID;
      const error = acquired(r, state);
      if (error) return error;
      if (size !== state.format.size) return DI.INVALID;
      r.check(p, size, true);
      r.data.fill(0, p, p + size);
      for (const field of state.format.fields)
        if (field.width === 1) r.data[p + field.offset] = state.values[field.id];
      for (const offset of state.format.defaults) r.write32(p + offset, 0xffffffff);
      for (const field of state.format.fields)
        if (field.width === 4)
          r.write32(
            p + field.offset,
            state.format.absolute ? r.directInput.mouse[field.id] : state.values[field.id],
          );
      if (state.device.kind === 'mouse' && !state.format.absolute) state.values.fill(0, 0, 3);
      return 0;
    },
  },
  10: {
    argc: 5,
    invoke(r, a, { state }) {
      const size = a(1),
        p = a(2),
        countp = a(3),
        flags = a(4);
      if (!countp || ![16, 20].includes(size) || flags & ~1) return DI.INVALID;
      r.check(countp, 4, true);
      if (!state.bufferSize) return DI.NOTBUFFERED;
      const error = acquired(r, state);
      if (error) return error;
      const count = Math.min(r.read32(countp), state.queue.length),
        result = state.overflow ? 1 : 0;
      if (p) {
        r.check(p, count * size, true);
        for (let i = 0; i < count; i++) {
          const e = state.queue[i],
            values = [e.offset, e.value, e.timestamp, e.sequence, 0xffffffff];
          for (let j = 0; j < size / 4; j++) r.write32(p + i * size + j * 4, values[j]);
        }
      }
      r.write32(countp, count);
      if (!(flags & 1)) {
        state.queue.splice(0, count);
        state.overflow = false;
      }
      return result;
    },
  },
  11: { argc: 2, invoke: (r, a, o) => setDataFormat(r, a(1), o.state) },
  12: {
    argc: 2,
    invoke(_r, a, o) {
      if (o.state.acquired) return DI.ACQUIRED;
      if (a(1)) throw Error('DirectInput event notification handles are unsupported');
      return 0;
    },
  },
  13: {
    argc: 3,
    invoke(r, a, { state }) {
      const hwnd = a(1),
        flags = a(2),
        window = r.windows.windows.get(hwnd);
      if (![1, 2].includes(flags & 3) || ![4, 8].includes(flags & 12) || flags & ~31)
        return DI.INVALID;
      if ((hwnd || flags !== 10) && hwnd !== DESKTOP_WINDOW && (!window || window.parentId))
        return DI.HANDLE;
      if (flags & 1 && flags & 8) return DI.UNSUPPORTED;
      if (state.acquired) return DI.ACQUIRED;
      state.hwnd = hwnd;
      state.coop = flags;
      return 0;
    },
  },
  25: { argc: 1, invoke: (r, _a, o) => acquired(r, o.state) || 1 },
};
