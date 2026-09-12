import { normalizePath } from './package.js';
import { decodeWave } from './wave.js';

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
  return { result: (await runtime.request('pcm', wave)) ? 1 : 0, argc: 3 };
}

export const audioApis = {
  'winmm.dll!PlaySoundA': (r, a) => playSound(r, a, false),
  'winmm.dll!PlaySoundW': (r, a) => playSound(r, a, true),
};
