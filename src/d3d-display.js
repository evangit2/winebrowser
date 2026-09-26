import { VIRTUAL_DISPLAY_MODE } from './win32-display.js';

const INVALID = 0x8876086c;
const X8R8G8B8 = 22;
const NOT_AVAILABLE = 0x8876086a;

function writeMode(runtime, pointer) {
  // Validate the complete structure before writing any fields.
  if (!pointer) return INVALID;
  try {
    runtime.check(pointer, 16, true);
  } catch {
    return INVALID;
  }
  const mode = VIRTUAL_DISPLAY_MODE;
  [mode.width, mode.height, mode.frequency, X8R8G8B8].forEach((value, i) =>
    runtime.write32(pointer + i * 4, value),
  );
  return 0;
}

export function displayMethods(version) {
  // D3D8 enumerates all modes; D3D9 adds a format filter. This adapter shares
  // USER32's single virtual desktop mode, independent of any window/backbuffer.
  return {
    6: {
      argc: version === 8 ? 2 : 3,
      invoke: (_r, a) => Number(a(1) === 0 && (version === 8 || a(2) === X8R8G8B8)),
    },
    7: {
      argc: version === 8 ? 4 : 5,
      invoke(r, a) {
        if (a(1) !== 0 || (version === 9 && a(2) !== X8R8G8B8)) return INVALID;
        const index = version === 8 ? 2 : 3;
        return a(index) === 0 ? writeMode(r, a(index + 1)) : INVALID;
      },
    },
    8: {
      argc: 3,
      invoke: (r, a) => (a(1) === 0 ? writeMode(r, a(2)) : INVALID),
    },
    12: {
      argc: 6,
      invoke(_r, a) {
        if (a(1) !== 0) return INVALID;
        // The shared renderer currently supplies D16 depth without stencil.
        return a(2) === 1 && a(3) === X8R8G8B8 && [21, 22].includes(a(4)) && a(5) === 80
          ? 0
          : NOT_AVAILABLE;
      },
    },
  };
}
