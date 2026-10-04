/*
 * Wine RtlIsTextUnicode algorithm translated to JavaScript.
 * Copyright (C) 1996-1998 Marcus Meissner
 * Copyright (C) 2000 Alexandre Julliard
 * Copyright (C) 2003 Thomas Mertes
 * SPDX-License-Identifier: LGPL-2.1-or-later
 * Source: wine-mirror/wine db11d0fe6a169c457e23d007e20404643d067aa8,
 * dlls/ntdll/rtlstr.c. License: public/runtime/COPYING.LIB.
 * Wine's heuristic implements statistics, controls, BOMs, odd length and null
 * bytes; ASCII16, illegal-character and DBCS heuristics remain unimplemented.
 */
function isTextUnicode(r, a) {
  const buffer = a(0),
    length = a(1) | 0,
    flagsPointer = a(2);
  if (flagsPointer) r.check(flagsPointer, 4, true);
  if (length < 2) {
    if (flagsPointer) r.write32(flagsPointer, 0);
    return { result: 0, argc: 3 };
  }
  r.check(buffer, length);
  const requested = flagsPointer ? r.read32(flagsPointer) : 0xffffffff;
  let flags = length & 1 ? 0x200 : 0;
  const count = Math.min(
    256,
    Math.floor((length - (r.data[buffer + length - 1] === 0 ? 1 : 0)) / 2),
  );
  const first = r.view.getUint16(buffer, true);
  if (first === 0xfeff) flags |= 8;
  if (first === 0xfffe) flags |= 0x80;
  let stats = 0;
  for (let i = 0; i < count; i++) {
    const c = r.view.getUint16(buffer + 2 * i, true);
    if (c <= 255) stats++;
    if (requested & 0x1000 && (!(c & 255) || !(c >> 8))) flags |= 0x1000;
    // wcschr also matches the terminating NUL in Wine's control strings.
    if (requested & 4 && [0, 13, 10, 9, 32, 0x3000].includes(c)) flags |= 4;
    if (requested & 0x40 && [0, 0x0d00, 0x0a00, 0x0900, 0x2000].includes(c)) flags |= 0x40;
  }
  if (requested & 2 && stats > Math.floor(count / 2)) flags |= 2;
  flags &= requested;
  if (flagsPointer) r.write32(flagsPointer, flags);
  const result = flags & 0x0ff0 ? 0 : flags & 0xf00f ? 1 : 0;
  return { result, argc: 3 };
}
export const textUnicodeApis = {
  'advapi32.dll!IsTextUnicode': isTextUnicode,
  'ntdll.dll!RtlIsTextUnicode': isTextUnicode,
};
