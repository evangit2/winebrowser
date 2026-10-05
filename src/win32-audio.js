import { normalizePath } from './package.js';
import { decodeWave } from './wave.js';
import { mixerApis, applyMixerGain } from './winmm-mixer.js';
import { multimediaTimeApis } from './winmm-time.js';
import { driverApis } from './winmm-driver.js';
import { dsoundApis } from './dsound.js';
import { mmioApis } from './winmm-mmio.js';

async function playSound(runtime, argument, wide) {
  const name = argument(0),
    module = argument(1),
    flags = argument(2);
  // Synchronous filename playback is the supported driver contract. Registry
  // aliases, resource lookup and asynchronous lifetime handling need Wine services.
  if (module || flags & ~0x20002)
    throw Error('PlaySound supports synchronous SND_FILENAME/ SND_NODEFAULT only');
  if (!name) return { result: 1, argc: 3 }; // No asynchronous voice can remain active.
  if (!(flags & 0x20000)) throw Error('PlaySound requires SND_FILENAME');
  const value = wide ? runtime.wideString(name) : runtime.string(name);
  let bytes;
  try {
    if (value.length > 255) return { result: 0, argc: 3 };
    bytes = runtime.files.get(
      normalizePath(runtime.cwd + normalizePath(value.replaceAll('\\', '/'))),
    );
  } catch {
    return { result: 0, argc: 3 };
  }
  if (!bytes) return { result: 0, argc: 3 };
  let wave;
  try {
    wave = decodeWave(bytes);
  } catch (error) {
    runtime.emit({ type: 'log', text: error.message });
    return { result: 0, argc: 3 };
  }
  return { result: (await runtime.request('pcm', applyMixerGain(runtime, wave))) ? 1 : 0, argc: 3 };
}

export const audioApis = {
  ...mmioApis,
  ...dsoundApis,
  ...driverApis,
  ...mixerApis,
  ...multimediaTimeApis,
  // No WinMM joystick device is exposed by the current input backend.
  'winmm.dll!joyGetNumDevs': () => ({ result: 0, argc: 0 }),
  'winmm.dll!joyGetDevCapsA': () => ({ result: 2, argc: 3 }),
  'winmm.dll!joyGetDevCapsW': () => ({ result: 2, argc: 3 }),
  'winmm.dll!joyGetPosEx': (r, a) => {
    if (!a(1)) return { result: 165, argc: 2 };
    r.check(a(1), 52);
    return { result: r.read32(a(1)) === 52 ? 167 : 165, argc: 2 };
  },
  'winmm.dll!PlaySoundA': (r, a) => playSound(r, a, false),
  'winmm.dll!PlaySoundW': (r, a) => playSound(r, a, true),
};
