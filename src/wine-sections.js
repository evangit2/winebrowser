import { fileSections, SECTION as S } from './file-sections.js';

function create(r, a) {
  let size = 0n,
    inherit = false;
  try {
    r.check(a(0), 4, true);
    if (a(3)) {
      r.check(a(3), 8);
      size = r.view.getBigInt64(a(3), true);
    }
    if (a(2)) {
      const p = a(2);
      r.check(p, 24);
      if (r.read32(p) !== 24) return S.INVALID;
      // No named namespace, root directory, ACL or kernel-handle semantics yet.
      // OBJ_OPENIF / CASE_INSENSITIVE have no effect on an unnamed object.
      if (
        r.read32(p + 4) ||
        r.read32(p + 8) ||
        r.read32(p + 12) & ~0xc2 ||
        r.read32(p + 16) ||
        r.read32(p + 20)
      )
        return S.UNSUPPORTED;
      inherit = !!(r.read32(p + 12) & 2);
    }
  } catch {
    return S.FAULT;
  }
  const result = fileSections(r).create({
    file: a(6),
    size,
    protection: a(4),
    attributes: a(5),
    access: a(1),
    inherit,
  });
  if (!result.status) r.write32(a(0), result.handle);
  return result.status;
}
function map(r, a) {
  if (a(1) >>> 0 !== 0xffffffff) return S.HANDLE;
  // CommitSize is ignored for data-file sections (it applies to pagefile sections).
  if (a(3) || a(8)) return S.UNSUPPORTED;
  if (![1, 2].includes(a(7))) return S.INVALID;
  let base,
    size,
    offset = 0n;
  try {
    r.check(a(2), 4, true);
    r.check(a(6), 4, true);
    base = r.read32(a(2));
    size = r.read32(a(6));
    if (a(5)) {
      r.check(a(5), 8, true);
      offset = r.view.getBigInt64(a(5), true);
    }
  } catch {
    return S.FAULT;
  }
  const result = fileSections(r).map(a(0), { base, size, offset, protection: a(9) });
  if (!result.status) {
    r.write32(a(2), result.base);
    r.write32(a(6), result.size);
    if (a(5)) r.view.setBigInt64(a(5), result.offset, true);
  }
  return result.status;
}
function query(r, a) {
  const result = fileSections(r).lookup(a(0), S.QUERY);
  if (result.status) return result.status;
  if (a(1) !== 0) return S.UNSUPPORTED;
  if (a(3) < 16) return 0xc0000004;
  try {
    r.check(a(2), 16, true);
    if (a(4)) r.check(a(4), 4, true);
  } catch {
    return S.FAULT;
  }
  r.write32(a(2), 0);
  r.write32(a(2) + 4, S.FILE);
  r.view.setBigInt64(a(2) + 8, BigInt(result.object.size), true);
  if (a(4)) r.write32(a(4), 16);
  return 0;
}
export const sectionNtServices = {
  NtCreateSection: { argc: 7, call: create },
  NtMapViewOfSection: { argc: 10, call: map },
  NtQuerySection: { argc: 5, call: query },
};
