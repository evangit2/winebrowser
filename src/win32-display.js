// One fixed process-local virtual display. It describes the browser desktop
// coordinate space only; these APIs never inspect or reconfigure a host monitor.
export const VIRTUAL_DISPLAY_MODE = Object.freeze({
  width: 1024,
  height: 768,
  bitsPerPixel: 32,
  frequency: 60,
  displayFlags: 0,
});

const ERROR_INVALID_WINDOW_HANDLE = 1400;
const ENUM_CURRENT_SETTINGS = 0xffffffff;
const ENUM_REGISTRY_SETTINGS = 0xfffffffe;
const DISP_CHANGE_SUCCESSFUL = 0;
const DISP_CHANGE_BADMODE = -2;
const DISP_CHANGE_BADFLAGS = -4;
const DISP_CHANGE_BADPARAM = -5;
const CDS_TEST = 0x00000002;
const CDS_FULLSCREEN = 0x00000004;
const DEVMODEA_DISPLAY_SIZE = 124;
const DM_BITSPERPEL = 0x00040000;
const DM_PELSWIDTH = 0x00080000;
const DM_PELSHEIGHT = 0x00100000;
const DM_DISPLAYFLAGS = 0x00200000;
const DM_DISPLAYFREQUENCY = 0x00400000;
const DISPLAY_FIELDS =
  DM_BITSPERPEL | DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFLAGS | DM_DISPLAYFREQUENCY;

const response = (value, argc) => ({ result: value | 0, argc });

export function virtualSystemMetric(index) {
  return {
    0: VIRTUAL_DISPLAY_MODE.width, // SM_CXSCREEN
    1: VIRTUAL_DISPLAY_MODE.height, // SM_CYSCREEN
    16: VIRTUAL_DISPLAY_MODE.width, // SM_CXFULLSCREEN
    17: VIRTUAL_DISPLAY_MODE.height, // SM_CYFULLSCREEN
  }[index];
}

function clientToScreen(runtime, argument) {
  const window = runtime.windows.windows.get(argument(0) >>> 0);
  if (!window) {
    runtime.lastError = ERROR_INVALID_WINDOW_HANDLE;
    return response(0, 2);
  }
  const point = argument(1) >>> 0;
  runtime.check(point, 8, true);
  const [outerX, outerY] = runtime.windows.screenPosition(window);
  const border = window.parentId ? (window.controlBorder ?? 0) : 1;
  const title = window.parentId ? 0 : 28;
  runtime.write32(point, ((runtime.read32(point) | 0) + outerX + border) | 0);
  runtime.write32(point + 4, ((runtime.read32(point + 4) | 0) + outerY + title + border) | 0);
  return response(1, 2);
}

function enumDisplaySettingsA(runtime, argument) {
  const device = argument(0) >>> 0;
  const modeIndex = argument(1) >>> 0;
  const devmode = argument(2) >>> 0;
  if (device || !devmode) return response(0, 3);
  if (
    modeIndex !== 0 &&
    modeIndex !== ENUM_CURRENT_SETTINGS &&
    modeIndex !== ENUM_REGISTRY_SETTINGS
  )
    return response(0, 3);

  runtime.check(devmode, 40, true);
  const suppliedSize = runtime.data[devmode + 36] | (runtime.data[devmode + 37] << 8);
  if (suppliedSize < DEVMODEA_DISPLAY_SIZE) return response(0, 3);
  runtime.check(devmode, DEVMODEA_DISPLAY_SIZE, true);
  runtime.data.fill(0, devmode, devmode + DEVMODEA_DISPLAY_SIZE);
  const name = new TextEncoder().encode('WineBrowser Virtual Display');
  runtime.data.set(name, devmode);
  const view = new DataView(runtime.data.buffer, runtime.data.byteOffset);
  view.setUint16(devmode + 32, 0x0401, true);
  view.setUint16(devmode + 34, 0x0400, true);
  view.setUint16(devmode + 36, DEVMODEA_DISPLAY_SIZE, true);
  view.setUint16(devmode + 38, 0, true);
  view.setUint32(devmode + 40, DISPLAY_FIELDS, true);
  view.setUint32(devmode + 104, VIRTUAL_DISPLAY_MODE.bitsPerPixel, true);
  view.setUint32(devmode + 108, VIRTUAL_DISPLAY_MODE.width, true);
  view.setUint32(devmode + 112, VIRTUAL_DISPLAY_MODE.height, true);
  view.setUint32(devmode + 116, VIRTUAL_DISPLAY_MODE.displayFlags, true);
  view.setUint32(devmode + 120, VIRTUAL_DISPLAY_MODE.frequency, true);
  return response(1, 3);
}

function changeDisplaySettingsA(runtime, argument) {
  const devmode = argument(0) >>> 0;
  const flags = argument(1) >>> 0;
  if (flags & ~(CDS_TEST | CDS_FULLSCREEN)) return response(DISP_CHANGE_BADFLAGS, 2);
  if (!devmode) return response(DISP_CHANGE_SUCCESSFUL, 2);

  runtime.check(devmode, 40);
  const view = new DataView(runtime.data.buffer, runtime.data.byteOffset);
  const size = view.getUint16(devmode + 36, true);
  const driverExtra = view.getUint16(devmode + 38, true);
  if (size < DEVMODEA_DISPLAY_SIZE || driverExtra) return response(DISP_CHANGE_BADPARAM, 2);
  runtime.check(devmode, DEVMODEA_DISPLAY_SIZE);
  const fields = view.getUint32(devmode + 40, true);
  if (!fields || fields & ~DISPLAY_FIELDS) return response(DISP_CHANGE_BADMODE, 2);
  const matches =
    (!(fields & DM_BITSPERPEL) ||
      view.getUint32(devmode + 104, true) === VIRTUAL_DISPLAY_MODE.bitsPerPixel) &&
    (!(fields & DM_PELSWIDTH) ||
      view.getUint32(devmode + 108, true) === VIRTUAL_DISPLAY_MODE.width) &&
    (!(fields & DM_PELSHEIGHT) ||
      view.getUint32(devmode + 112, true) === VIRTUAL_DISPLAY_MODE.height) &&
    (!(fields & DM_DISPLAYFLAGS) ||
      view.getUint32(devmode + 116, true) === VIRTUAL_DISPLAY_MODE.displayFlags) &&
    (!(fields & DM_DISPLAYFREQUENCY) ||
      view.getUint32(devmode + 120, true) === VIRTUAL_DISPLAY_MODE.frequency);
  return response(matches ? DISP_CHANGE_SUCCESSFUL : DISP_CHANGE_BADMODE, 2);
}

export const displayApis = {
  'user32.dll!ClientToScreen': clientToScreen,
  'user32.dll!EnumDisplaySettingsA': enumDisplaySettingsA,
  'user32.dll!ChangeDisplaySettingsA': changeDisplaySettingsA,
};
