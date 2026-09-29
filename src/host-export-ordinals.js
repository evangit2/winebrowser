// Published Windows ordinals, matching Wine's dsound.spec. Keep unsupported
// exports absent: an ordinal mapping alone does not advertise an API service.
export const HOST_EXPORT_ORDINALS = {
  'dsound.dll': {
    DirectSoundCreate: 1,
    DirectSoundEnumerateA: 2,
    DirectSoundEnumerateW: 3,
    DirectSoundCaptureCreate: 6,
    DirectSoundCaptureEnumerateA: 7,
    DirectSoundCaptureEnumerateW: 8,
    GetDeviceID: 9,
    DirectSoundFullDuplexCreate: 10,
    DirectSoundCreate8: 11,
    DirectSoundCaptureCreate8: 12,
  },
};

export function canonicalHostSymbol(dll, symbol, names) {
  const ordinal =
    typeof symbol === 'number' ? symbol : /^#\d+$/.test(symbol) ? Number(symbol.slice(1)) : null;
  if (ordinal !== null)
    for (const [name, value] of Object.entries(HOST_EXPORT_ORDINALS[dll.toLowerCase()] ?? {}))
      if (value === ordinal && names?.includes(name)) return name;
  return symbol;
}

// Host DLL exports that are data, not code. GetProcAddress must return the
// address of stable guest storage for these, never the call thunk a function
// export gets. The data itself is materialized by the provider module named in
// the comment (src/msvcrt.js for the CRT symbols).
export const HOST_DATA_EXPORTS = {
  'msvcrt.dll': new Set([
    '_iob',
    '_acmdln',
    '_wcmdln',
    '_pgmptr',
    '_wpgmptr',
    '_environ',
    '_wenviron',
    '__argv',
    '__wargv',
    '__argc',
    '__initenv',
    '_winitenv',
    '_fmode',
    '_commode',
    '_adjust_fdiv',
    '_osver',
    '_winver',
    '_winmajor',
    '_winminor',
    '_timezone',
    '_daylight',
    '_dstbias',
    '_sys_nerr',
    '__mb_cur_max',
  ]),
};

export const isHostDataExport = (dll, symbol) =>
  HOST_DATA_EXPORTS[dll.toLowerCase()]?.has(symbol) ?? false;
