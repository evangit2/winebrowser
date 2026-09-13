// Wine 11 i386 NLS syscall boundary. Locale/code-page algorithms remain in
// guest Wine DLLs; this provider supplies immutable data sections and LCIDs.
const STATUS = {
  ACCESS_VIOLATION: 0xc0000005,
  INVALID_PARAMETER_1: 0xc00000ef,
  UNSUCCESSFUL: 0xc0000001,
  OBJECT_NAME_NOT_FOUND: 0xc0000034,
};
const NORMALIZATION = new Map([
  [1, 'normnfc'],
  [2, 'normnfd'],
  [5, 'normnfkc'],
  [6, 'normnfkd'],
  [13, 'normidna'],
]);
const filename =
  /^(?:locale|sortdefault|l_intl|c_[0-9]{3,10}|normnfc|normnfd|normnfkc|normnfkd|normidna)\.nls$/;

/** Snapshot the explicitly supplied system data, or the package's nls/ directory. */
export function createNlsState(files, cwd, supplied) {
  const resources =
    supplied ??
    new Map(
      [...files]
        .filter(([path]) => path.startsWith(cwd + 'nls/'))
        .map(([path, bytes]) => [path.slice((cwd + 'nls/').length), bytes]),
    );
  const data = new Map();
  let total = 0;
  for (const [rawName, bytes] of resources) {
    const name = rawName.toLowerCase();
    if (!filename.test(name)) continue;
    if (!(bytes instanceof Uint8Array)) throw Error('NLS resources must be byte arrays');
    total += bytes.length;
    if (data.size >= 256 || total > 16 * 1024 * 1024) throw Error('NLS resource limit exceeded');
    data.set(name, bytes.slice());
  }
  // A deterministic bootstrap locale, consistent with CP_ACP=1252 elsewhere.
  return { files: data, systemLcid: 0x409, userLcid: 0x409 };
}
function writable(r, ...pointers) {
  try {
    for (const [address, size] of pointers) r.check(address, size, true);
    return true;
  } catch {
    return false;
  }
}
function mapData(r, name) {
  const bytes = r.nls.files.get(name);
  return bytes ? r.sectionViews.map(bytes, { name }) : { status: STATUS.OBJECT_NAME_NOT_FOUND };
}
function sectionName(type, id) {
  if (type === 9) return id ? { status: STATUS.INVALID_PARAMETER_1 } : { name: 'sortdefault.nls' };
  if (type === 10) return id ? { status: STATUS.UNSUCCESSFUL } : { name: 'l_intl.nls' };
  if (type === 11) return { name: `c_${String(id).padStart(3, '0')}.nls` };
  if (type === 12)
    return NORMALIZATION.has(id)
      ? { name: NORMALIZATION.get(id) + '.nls' }
      : { status: STATUS.OBJECT_NAME_NOT_FOUND };
  return { status: STATUS.INVALID_PARAMETER_1 };
}
export const nlsServices = {
  NtInitializeNlsFiles: {
    argc: 3,
    call: (r, a) => {
      const pointer = a(0),
        lcid = a(1);
      if (!writable(r, [pointer, 4], [lcid, 4])) return STATUS.ACCESS_VIOLATION;
      const view = mapData(r, 'locale.nls');
      if (!view.status) r.write32(pointer, view.base);
      // Wine writes the system LCID even when opening/mapping the file fails.
      r.write32(lcid, r.nls.systemLcid);
      // Wine 11 leaves the third LARGE_INTEGER argument untouched.
      return view.status;
    },
  },
  NtGetNlsSectionPtr: {
    argc: 5,
    call: (r, a) => {
      const entry = sectionName(a(0), a(1));
      if (entry.status) return entry.status;
      const pointer = a(3),
        size = a(4);
      if (!writable(r, [pointer, 4], [size, 4])) return STATUS.ACCESS_VIOLATION;
      // The third argument is unused by Wine's implementation.
      const view = mapData(r, entry.name);
      if (!view.status) {
        r.write32(pointer, view.base);
        r.write32(size, view.mappedSize);
      }
      return view.status;
    },
  },
  NtQueryDefaultLocale: {
    argc: 2,
    call: (r, a) => {
      if (!writable(r, [a(1), 4])) return STATUS.ACCESS_VIOLATION;
      r.write32(a(1), a(0) ? r.nls.userLcid : r.nls.systemLcid);
      return 0;
    },
  },
};
