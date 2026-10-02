// Legacy SHLWAPI path editing is independent of package filesystem resolution.
// It operates on the caller's path, preserving DOS roots and native code units.
export function fileSpecEnd(path) {
  if (!path) return null;
  let root = 0;
  const drive = (offset) => /^[A-Za-z]:/.test(path.slice(offset));
  if (path.startsWith('\\\\?\\Volume{') && path[47] === '}') root = 48;
  else if (path.startsWith('\\\\?\\') && drive(4)) root = 6;
  else if (drive(0)) root = 2;
  if (root) {
    if (path[root] === '\\') root++;
  } else {
    if (path[root] === '\\') root++;
    if (path[root + 1] !== '?') {
      if (path[root] === '\\') root++;
      if (root > 1 && drive(root)) root += 2;
      if (path[root] === '\\' && path[root + 1] && path[root + 1] !== '\\') root++;
    }
  }
  const last = path.lastIndexOf('\\');
  if (last > root) return path[last - 1] === '\\' ? last - 1 : last;
  return root < path.length ? root : null;
}
function removeFileSpec(r, a, wide) {
  const pointer = a(0) >>> 0;
  if (!pointer) return { result: 0, argc: 1 };
  const path = wide ? r.wideString(pointer) : r.string(pointer);
  const end = fileSpecEnd(path);
  if (end === null) return { result: 0, argc: 1 };
  const address = pointer + end * (wide ? 2 : 1);
  r.check(address, wide ? 2 : 1, true);
  if (wide) r.view.setUint16(address, 0, true);
  else r.data[address] = 0;
  return { result: 1, argc: 1 };
}
export const pathApis = {
  'shlwapi.dll!PathRemoveFileSpecA': (r, a) => removeFileSpec(r, a, false),
  'shlwapi.dll!PathRemoveFileSpecW': (r, a) => removeFileSpec(r, a, true),
};
