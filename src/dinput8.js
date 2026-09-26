import { ComObjects, readGuid } from './com.js';

import { DI } from './dinput-errors.js';
export { DI } from './dinput-errors.js';
import { deviceStateMethods, createInputDeviceState, releaseInputDevice } from './dinput-device.js';
const UNKNOWN = '00000000-0000-0000-c000-000000000046';
const INPUT_IIDS = ['bf798030-483a-4da2-aa99-5d64ed369700', 'bf798031-483a-4da2-aa99-5d64ed369700'];
const DEVICE_IIDS = [
  '54d41080-dc15-4833-a41b-748f73a38179',
  '54d41081-dc15-4833-a41b-748f73a38179',
];
export const INPUT_METHODS =
  'QueryInterface AddRef Release CreateDevice EnumDevices GetDeviceStatus RunControlPanel Initialize FindDevice EnumDevicesBySemantics ConfigureDevices'.split(
    ' ',
  );
export const DEVICE_METHODS =
  'QueryInterface AddRef Release GetCapabilities EnumObjects GetProperty SetProperty Acquire Unacquire GetDeviceState GetDeviceData SetDataFormat SetEventNotification SetCooperativeLevel GetObjectInfo GetDeviceInfo RunControlPanel Initialize CreateEffect EnumEffects GetEffectInfo GetForceFeedbackState SendForceFeedbackCommand EnumCreatedEffectObjects Escape Poll SendDeviceData EnumEffectsInFile WriteEffectToFile BuildActionMap SetActionMap GetImageInfo'.split(
    ' ',
  );
const DEVICES = [
  {
    kind: 'mouse',
    guid: '6f1d2b60-d5a0-11cf-bfc7-444553540000',
    name: 'Mouse',
    type: 0x212,
    axes: 3,
    buttons: 5,
    deviceClass: 2,
  },
  {
    kind: 'keyboard',
    guid: '6f1d2b61-d5a0-11cf-bfc7-444553540000',
    name: 'Keyboard',
    type: 0x413,
    axes: 0,
    buttons: 256,
    deviceClass: 3,
  },
];

function versionError(instance, version) {
  return !instance
    ? DI.INVALID
    : !version
      ? DI.NOTINITIALIZED
      : version < 0x800
        ? DI.BETA
        : version > 0x800
          ? DI.OLD
          : 0;
}
function deviceFor(r, p) {
  return p ? DEVICES.find((d) => d.guid === readGuid(r, p)) : null;
}
function writeGuid(r, p, guid) {
  const parts = guid.split('-');
  r.write32(p, parseInt(parts[0], 16));
  r.view.setUint16(p + 4, parseInt(parts[1], 16), true);
  r.view.setUint16(p + 6, parseInt(parts[2], 16), true);
  (parts[3] + parts[4]).match(/../g).forEach((byte, i) => {
    r.data[p + 8 + i] = parseInt(byte, 16);
  });
}

function writeInfo(r, p, device, wide, size) {
  r.check(p, size, true);
  r.data.fill(0, p, p + size);
  r.write32(p, size);
  writeGuid(r, p + 4, device.guid);
  writeGuid(r, p + 20, device.guid);
  r.write32(p + 36, device.type);
  for (const [offset, text] of [
    [40, device.name],
    [40 + 260 * (wide ? 2 : 1), `WineBrowser ${device.name}`],
  ])
    for (let i = 0; i < text.length; i++) {
      if (wide) r.view.setUint16(p + offset + i * 2, text.charCodeAt(i), true);
      else r.data[p + offset + i] = text.charCodeAt(i);
    }
}

// A/W interfaces have different string layouts but one COM identity/lifetime.
function interfaces(r, name, iids, methodNames, state, methods, onRelease) {
  r.comObjects ??= new ComObjects(r);
  if (r.comObjects.liveObjects > 62) throw Error('COM object limit exceeded');
  const views = [],
    lifetime = { refs: 1 };
  for (const wide of [false, true]) {
    const view = r.comObjects.create({
      name: `${name}${wide ? 'W' : 'A'}`,
      iid: iids[Number(wide)],
      methodNames,
      state,
      methods: methods(wide),
      onRelease,
      queryInterface: (iid) => (iid === UNKNOWN ? views[0] : views[iids.indexOf(iid)]),
    });
    Object.defineProperty(view, 'refs', {
      get: () => lifetime.refs,
      set: (value) => {
        lifetime.refs = value;
      },
    });
    views.push(view);
  }
  return views;
}

function deviceMethods(wide) {
  return {
    ...deviceStateMethods,
    3: {
      argc: 2,
      invoke(r, a, object) {
        const p = a(1);
        if (!p) return DI.POINTER;
        const size = r.read32(p);
        if (![24, 44].includes(size)) return DI.INVALID;
        r.check(p, size, true);
        const d = object.state.device;
        // Attached keyboard/mouse; no force-feedback or emulated hardware claims.
        const values = [size, 1, d.type, d.axes, d.buttons, 0, 0, 0, 0, 0, 0];
        for (let i = 0; i < size / 4; i++) r.write32(p + i * 4, values[i]);
        return 0;
      },
    },
    15: {
      argc: 2,
      invoke(r, a, object) {
        const p = a(1);
        if (!p) return DI.POINTER;
        const size = r.read32(p),
          valid = wide ? [1080, 1100] : [560, 580];
        if (!valid.includes(size)) return DI.INVALID;
        writeInfo(r, p, object.state.device, wide, size);
        return 0;
      },
    },
  };
}

function inputMethods(wide) {
  return {
    3: {
      argc: 4,
      invoke(r, a, factory) {
        const out = a(2);
        if (!out) return DI.POINTER;
        r.write32(out, 0);
        if (!a(1)) return DI.POINTER;
        if (!factory.state.initialized) return DI.NOTINITIALIZED;
        if (a(3)) throw Error('DirectInput COM aggregation is unsupported');
        const device = deviceFor(r, a(1));
        if (!device) return DI.DEVICENOTREG;
        const state = createInputDeviceState(r, device);
        const views = interfaces(
          r,
          'IDirectInputDevice8',
          DEVICE_IIDS,
          DEVICE_METHODS,
          state,
          deviceMethods,
          () => {
            releaseInputDevice(r, state);
            factory.refs--;
          },
        );
        factory.refs++;
        r.write32(out, views[Number(wide)].pointer);
        return 0;
      },
    },
    4: {
      argc: 5,
      async invoke(r, a, object) {
        const type = a(1),
          callback = a(2),
          flags = a(4);
        if (!callback || (type > 4 && type < 0x11) || type > 0x1c || flags & ~0x70101)
          return DI.INVALID;
        if (!object.state.initialized) return DI.NOTINITIALIZED;
        if (flags & 0x100) return 0; // Neither browser device exposes force feedback.
        const size = wide ? 1100 : 580,
          p = r.allocate(size);
        try {
          for (const device of DEVICES) {
            if (type && type !== device.deviceClass && type !== (device.type & 0xff)) continue;
            writeInfo(r, p, device, wide, size);
            if (!(await r.callGuest(callback, [p, a(3)]))) break;
          }
        } finally {
          r.free(p);
        }
        return 0;
      },
    },
    5: {
      argc: 2,
      invoke(r, a, object) {
        if (!a(1)) return DI.POINTER;
        if (!object.state.initialized) return DI.NOTINITIALIZED;
        return deviceFor(r, a(1)) ? 0 : DI.DEVICENOTREG;
      },
    },
    7: {
      argc: 3,
      invoke(_r, a, object) {
        const error = versionError(a(1), a(2));
        if (!error) object.state.initialized = true;
        return error;
      },
    },
  };
}

export const dinput8Apis = {
  'dinput8.dll!DirectInput8Create': (r, a) => {
    const out = a(3),
      result = (value) => ({ result: value, argc: 5 });
    if (!out) return result(DI.POINTER);
    r.write32(out, 0);
    if (!a(2)) return result(DI.POINTER);
    const iid = readGuid(r, a(2)),
      wide = INPUT_IIDS.indexOf(iid);
    if (wide < 0 && iid !== UNKNOWN) return result(DI.NOINTERFACE);
    if (a(4)) throw Error('DirectInput COM aggregation is unsupported');
    const error = versionError(a(0), a(1));
    if (error) return result(error);
    const views = interfaces(
      r,
      'IDirectInput8',
      INPUT_IIDS,
      INPUT_METHODS,
      { initialized: true },
      inputMethods,
    );
    r.write32(out, views[Math.max(0, wide)].pointer);
    return result(0);
  },
};
