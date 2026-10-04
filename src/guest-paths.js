import { normalizePath } from './package.js';

// One isolated DOS directory names the package volume. This is a guest path,
// never a browser origin, OPFS path, or host filesystem location.
export const GUEST_PACKAGE_ROOT = 'C:\\winebrowser\\';

export function packageDosPath(path = '', directory = false) {
  if (!path) return GUEST_PACKAGE_ROOT;
  const normalized = normalizePath(path);
  const dos =
    normalized === 'windows' || normalized.startsWith('windows/')
      ? 'C:\\Windows' + normalized.slice(7).replaceAll('/', '\\')
      : GUEST_PACKAGE_ROOT + normalized.replaceAll('/', '\\');
  return dos + (directory ? '\\' : '');
}

// Resolve guest filenames within the package volume. Parent components may
// reach sibling asset directories but cannot escape C:\winebrowser.
export function resolveGuestPath(input, cwd = '', { allowRoot = false } = {}) {
  if (typeof input !== 'string' || !input || input.includes('\0'))
    throw Error('Invalid guest path');
  let path = input.replaceAll('\\', '/');
  // The Win32 namespace prefixes name "no parsing, no normalization" forms of
  // the same DOS path: `\\?\C:\x` is C:\x with long-path semantics and
  // `\??\C:\x` is the NT object-manager spelling of it. A program that hits
  // MAX_PATH switches to them, so they must resolve to the same file rather
  // than being rejected as outside the volume. UNC verbatim paths
  // (`\\?\UNC\server\share`) name a network share this process does not
  // have, so they stay an error.
  if (path.startsWith('//?/UNC/') || path.startsWith('/??/UNC/'))
    throw Error('UNC paths are outside the package volume');
  if (path.startsWith('//?/')) path = path.slice(4);
  if (path.startsWith('/??/')) path = path.slice(4);
  const root = GUEST_PACKAGE_ROOT.replaceAll('\\', '/').toLowerCase();
  let parts,
    floor = 0;
  // C:\Windows is another guest namespace inside the isolated package tree.
  // File APIs and INI APIs must agree on these paths; no host files are exposed.
  if (/^c:\/windows(?:\/|$)/i.test(path)) {
    path = path.slice('c:/windows'.length).replace(/^\//, '');
    parts = ['windows'];
    floor = 1;
  } else if (allowRoot && path.toLowerCase() === root.slice(0, -1)) {
    path = '';
    parts = [];
  } else if (path.toLowerCase().startsWith(root)) {
    path = path.slice(root.length);
    parts = [];
  } else {
    if (path.startsWith('/') || path.includes(':'))
      throw Error('Path is outside the package volume');
    parts = cwd ? normalizePath(cwd).split('/') : [];
  }
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (parts.length <= floor) throw Error('Path escapes the package volume');
      parts.pop();
    } else parts.push(part);
  }
  return allowRoot && !parts.length ? '' : normalizePath(parts.join('/'));
}
