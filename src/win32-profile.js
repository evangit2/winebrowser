import { resolveGuestPath } from './guest-paths.js';
import { decodeAnsi, encodeAnsi } from './encoding.js';
import { fileMetadata, FILE_PATH_NOT_FOUND, touchFile } from './file-metadata.js';
import { fileShareConflict } from './wine-file.js';

// Profile reads always use the shared virtual file map. Writes are immediate,
// visible to CreateFile/ReadFile, file sections and exported package outputs.
const ok = (result, argc) => ({ result: result >>> 0, argc });
const input = (r, p, wide) => (p ? (wide ? r.wideString(p) : r.string(p)) : null);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const unquote = (s) =>
  s.length > 1 && ['"', "'"].includes(s[0]) && s.at(-1) === s[0] ? s.slice(1, -1) : s;
function pathFor(r, name) {
  name ??= 'win.ini';
  if (!name) throw Error('Empty profile path');
  if (!/[\\/:]/.test(name)) name = `C:\\Windows\\${name}`;
  return resolveGuestPath(name, r.cwd);
}
function decode(bytes = new Uint8Array()) {
  let encoding = 'ansi',
    offset = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    offset = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    offset = 2;
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8';
    offset = 3;
  }
  const value =
    encoding === 'ansi'
      ? decodeAnsi(bytes)
      : new TextDecoder(encoding).decode(bytes.subarray(offset));
  return { encoding, lines: value.split(/\r\n|\n|\r/) };
}
function encode(lines, encoding) {
  const value = lines.join('\r\n');
  if (encoding === 'ansi') return encodeAnsi(value).bytes;
  if (encoding === 'utf-8') {
    const body = new TextEncoder().encode(value),
      out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }
  const out = new Uint8Array(2 + value.length * 2),
    view = new DataView(out.buffer),
    little = encoding === 'utf-16le';
  view.setUint16(0, 0xfeff, little);
  for (let i = 0; i < value.length; i++) view.setUint16(2 + i * 2, value.charCodeAt(i), little);
  return out;
}
function sections(lines) {
  const result = [{ name: '', start: -1, end: lines.length, keys: [] }];
  let current = result[0];
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    const end = s.lastIndexOf(']');
    if (s.startsWith('[') && end > 0) {
      current.end = i;
      current = { name: s.slice(1, end).trim(), start: i, end: lines.length, keys: [] };
      result.push(current);
    } else if (s && !s.startsWith(';')) {
      const at = s.indexOf('=');
      current.keys.push({
        name: (at < 0 ? s : s.slice(0, at)).trim(),
        value: at < 0 ? null : s.slice(at + 1).trim(),
        line: i,
      });
    }
  }
  return result;
}
function load(r, name, write = false) {
  let path;
  try {
    path = pathFor(r, name);
  } catch {
    r.lastError = name === '' ? 5 : 123;
    return null;
  }
  const info = fileMetadata(r, path);
  if (info.directory) {
    r.lastError = 5;
    return null;
  }
  if (info.status === FILE_PATH_NOT_FOUND) {
    r.lastError = 3;
    return null;
  }
  if (fileShareConflict(r, path, write ? 0xc0000000 : 0x80000000, 7)) {
    r.lastError = 32;
    return null;
  }
  if (r.files.has(path)) touchFile(r, path, { read: true });
  else if (!write) r.lastError = 2;
  const doc = decode(r.files.get(path));
  return { path, ...doc, sections: sections(doc.lines) };
}
function output(r, p, capacity, value, wide, multi = false) {
  if (!p || !capacity) return 0;
  const units = wide
    ? Array.from({ length: value.length }, (_, i) => value.charCodeAt(i))
    : [...encodeAnsi(value).bytes];
  r.check(p, capacity * (wide ? 2 : 1), true);
  const fits = units.length + 1 <= capacity;
  const count = multi
    ? fits
      ? units.length
      : Math.max(0, capacity - 2)
    : Math.min(units.length, capacity - 1);
  const terminators = multi && (!fits || !units.length) ? Math.min(2, capacity - count) : 1;
  for (let i = 0; i < count + terminators; i++) {
    const unit = i < count ? units[i] : 0;
    if (wide) r.view.setUint16(p + i * 2, unit, true);
    else r.data[p + i] = unit;
  }
  return count;
}
function getString(r, a, wide) {
  const section = input(r, a(0), wide),
    key = input(r, a(1), wide),
    fallback = (input(r, a(2), wide) ?? '').replace(/ +$/, '');
  const p = a(3),
    capacity = a(4) >>> 0;
  if (!p || !capacity) return ok(0, 6);
  const doc = load(r, input(r, a(5), wide));
  if (section === null)
    return ok(
      output(
        r,
        p,
        capacity,
        doc?.sections
          .filter((s) => s.name)
          .map((s) => s.name + '\0')
          .join('') ?? '',
        wide,
        true,
      ),
      6,
    );
  const found = doc?.sections.find((s) => same(s.name, section));
  if (key === null) {
    const names =
      found?.keys
        .filter((k) => k.value !== null)
        .map((k) => k.name + '\0')
        .join('') ?? '';
    return ok(output(r, p, capacity, names || unquote(fallback), wide, !!names || !fallback), 6);
  }
  const value = found?.keys.find((k) => same(k.name, key))?.value;
  return ok(output(r, p, capacity, unquote(value ?? fallback), wide), 6);
}
function writeString(r, a, wide) {
  const section = input(r, a(0), wide),
    key = input(r, a(1), wide),
    value = input(r, a(2), wide),
    name = input(r, a(3), wide);
  // There is no stale cache to flush. Wine returns FALSE for this special call.
  if (section === null && key === null && value === null) return ok(0, 4);
  if (section === null) {
    r.lastError = 2;
    return ok(0, 4);
  }
  const doc = load(r, name, true);
  if (!doc) return ok(0, 4);
  const found = doc.sections.find((s) => same(s.name, section));
  let changed = false;
  if (key === null) {
    for (const s of doc.sections.filter((s) => same(s.name, section)).reverse()) {
      doc.lines.splice(Math.max(0, s.start), s.end - Math.max(0, s.start));
      changed = true;
    }
  } else {
    const existing = found?.keys.find((k) => same(k.name, key));
    if (value === null) {
      if (existing) {
        doc.lines.splice(existing.line, 1);
        changed = true;
      }
    } else {
      const line = `${existing?.name ?? key}=${value.trimStart()}`;
      if (existing) {
        changed = doc.lines[existing.line] !== line;
        doc.lines[existing.line] = line;
      } else if (found) {
        doc.lines.splice(found.end, 0, line);
        changed = true;
      } else {
        if (doc.lines.at(-1) === '') doc.lines.pop();
        doc.lines.push(`[${section}]`, line, '');
        changed = true;
      }
    }
  }
  if (!changed) return ok(1, 4);
  const bytes = encode(doc.lines, doc.encoding);
  if (r.fileSections?.canResize(doc.path, bytes.length) === false) {
    r.lastError = 1224;
    return ok(0, 4);
  }
  if (!r.files.has(doc.path) && r.files.size >= 4096) {
    r.lastError = 8;
    return ok(0, 4);
  }
  touchFile(r, doc.path, { created: !r.files.has(doc.path), write: true });
  r.files.set(doc.path, bytes);
  r.dirty.add(doc.path);
  r.fileSections?.fileChanged(doc.path);
  return ok(1, 4);
}
function getSection(r, a, wide, names = false) {
  const section = names ? null : input(r, a(0), wide),
    p = a(names ? 0 : 1),
    capacity = a(names ? 1 : 2) >>> 0;
  const doc = load(r, input(r, a(names ? 2 : 3), wide));
  const entries = names
    ? doc?.sections.filter((s) => s.name).map((s) => s.name)
    : doc?.sections
        .find((s) => section !== null && same(s.name, section))
        ?.keys.map((k) => (k.value === null ? k.name : `${k.name}=${k.value}`));
  return ok(
    output(r, p, capacity, entries?.map((s) => s + '\0').join('') ?? '', wide, true),
    names ? 3 : 4,
  );
}
function getInt(r, a, wide) {
  const p = r.allocate(64);
  try {
    const value = getString(r, (i) => [a(0), a(1), 0, p, 30, a(3)][i], wide);
    if (!value.result) return ok(a(2), 4);
    const s = input(r, p, wide),
      match = s.match(/^\s*([+-]?)(?:(0[xob])([0-9a-f]+)|(\d+))/i);
    if (!match) return ok(0, 4);
    const base = match[2] ? { x: 16, o: 8, b: 2 }[match[2][1].toLowerCase()] : 10;
    return ok((match[1] === '-' ? -1 : 1) * parseInt(match[3] ?? match[4], base), 4);
  } finally {
    r.free(p);
  }
}
export const profileApis = {};
for (const [suffix, wide] of [
  ['A', false],
  ['W', true],
]) {
  profileApis[`kernel32.dll!GetPrivateProfileString${suffix}`] = (r, a) => getString(r, a, wide);
  profileApis[`kernel32.dll!WritePrivateProfileString${suffix}`] = (r, a) =>
    writeString(r, a, wide);
  profileApis[`kernel32.dll!GetPrivateProfileInt${suffix}`] = (r, a) => getInt(r, a, wide);
  profileApis[`kernel32.dll!GetPrivateProfileSection${suffix}`] = (r, a) => getSection(r, a, wide);
  profileApis[`kernel32.dll!GetPrivateProfileSectionNames${suffix}`] = (r, a) =>
    getSection(r, a, wide, true);
  profileApis[`kernel32.dll!GetProfileString${suffix}`] = (r, a) => ({
    ...getString(r, (i) => (i === 5 ? 0 : a(i)), wide),
    argc: 5,
  });
  profileApis[`kernel32.dll!WriteProfileString${suffix}`] = (r, a) => ({
    ...writeString(r, (i) => (i === 3 ? 0 : a(i)), wide),
    argc: 3,
  });
  profileApis[`kernel32.dll!GetProfileInt${suffix}`] = (r, a) => ({
    ...getInt(r, (i) => (i === 3 ? 0 : a(i)), wide),
    argc: 3,
  });
}
