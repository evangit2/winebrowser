import { fileSections, SECTION as S } from './file-sections.js';

const errors = new Map([
  [S.FAULT, 998],
  [S.HANDLE, 6],
  [S.INVALID, 87],
  [S.MEMORY, 8],
  [S.VIEW_SIZE, 87],
  [S.ACCESS, 5],
  [S.TOO_BIG, 223],
  [S.PROTECTION, 5],
  [S.UNSUPPORTED, 50],
  [S.EMPTY, 1006],
  [S.ALIGNMENT, 1132],
  [0xc0000018, 487],
  [0xc0000019, 487],
]);
function result(r, status, value, argc) {
  if (status) r.lastError = errors.get(status) ?? 87;
  return { result: status ? 0 : value, argc };
}
function create(r, a) {
  if (a(5)) return result(r, S.UNSUPPORTED, 0, 6);
  let inherit = false;
  if (a(1)) {
    try {
      r.check(a(1), 12);
      if (r.read32(a(1)) !== 12) return result(r, S.INVALID, 0, 6);
      if (r.read32(a(1) + 4)) return result(r, S.UNSUPPORTED, 0, 6);
      inherit = !!r.read32(a(1) + 8);
    } catch {
      return result(r, S.FAULT, 0, 6);
    }
  }
  const flags = a(2) >>> 0;
  const created = fileSections(r).create({
    file: a(0) >>> 0 === 0xffffffff ? 0 : a(0),
    size: BigInt(a(3) >>> 0) * 0x100000000n + BigInt(a(4) >>> 0),
    protection: flags & 0xff,
    attributes: (flags & 0xffffff00) >>> 0 || S.COMMIT,
    inherit,
  });
  if (!created.status) r.lastError = 0;
  return result(r, created.status, created.handle, 6);
}
function map(r, a, extended = false) {
  const argc = extended ? 6 : 5;
  if (a(1) !== 4) return result(r, S.UNSUPPORTED, 0, argc);
  const mapped = fileSections(r).map(a(0), {
    offset: BigInt(a(2) >>> 0) * 0x100000000n + BigInt(a(3) >>> 0),
    size: a(4) >>> 0,
    base: extended ? a(5) >>> 0 : 0,
  });
  return result(r, mapped.status, mapped.base, argc);
}
export const fileSectionApis = {
  'kernel32.dll!CreateFileMappingA': create,
  'kernel32.dll!CreateFileMappingW': create,
  'kernel32.dll!MapViewOfFile': (r, a) => map(r, a),
  'kernel32.dll!MapViewOfFileEx': (r, a) => map(r, a, true),
  'kernel32.dll!UnmapViewOfFile': (r, a) => result(r, r.sectionViews.unmap(a(0)), 1, 1),
};
