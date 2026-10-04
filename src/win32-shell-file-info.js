import { resolveGuestPath } from './guest-paths.js';
import { fileMetadata } from './file-metadata.js';
import { encodeAnsi } from './encoding.js';
import { createOwnedIcon } from './win32-icons.js';

const ICON = 0x100,
  DISPLAYNAME = 0x200,
  TYPENAME = 0x400,
  ATTRIBUTES = 0x800;
const ATTR_SPECIFIED = 0x20000,
  USEFILEATTRIBUTES = 0x10;
const SUPPORTED =
  ICON | DISPLAYNAME | TYPENAME | ATTRIBUTES | ATTR_SPECIFIED | USEFILEATTRIBUTES | 7;
const icons = new Map();
function namespaceIcon(folder, small, open) {
  const size = small ? 16 : 32,
    key = `${folder}:${size}:${open}`;
  if (icons.has(key)) return icons.get(key);
  const pixels = new Uint8Array(size * size * 4);
  const rect = (x, y, w, h, color) => {
    const scale = size / 32;
    for (let row = Math.floor(y * scale); row < Math.ceil((y + h) * scale); row++)
      for (let col = Math.floor(x * scale); col < Math.ceil((x + w) * scale); col++)
        pixels.set([...color, 255], (row * size + col) * 4);
  };
  if (folder) {
    rect(3, 7, 12, 5, [188, 131, 27]);
    rect(3, 10, 26, 19, [188, 131, 27]);
    rect(4, open ? 15 : 11, 24, open ? 13 : 17, [242, 192, 65]);
    rect(4, open ? 15 : 11, 24, 2, [255, 220, 116]);
  } else {
    rect(7, 3, 19, 26, [105, 120, 139]);
    rect(8, 4, 17, 24, [248, 250, 252]);
    for (let row = 11; row <= 23; row += 4) rect(11, row, 11, 1, [147, 165, 186]);
  }
  const icon = { width: size, height: size, pixels };
  icons.set(key, icon);
  return icon;
}
function text(r, pointer, value, capacity, wide) {
  if (wide) {
    value = value.slice(0, capacity - 1);
    for (let n = 0; n <= value.length; n++)
      r.guestMemory.write(pointer + n * 2, n === value.length ? 0 : value.charCodeAt(n), 2);
  } else {
    const bytes = encodeAnsi(value).bytes.subarray(0, capacity - 1);
    r.data.set(bytes, pointer);
    r.data[pointer + bytes.length] = 0;
  }
}
function fileInfo(r, a, wide) {
  const flags = a(4) >>> 0,
    size = wide ? 692 : 352;
  const fail = (error) => {
    r.lastError = error;
    return { result: 0, argc: 5 };
  };
  // PIDLs, executable type probes, system image lists, overlays and registry
  // associations require additional shell services. Do not invent handles.
  if (flags & ~SUPPORTED) return fail(50);
  if (!a(0) || !a(2)) return fail(87);
  if (a(3) < size) return fail(122);
  if (flags & USEFILEATTRIBUTES && flags & (ATTRIBUTES | ATTR_SPECIFIED)) return fail(87);
  if (flags & ATTR_SPECIFIED && !(flags & ATTRIBUTES)) return fail(87);
  const pointer = a(2);
  r.check(pointer, size, true);
  const name = wide ? r.wideString(a(0)) : r.string(a(0));
  if (!name) return fail(87);
  let attributes = a(1) >>> 0,
    path;
  if (!(flags & USEFILEATTRIBUTES)) {
    try {
      path = resolveGuestPath(name, r.cwd, { allowRoot: true });
    } catch {
      return fail(3);
    }
    const info = fileMetadata(r, path);
    if (info.status) return fail(info.status === 0xc000003a ? 3 : 2);
    attributes = info.attributes;
  }
  const folder = !!(attributes & 0x10);
  const basename = name
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .at(-1);
  const extension = basename.includes('.') ? basename.split('.').at(-1).toUpperCase() : '';
  const type = folder ? 'File folder' : extension ? `${extension} File` : 'File';
  if (flags & ATTRIBUTES) {
    let shellAttributes = 0x40000037; // filesystem, copy/move/link/rename/delete
    if (folder) {
      shellAttributes |= 0x30000000; // folder and filesystem ancestor
      if (
        [...r.files.keys(), ...(r.virtualDirectories ?? [])].some(
          (p) =>
            p.startsWith(path ? path + '/' : '') &&
            p.slice(path ? path.length + 1 : 0).includes('/'),
        )
      )
        shellAttributes |= 0x80000000;
    }
    if (flags & ATTR_SPECIFIED) shellAttributes &= r.read32(pointer + 8);
    r.write32(pointer + 8, shellAttributes);
  }
  if (flags & DISPLAYNAME) text(r, pointer + 12, basename, 260, wide);
  if (flags & TYPENAME) text(r, pointer + 12 + 260 * (wide ? 2 : 1), type, 80, wide);
  if (flags & ICON) {
    const handle = createOwnedIcon(r, namespaceIcon(folder, !!(flags & 1), !!(flags & 2)));
    r.write32(pointer, handle);
    r.write32(pointer + 4, folder ? 1 : 0);
  }
  return { result: 1, argc: 5 };
}
export const shellFileInfoApis = {
  'shell32.dll!SHGetFileInfoA': (r, a) => fileInfo(r, a, false),
  'shell32.dll!SHGetFileInfoW': (r, a) => fileInfo(r, a, true),
};
