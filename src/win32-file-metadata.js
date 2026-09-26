import { resolveGuestPath } from './guest-paths.js';
import { fileMetadata, FILE_NAME_NOT_FOUND } from './file-metadata.js';

function attributes(r, a, wide, extended) {
  const argc = extended ? 3 : 1;
  const fail = (error) => {
    r.lastError = error;
    return { result: extended ? 0 : 0xffffffff, argc };
  };
  if (extended && a(1)) return fail(87);
  if (!a(0)) return fail(87);
  let name;
  try {
    name = wide ? r.wideString(a(0)) : r.string(a(0));
  } catch {
    return fail(998);
  }
  let path;
  try {
    if (name.startsWith('\\\\?\\')) name = '\\??\\' + name.slice(4);
    path = resolveGuestPath(name, r.cwd, { allowRoot: true });
  } catch {
    return fail(123);
  }
  const info = fileMetadata(r, path);
  if (info.status) return fail(info.status === FILE_NAME_NOT_FOUND ? 2 : 3);
  if (!extended) return { result: info.attributes, argc };
  const p = a(2);
  try {
    r.check(p, 36, true);
  } catch {
    return fail(998);
  }
  r.write32(p, info.attributes);
  for (const [i, key] of ['creation', 'access', 'write'].entries())
    r.view.setBigInt64(p + 4 + i * 8, info[key], true);
  r.write32(p + 28, 0);
  r.write32(p + 32, info.size);
  return { result: 1, argc };
}
export const fileMetadataApis = {};
for (const wide of [false, true])
  for (const extended of [false, true]) {
    const name = `GetFileAttributes${extended ? 'Ex' : ''}${wide ? 'W' : 'A'}`;
    fileMetadataApis[`kernel32.dll!${name}`] = (r, a) => attributes(r, a, wide, extended);
  }
