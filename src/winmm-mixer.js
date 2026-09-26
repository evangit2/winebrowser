// One process-local WinMM output mixer. Its speaker and wave-source controls
// feed the browser PCM driver; it does not expose the host OS mixer or capture.
// PE32 structures/constants follow mmeapi.h and Wine 11's waveform.c contract.
const BADDEVICE = 2,
  BADHANDLE = 5,
  UNSUPPORTED = 8,
  BADFLAG = 10,
  BADPARAM = 11;
const BADLINE = 1024,
  BADCONTROL = 1025,
  BADVALUE = 1026;
const DESTINATION = 0xffff0000,
  HANDLE = 0x80000000;
const VOLUME = 0x50030001,
  MUTE = 0x20010002;
const state = (r) => (r.audioMixer ??= { values: [65535, 0, 65535, 0] });
const error = (result) => Object.assign(Error('WinMM mixer error'), { mixerResult: result });
function memory(r, pointer, size, write = false) {
  if (!pointer) throw error(BADPARAM);
  try {
    r.check(pointer, size, write);
  } catch {
    throw error(BADPARAM);
  }
}
function device(r, object, flags) {
  if (flags & HANDLE) {
    if (r.handles.get(object)?.kind !== 'mixer') throw error(BADHANDLE);
  } else if (object !== 0) throw error(BADDEVICE);
}
function query(r, a, max) {
  const flags = a(2) >>> 0;
  if (flags & ~0x8000000f || (flags & 15) > max) throw error(BADFLAG);
  device(r, a(0), flags);
  return flags & 15;
}
function structure(r, pointer, size, writable = true) {
  memory(r, pointer, size, writable);
  if (r.read32(pointer) !== size) throw error(BADPARAM);
}
function record(size) {
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer);
  return {
    bytes,
    u32: (offset, value) => view.setUint32(offset, value, true),
    text: (offset, value, count, wide) => {
      for (let i = 0; i < Math.min(value.length, count - 1); i++)
        if (wide) view.setUint16(offset + i * 2, value.charCodeAt(i), true);
        else bytes[offset + i] = value.charCodeAt(i);
    },
  };
}
function caps(r, a, wide) {
  const id = a(0),
    pointer = a(1),
    size = a(2),
    width = wide ? 2 : 1;
  device(r, id, r.handles.get(id)?.kind === 'mixer' ? HANDLE : 0);
  const result = record(16 + 32 * width),
    length = Math.min(size, result.bytes.length);
  memory(r, pointer, length, true);
  result.u32(4, 0x10000);
  result.text(8, 'WineBrowser PCM Output', 32, wide);
  result.u32(12 + 32 * width, 1);
  r.data.set(result.bytes.subarray(0, length), pointer);
  return 0;
}
function lineInfo(r, a, wide) {
  const mode = query(r, a, 4),
    pointer = a(1),
    width = wide ? 2 : 1;
  const size = 56 + 112 * width;
  structure(r, pointer, size);
  let source;
  if (mode === 0) {
    if (r.read32(pointer + 4) !== 0) throw error(BADLINE);
    source = false;
  }
  if (mode === 1) {
    if (r.read32(pointer + 4) || r.read32(pointer + 8)) throw error(BADLINE);
    source = true;
  }
  if (mode === 2) {
    const id = r.read32(pointer + 12);
    if (id !== DESTINATION && id !== 0) throw error(BADLINE);
    source = id === 0;
  }
  if (mode === 3) {
    const component = r.read32(pointer + 24);
    if (component !== 4 && component !== 0x1008) throw error(BADLINE);
    source = component === 0x1008;
  }
  if (mode === 4) {
    // The only declared target is the wave-output source, device zero.
    const target = pointer + 40 + 80 * width;
    if (r.read32(target) !== 1 || r.read32(target + 4) !== 0) throw error(BADLINE);
    source = true;
  }
  const result = record(size),
    target = 40 + 80 * width;
  result.u32(0, size);
  result.u32(8, source ? 0 : 0xffffffff);
  result.u32(12, source ? 0 : DESTINATION);
  result.u32(16, source ? 0x80000001 : 1);
  result.u32(24, source ? 0x1008 : 4);
  result.u32(28, 2);
  result.u32(32, source ? 0 : 1);
  result.u32(36, 2);
  result.text(40, source ? 'Wave' : 'Speakers', 16, wide);
  result.text(40 + 16 * width, source ? 'Wave playback' : 'WineBrowser PCM Output', 64, wide);
  result.u32(target, source ? 1 : 0);
  result.u32(target + 12, 0x10000);
  if (source) result.text(target + 16, 'WineBrowser PCM Output', 32, wide);
  r.data.set(result.bytes, pointer);
  return 0;
}
function controls(r, a, wide) {
  const mode = query(r, a, 2),
    pointer = a(1),
    width = wide ? 2 : 1;
  structure(r, pointer, 24);
  const line = r.read32(pointer + 4),
    selector = r.read32(pointer + 8);
  if (line !== 0 && line !== DESTINATION) throw error(BADLINE);
  const first = line === DESTINATION ? 0 : 2;
  let ids;
  if (mode === 0) ids = [first, first + 1];
  else if (mode === 1) {
    if (selector !== first && selector !== first + 1) throw error(BADCONTROL);
    ids = [selector];
  } else {
    if (selector !== VOLUME && selector !== MUTE) throw error(BADCONTROL);
    ids = [first + (selector === MUTE ? 1 : 0)];
  }
  const size = 68 + 80 * width,
    output = r.read32(pointer + 20);
  // Windows/Wine tolerate a stale count for ONEBYTYPE and assume one control.
  if ((mode !== 2 && r.read32(pointer + 12) !== ids.length) || r.read32(pointer + 16) !== size)
    throw error(BADPARAM);
  memory(r, output, size * ids.length, true);
  ids.forEach((id, index) => {
    const result = record(size),
      muted = id % 2;
    result.u32(0, size);
    result.u32(4, id);
    result.u32(8, muted ? MUTE : VOLUME);
    result.u32(12, 1); // UNIFORM: one value applies to every channel.
    result.text(20, muted ? 'Mute' : 'Volume', 16, wide);
    result.text(20 + 16 * width, muted ? 'Mute' : 'Volume', 64, wide);
    result.u32(24 + 80 * width, muted ? 1 : 65535);
    result.u32(44 + 80 * width, muted ? 2 : 65536);
    r.data.set(result.bytes, output + index * size);
  });
  return 0;
}
function details(r, a, set) {
  const mode = query(r, a, 1),
    pointer = a(1);
  if (mode) throw error(UNSUPPORTED); // No list-text/custom controls.
  structure(r, pointer, 24, false);
  const id = r.read32(pointer + 4),
    output = r.read32(pointer + 20);
  if (id > 3) throw error(BADCONTROL);
  if (r.read32(pointer + 8) !== 1 || r.read32(pointer + 12) || r.read32(pointer + 16) !== 4)
    throw error(BADPARAM);
  memory(r, output, 4, !set);
  if (set) {
    const value = r.read32(output);
    if (value > (id % 2 ? 1 : 65535)) throw error(BADVALUE);
    state(r).values[id] = value;
  } else r.write32(output, state(r).values[id]);
  return 0;
}
const api = (argc, call) => (r, a) => {
  try {
    return { result: call(r, a), argc };
  } catch (failure) {
    if (failure.mixerResult === undefined) throw failure;
    return { result: failure.mixerResult, argc };
  }
};
export const mixerApis = {
  'winmm.dll!mixerGetNumDevs': api(0, () => 1),
  'winmm.dll!mixerOpen': api(5, (r, a) => {
    if (![0, 0x10000, 0x20000, 0x30000, 0x50000].includes(a(4))) throw error(BADFLAG);
    if (a(4)) throw error(UNSUPPORTED);
    device(r, a(1), 0);
    memory(r, a(0), 4, true);
    const handle = r.nextHandle++;
    r.handles.set(handle, { kind: 'mixer' });
    r.write32(a(0), handle);
    return 0;
  }),
  'winmm.dll!mixerClose': api(1, (r, a) => {
    device(r, a(0), HANDLE);
    r.handles.delete(a(0));
    return 0;
  }),
  'winmm.dll!mixerGetID': api(3, (r, a) => {
    query(r, a, 0);
    memory(r, a(1), 4, true);
    r.write32(a(1), 0);
    return 0;
  }),
  'winmm.dll!mixerMessage': api(4, (r, a) => {
    device(r, a(0), HANDLE);
    return UNSUPPORTED;
  }),
  'winmm.dll!mixerSetControlDetails': api(3, (r, a) => details(r, a, true)),
};
for (const wide of [false, true]) {
  const suffix = wide ? 'W' : 'A';
  mixerApis['winmm.dll!mixerGetDevCaps' + suffix] = api(3, (r, a) => caps(r, a, wide));
  mixerApis['winmm.dll!mixerGetLineInfo' + suffix] = api(3, (r, a) => lineInfo(r, a, wide));
  mixerApis['winmm.dll!mixerGetLineControls' + suffix] = api(3, (r, a) => controls(r, a, wide));
  mixerApis['winmm.dll!mixerGetControlDetails' + suffix] = api(3, (r, a) => details(r, a, false));
}

export function applyMixerGain(runtime, wave) {
  const [master, masterMute, source, sourceMute] = state(runtime).values;
  const gain = masterMute || sourceMute ? 0 : (master / 65535) * (source / 65535);
  if (gain === 1) return wave;
  return {
    ...wave,
    samples: wave.samples.map((channel) => channel.map((sample) => sample * gain)),
  };
}
