import { VIRTUAL_DISPLAY_MODES, currentDisplayMode } from './win32-display.js';

const INVALID = 0x8876086c;
const X8R8G8B8 = 22;
const NOT_AVAILABLE = 0x8876086a;

export const displayFormat = (mode) => (mode.bitsPerPixel === 16 ? 23 : X8R8G8B8);
function writeMode(runtime, pointer, mode) {
  // Validate the complete structure before writing any fields.
  if (!pointer) return INVALID;
  try {
    runtime.check(pointer, 16, true);
  } catch {
    return INVALID;
  }
  [mode.width, mode.height, mode.frequency, displayFormat(mode)].forEach((value, i) =>
    runtime.write32(pointer + i * 4, value),
  );
  return 0;
}

export function deviceDisplayModeMethod(version) {
  return {
    argc: version === 8 ? 2 : 3,
    invoke(r, a) {
      // Only the implicit swapchain exists. D3D8 has no swapchain argument.
      if (version === 9 && a(1) !== 0) return INVALID;
      return writeMode(r, a(version === 8 ? 1 : 2), currentDisplayMode(r));
    },
  };
}

export function displayMethods(version) {
  // D3D8 enumerates all modes; D3D9 adds a format filter. This adapter shares
  // USER32's mode catalogue; windowed backbuffer sizes do not change the desktop.
  const modes = (a) =>
    a(1) === 0
      ? VIRTUAL_DISPLAY_MODES.filter((m) => version === 8 || displayFormat(m) === a(2))
      : [];
  return {
    6: {
      argc: version === 8 ? 2 : 3,
      invoke: (_r, a) => modes(a).length,
    },
    7: {
      argc: version === 8 ? 4 : 5,
      invoke(r, a) {
        const index = version === 8 ? 2 : 3;
        const mode = modes(a)[a(index)];
        return mode ? writeMode(r, a(index + 1), mode) : INVALID;
      },
    },
    8: {
      argc: 3,
      invoke: (r, a) => (a(1) === 0 ? writeMode(r, a(2), currentDisplayMode(r)) : INVALID),
    },
    12: {
      argc: 6,
      invoke(_r, a) {
        if (a(1) !== 0) return INVALID;
        // The shared renderer currently supplies D16 depth without stencil.
        return a(2) === 1 && [22, 23].includes(a(3)) && [21, 22, 23].includes(a(4)) && a(5) === 80
          ? 0
          : NOT_AVAILABLE;
      },
    },
  };
}
