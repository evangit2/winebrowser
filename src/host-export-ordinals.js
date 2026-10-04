// Published Windows ordinals, matching Wine's dsound.spec. Keep unsupported
// exports absent: an ordinal mapping alone does not advertise an API service.
export const HOST_EXPORT_ORDINALS = {
  'comctl32.dll': {
    CreateStatusWindowA: 6,
    MakeDragList: 13,
    LBItemFromPt: 14,
    DrawInsert: 15,
    InitCommonControls: 17,
  },
  // OLE Automation's published ordinals (Wine's oleaut32.spec lists the same
  // numbering). 7zr imports SysAllocString, SysAllocStringLen, SysFreeString,
  // SysStringLen, VariantClear and VariantCopy by ordinal.
  'oleaut32.dll': {
    SysAllocString: 2,
    SysReAllocString: 3,
    SysAllocStringLen: 4,
    SysReAllocStringLen: 5,
    SysFreeString: 6,
    SysStringLen: 7,
    VariantInit: 8,
    VariantClear: 9,
    VariantCopy: 10,
    SysStringByteLen: 149,
    SysAllocStringByteLen: 150,
  },
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
//
// The versioned Visual C++ runtimes re-export the same globals under their own
// names, and a program built against one of them imports the data *there*. A
// program that imports `_acmdln` from msvcr80.dll and is handed a code thunk
// reads that thunk's bytes as a pointer, which is how a command-line walker
// ends up dereferencing an address that was never mapped. Every alias
// therefore shares the msvcrt data set, and a new data symbol has to be added
// here as well as to src/msvcrt.js.
const CRT_DATA_SYMBOLS = [
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
];

export const HOST_DATA_EXPORTS = {
  'msvcrt.dll': new Set(CRT_DATA_SYMBOLS),
  'msvcr70.dll': new Set(CRT_DATA_SYMBOLS),
  'msvcr71.dll': new Set(CRT_DATA_SYMBOLS),
  'msvcr80.dll': new Set(CRT_DATA_SYMBOLS),
  'msvcr90.dll': new Set(CRT_DATA_SYMBOLS),
  'msvcr100.dll': new Set(CRT_DATA_SYMBOLS),
  'msvcr110.dll': new Set(CRT_DATA_SYMBOLS),
  'msvcr120.dll': new Set(CRT_DATA_SYMBOLS),
};

export const isHostDataExport = (dll, symbol) =>
  HOST_DATA_EXPORTS[dll.toLowerCase()]?.has(symbol) ?? false;
