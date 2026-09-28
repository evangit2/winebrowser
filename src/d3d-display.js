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

// D3DADAPTER_IDENTIFIER8 is 1068 bytes and D3DADAPTER_IDENTIFIER9 is 1100;
// D3D8 omits DriverVersion and its later fields shift down by 32 bytes. Address
// fields use the guest i386 sizes (SIZE_T is 4 bytes); the 16-byte Driver GUID
// is written as raw bytes from a stable synthetic identifier.
const ADAPTER_DRIVER = 'winebrowser-webgpu';
const ADAPTER_DESCRIPTION = 'WineBrowser WebGPU Adapter';
const ADAPTER_GUID = Uint8Array.from([
  0x57, 0x42, 0x47, 0x50, 0x55, 0x00, 0x00, 0x40, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01,
]);

function writeAdapterIdentifier(runtime, version, pointer) {
  if (!pointer) return INVALID;
  const identifier = version === 8 ? 1068 : 1100;
  try {
    runtime.check(pointer, identifier, true);
  } catch {
    return INVALID;
  }
  runtime.data.fill(0, pointer, pointer + identifier);
  const text = (offset, value) => {
    for (let i = 0; i < value.length && i < 511; i++)
      runtime.data[pointer + offset + i] = value.charCodeAt(i);
  };
  text(0, ADAPTER_DRIVER);
  text(512, ADAPTER_DESCRIPTION);
  // D3D9 has DriverVersion before VendorId; D3D8 omits it, so every later
  // field sits 32 bytes earlier. Both layouts were measured with the pinned
  // MinGW d3d8.h/d3d9.h headers.
  const base = version === 8 ? 1024 : 1056;
  runtime.write32(pointer + base, 0x00010000); // DriverVersion 1.0.0.0.
  runtime.write32(pointer + base + 8, 0x1af4); // VendorId.
  runtime.write32(pointer + base + 12, 0x1050); // DeviceId.
  runtime.data.set(ADAPTER_GUID, pointer + base + 24);
  runtime.write32(pointer + base + 40, 1); // WHQLLevel.
  return 0;
}

export function displayMethods(version) {
  // D3D8 enumerates all modes; D3D9 adds a format filter. This adapter shares
  // USER32's mode catalogue; windowed backbuffer sizes do not change the desktop.
  const modes = (a) =>
    a(1) === 0
      ? VIRTUAL_DISPLAY_MODES.filter((m) => version === 8 || displayFormat(m) === a(2))
      : [];
  return {
    5: {
      // GetAdapterIdentifier(Adapter, Flags, D3DADAPTER_IDENTIFIER*)
      argc: 4,
      invoke: (r, a) => (a(1) === 0 ? writeAdapterIdentifier(r, version, a(3)) : INVALID),
    },
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
        // The shared renderer supplies depth-only attachments: D16 maps to a
        // depth16unorm texture and D24S8 to depth24plus. Guest stencil
        // operations are not implemented, so other depth formats are rejected.
        return a(2) === 1 &&
          [22, 23].includes(a(3)) &&
          [21, 22, 23].includes(a(4)) &&
          [75, 80].includes(a(5))
          ? 0
          : NOT_AVAILABLE;
      },
    },
  };
}
