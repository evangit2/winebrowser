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
