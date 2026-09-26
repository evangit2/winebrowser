import { ComObjects, readGuid } from './com.js';
import { DirectSoundMixer, soundTime, syncSound } from './dsound-mixer.js';

export const DS = {
  INVALID: 0x80070057,
  NOAGGREGATION: 0x80040110,
  UNSUPPORTED: 0x80004001,
  CONTROL: 0x8878001e,
  INVALIDCALL: 0x88780032,
  PRIORITY: 0x88780046,
  BADFORMAT: 0x88780064,
  NODRIVER: 0x88780078,
  INITIALIZED: 0x88780082,
  OUTOFMEMORY: 0x8007000e,
};
const DEVICE_IID = '279afa83-4981-11ce-a521-0020af0be560';
const DEVICE8_IID = 'c50a7e93-f395-4834-9ef6-7fa99de50966';
const BUFFER_IID = '279afa85-4981-11ce-a521-0020af0be560';
const BUFFER8_IID = '6825a449-7524-4d82-920f-50e36ab3ab1e';
const DEVICE_GUID = 'eadb5720-4f08-47d6-8db2-174de2ef3921';
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_GUIDS = [
  ZERO_GUID,
  DEVICE_GUID,
  'def00000-9c6d-47ed-aaf1-4dda8f2b5c03',
  'def00002-9c6d-47ed-aaf1-4dda8f2b5c03',
];
const DEVICE_METHODS =
  'QueryInterface AddRef Release CreateSoundBuffer GetCaps DuplicateSoundBuffer SetCooperativeLevel Compact GetSpeakerConfig SetSpeakerConfig Initialize VerifyCertification'.split(
    ' ',
  );
const BUFFER_METHODS =
  'QueryInterface AddRef Release GetCaps GetCurrentPosition GetFormat GetVolume GetPan GetFrequency GetStatus Initialize Lock Play SetCurrentPosition SetFormat SetVolume SetPan SetFrequency Stop Unlock Restore SetFX AcquireResources GetObjectInPath'.split(
    ' ',
  );
const DEFAULT_FORMAT = { channels: 2, rate: 44100, bits: 16, align: 4, average: 176400 };
const method = (argc, invoke) => ({ argc, invoke: (r, a, o) => invoke(r, a, o.state, o) });

function readFormat(r, p) {
  if (!p) return null;
  r.check(p, 16);
  const u16 = (o) => r.view.getUint16(p + o, true);
  const f = {
    channels: u16(2),
    rate: r.read32(p + 4),
    average: r.read32(p + 8),
    align: u16(12),
    bits: u16(14),
  };
  if (
    u16(0) !== 1 ||
    ![1, 2].includes(f.channels) ||
    ![8, 16].includes(f.bits) ||
    f.rate < 100 ||
    f.rate > 200000 ||
    f.align !== (f.channels * f.bits) / 8 ||
    f.average !== f.rate * f.align
  )
    return null;
  return f;
}
function formatBytes(f) {
  const bytes = new Uint8Array(18),
    v = new DataView(bytes.buffer);
  v.setUint16(0, 1, true);
  v.setUint16(2, f.channels, true);
  v.setUint32(4, f.rate, true);
  v.setUint32(8, f.average, true);
  v.setUint16(12, f.align, true);
  v.setUint16(14, f.bits, true);
  return bytes;
}
function writeGuid(r, p, guid) {
  const b = guid
    .replaceAll('-', '')
    .match(/../g)
    .map((s) => parseInt(s, 16));
  r.check(p, 16, true);
  r.data.set(
    [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15].map((i) => b[i]),
    p,
  );
}
function position(r, b) {
  syncSound(b, soundTime(r));
  const play = Math.floor(b.position) * b.format.align;
  return [
    play,
    b.playing ? (play + Math.ceil(b.frequency * 0.015) * b.format.align) % b.size : play,
  ];
}
function control(r, b, capability, key, value) {
  if (!(b.flags & capability)) return DS.CONTROL;
  const low = key === 'frequency' ? 100 : -10000,
    high = key === 'frequency' ? 200000 : key === 'pan' ? 10000 : 0;
  if (key === 'frequency' && !value) value = b.format.rate;
  if (value < low || value > high) return DS.INVALID;
  syncSound(b, soundTime(r));
  b[key] = value;
  return 0;
}

const bufferMethods = {
  3: method(2, (r, a, b) => {
    const p = a(1);
    if (!p || r.read32(p) < 20) return DS.INVALID;
    r.check(p, 20, true);
    [b.flags | 8, b.size, 0, 0].forEach((v, i) => r.write32(p + 4 + i * 4, v));
    return 0;
  }),
  4: method(3, (r, a, b) => {
    if (b.primary) return DS.UNSUPPORTED;
    const positions = position(r, b);
    for (let i = 0; i < 2; i++) if (a(i + 1)) r.write32(a(i + 1), positions[i]);
    return 0;
  }),
  5: method(4, (r, a, b) => {
    if (!a(1) && !a(3)) return DS.INVALID;
    const bytes = formatBytes(b.format),
      count = a(1) ? Math.min(18, a(2)) : 18;
    if (a(3)) r.write32(a(3), count);
    if (a(1)) {
      r.check(a(1), count, true);
      r.data.set(bytes.subarray(0, count), a(1));
    }
    return count < 18 ? DS.INVALID : 0;
  }),
  6: method(2, (r, a, b) => {
    if (!a(1)) return DS.INVALID;
    if (!(b.flags & 0x80)) return DS.CONTROL;
    r.write32(a(1), b.volume);
    return 0;
  }),
  7: method(2, (r, a, b) => {
    if (!a(1)) return DS.INVALID;
    if (!(b.flags & 0x40)) return DS.CONTROL;
    r.write32(a(1), b.pan);
    return 0;
  }),
  8: method(2, (r, a, b) => {
    if (!a(1)) return DS.INVALID;
    r.write32(a(1), b.frequency);
    return 0;
  }),
  9: method(2, (r, a, b) => {
    if (!a(1)) return DS.INVALID;
    syncSound(b, soundTime(r));
    const playing = b.primary
      ? b.playing || [...r.directSound.buffers].some((s) => s.device === b.device && s.playing)
      : b.playing;
    r.write32(a(1), playing ? 1 | (b.looping || b.primary ? 4 : 0) : 0);
    return 0;
  }),
  10: method(3, () => DS.INITIALIZED),
  11: method(8, (r, a, b) => {
    for (const i of [3, 4, 5, 6]) if (a(i)) r.write32(a(i), 0);
    if (!a(3) || !a(4) || a(7) & ~3) return DS.INVALID;
    if (b.primary) return DS.UNSUPPORTED;
    const offset = a(7) & 1 ? position(r, b)[1] : a(1),
      size = a(7) & 2 ? b.size : a(2);
    if (offset >= b.size || size > b.size) return DS.INVALID;
    const first = Math.min(size, b.size - offset),
      second = size - first;
    const lock = [
      b.storage.pointer + offset,
      first,
      second && a(5) ? b.storage.pointer : 0,
      second,
    ];
    for (let i = 0; i < 4; i++) if (a(i + 3)) r.write32(a(i + 3), lock[i]);
    return 0;
  }),
  12: method(4, (r, a, b) => {
    if (a(1) || a(2) || a(3) & ~1) return DS.INVALID;
    if (b.primary && !(a(3) & 1)) return DS.INVALID;
    syncSound(b, soundTime(r));
    b.time = soundTime(r);
    b.playing = true;
    b.looping = !!(a(3) & 1);
    r.directSound.start();
    return 0;
  }),
  13: method(2, (r, a, b) => {
    if (b.primary) return DS.INVALIDCALL;
    if (a(1) >= b.size) return DS.INVALID;
    b.position = Math.floor(a(1) / b.format.align);
    b.time = soundTime(r);
    return 0;
  }),
  14: method(2, (r, a, b) => {
    if (!b.primary) return DS.INVALIDCALL;
    if (b.device.state.cooperative < 2) return DS.PRIORITY;
    const format = readFormat(r, a(1));
    if (!format) return DS.BADFORMAT;
    b.format = format;
    b.frequency = format.rate;
    return 0;
  }),
  15: method(2, (r, a, b) => control(r, b, 0x80, 'volume', a(1) | 0)),
  16: method(2, (r, a, b) => control(r, b, 0x40, 'pan', a(1) | 0)),
  17: method(2, (r, a, b) => (b.primary ? DS.CONTROL : control(r, b, 0x20, 'frequency', a(1)))),
  18: method(1, (r, _a, b) => {
    syncSound(b, soundTime(r));
    b.playing = false;
    return 0;
  }),
  19: method(5, (_r, a, b) => {
    if (b.primary) return DS.UNSUPPORTED;
    const p = b.storage.pointer;
    if (
      a(1) < p ||
      a(1) >= p + b.size ||
      a(2) > p + b.size - a(1) ||
      a(4) > b.size ||
      (a(3) && a(3) !== p) ||
      (!a(3) && a(4)) ||
      a(2) + a(4) > b.size
    )
      return DS.INVALID;
    return 0;
  }),
  20: method(1, () => 0), // Software PCM storage is never lost by device reset.
};

function createBuffer(r, device, state) {
  device.refs++;
  let object;
  try {
    object = r.comObjects.create({
      name: 'IDirectSoundBuffer',
      iid: BUFFER_IID,
      iids: !state.primary && device.state.version8 ? [BUFFER8_IID] : [],
      methodNames: BUFFER_METHODS,
      methods: bufferMethods,
      state: { ...state, device },
      onRelease: ({ state: b }) => {
        b.playing = false;
        r.directSound.buffers.delete(b);
        if (b.primary) device.state.primary = null;
        else if (!--b.storage.refs) r.free(b.storage.pointer);
        device.refs--;
      },
    });
  } catch (error) {
    device.refs--;
    throw error;
  }
  r.directSound.buffers.add(object.state);
  return object;
}

const deviceMethods = {
  3: method(4, (r, a, d, device) => {
    if (!a(2)) return DS.INVALID;
    r.write32(a(2), 0);
    if (a(3)) return DS.NOAGGREGATION;
    const p = a(1);
    if (!p || ![20, 36].includes(r.read32(p))) return DS.INVALID;
    r.check(p, r.read32(p));
    const flags = r.read32(p + 4),
      size = r.read32(p + 8),
      formatPointer = r.read32(p + 16),
      primary = !!(flags & 1);
    // 3D, notifications, hardware allocation and effects need real interfaces.
    if (flags & ~0x1c0eb) return DS.UNSUPPORTED;
    if (r.read32(p + 12)) return DS.INVALID;
    if (primary && (size || formatPointer)) return DS.INVALID;
    if (primary && d.primary) {
      d.primary.refs++;
      r.write32(a(2), d.primary.pointer);
      return 0;
    }
    const format = primary ? { ...DEFAULT_FORMAT } : readFormat(r, formatPointer);
    if (!format) return DS.BADFORMAT;
    if (!primary && (!size || size > 4 * 1024 * 1024)) return size ? DS.OUTOFMEMORY : DS.INVALID;
    const count = primary ? 0 : Math.ceil(size / format.align) * format.align;
    if (r.comObjects.objects.size >= 64) return DS.OUTOFMEMORY;
    let storage = null;
    if (!primary) {
      try {
        storage = { pointer: r.allocate(count), refs: 1 };
      } catch (error) {
        if (error.message === 'Guest heap exhausted') return DS.OUTOFMEMORY;
        throw error;
      }
    }
    if (storage) r.data.fill(format.bits === 8 ? 128 : 0, storage.pointer, storage.pointer + count);
    let object;
    try {
      object = createBuffer(r, device, {
        primary,
        flags,
        format,
        storage,
        size: count,
        frames: count / format.align,
        frequency: format.rate,
        volume: 0,
        pan: 0,
        position: 0,
        time: soundTime(r),
        playing: false,
        looping: false,
      });
    } catch (error) {
      if (storage) r.free(storage.pointer);
      throw error;
    }
    if (primary) d.primary = object;
    r.write32(a(2), object.pointer);
    return 0;
  }),
  4: method(2, (r, a) => {
    const p = a(1);
    if (!p || r.read32(p) < 96) return DS.INVALID;
    r.check(p, 96, true);
    r.data.fill(0, p + 4, p + 96);
    r.write32(p + 4, 0xf1f);
    r.write32(p + 8, 100);
    r.write32(p + 12, 200000);
    r.write32(p + 16, 1);
    return 0;
  }),
  5: method(3, (r, a, _d, device) => {
    if (!a(2)) return DS.INVALID;
    r.write32(a(2), 0);
    const source = r.comObjects.objects.get(a(1));
    if (!source?.refs || source.state.device !== device) return DS.INVALID;
    if (source.state.primary) return DS.INVALIDCALL;
    if (r.comObjects.objects.size >= 64) return DS.OUTOFMEMORY;
    const b = source.state;
    const duplicate = createBuffer(r, device, {
      ...b,
      position: 0,
      time: soundTime(r),
      playing: false,
      looping: false,
    });
    b.storage.refs++;
    r.write32(a(2), duplicate.pointer);
    return 0;
  }),
  6: method(3, (r, a, d) => {
    const window = r.windows.windows.get(a(1));
    if (a(1) !== 0x101 && (!window || window.parentId)) return DS.INVALID;
    if (a(2) < 1 || a(2) > 4) return DS.INVALID;
    if (a(2) === 4) return DS.UNSUPPORTED;
    d.window = a(1);
    d.cooperative = a(2);
    return 0;
  }),
  7: method(1, (_r, _a, d) => (d.cooperative < 2 ? DS.PRIORITY : 0)),
  8: method(2, (r, a, d) => {
    if (!a(1)) return DS.INVALID;
    r.write32(a(1), d.speakers);
    return 0;
  }),
  9: method(2, (_r, a, d) => {
    if ((a(1) & 0xff00ffff) !== 4) return DS.UNSUPPORTED;
    d.speakers = a(1);
    return 0;
  }),
  10: method(2, () => DS.INITIALIZED),
  11: method(2, (r, a) => {
    if (!a(1)) return DS.INVALID;
    r.write32(a(1), 1);
    return 0;
  }), // uncertified
};

function createSound(r, a, version8) {
  const result = (value) => ({ result: value, argc: 3 });
  if (!a(1)) return result(DS.INVALID);
  r.write32(a(1), 0);
  if (a(2)) return result(DS.NOAGGREGATION);
  if (a(0) && !DEFAULT_GUIDS.includes(readGuid(r, a(0)))) return result(DS.NODRIVER);
  r.comObjects ??= new ComObjects(r);
  r.directSound ??= new DirectSoundMixer(r);
  if (r.comObjects.objects.size >= 64) return result(DS.OUTOFMEMORY);
  const object = r.comObjects.create({
    name: version8 ? 'IDirectSound8' : 'IDirectSound',
    iid: DEVICE_IID,
    iids: version8 ? [DEVICE8_IID] : [],
    methodNames: DEVICE_METHODS,
    methods: deviceMethods,
    state: { version8, cooperative: 0, window: 0, speakers: 0x140004, primary: null },
  });
  r.write32(a(1), object.pointer);
  return result(0);
}
async function enumerate(r, a, wide) {
  if (!a(0)) return { result: DS.INVALID, argc: 2 };
  const p = r.allocate(512);
  try {
    writeGuid(r, p, DEVICE_GUID);
    for (const [id, name] of [
      [0, 'Primary Sound Driver'],
      [p, 'WineBrowser audio'],
    ]) {
      const text = (offset, value) => {
        for (let i = 0; i <= value.length; i++) {
          if (wide) r.view.setUint16(p + offset + i * 2, value.charCodeAt(i) || 0, true);
          else r.data[p + offset + i] = value.charCodeAt(i) || 0;
        }
      };
      text(32, name);
      text(192, 'winebrowser.drv');
      if (!(await r.callGuest(a(0), [id, p + 32, p + 192, a(1)]))) break;
    }
  } finally {
    r.free(p);
  }
  return { result: 0, argc: 2 };
}
export const dsoundApis = {
  'dsound.dll!DirectSoundCreate': (r, a) => createSound(r, a, false),
  'dsound.dll!DirectSoundCreate8': (r, a) => createSound(r, a, true),
  'dsound.dll!DirectSoundEnumerateA': (r, a) => enumerate(r, a, false),
  'dsound.dll!DirectSoundEnumerateW': (r, a) => enumerate(r, a, true),
  'dsound.dll!GetDeviceID': (r, a) => {
    if (!a(0) || !a(1)) return { result: DS.INVALID, argc: 2 };
    const guid = readGuid(r, a(0));
    writeGuid(r, a(1), DEFAULT_GUIDS.includes(guid) ? DEVICE_GUID : guid);
    return { result: 0, argc: 2 };
  },
};
