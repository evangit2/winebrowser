import { normalizePath } from './package.js';

// One isolated DOS directory names the package volume. This is a guest path,
// never a browser origin, OPFS path, or host filesystem location.
export const GUEST_PACKAGE_ROOT = 'C:\\winebrowser\\';

export function packageDosPath(path = '', directory = false) {
  if (!path) return GUEST_PACKAGE_ROOT;
  return GUEST_PACKAGE_ROOT + normalizePath(path).replaceAll('/', '\\') + (directory ? '\\' : '');
}

// Resolve guest filenames within the package volume. Parent components may
// reach sibling asset directories but cannot escape C:\winebrowser.
export function resolveGuestPath(input, cwd = '') {
  if (typeof input !== 'string' || !input || input.includes('\0'))
    throw Error('Invalid guest path');
  let path = input.replaceAll('\\', '/');
  if (path.startsWith('/??/')) path = path.slice(4);
  const root = GUEST_PACKAGE_ROOT.replaceAll('\\', '/').toLowerCase();
  let parts;
  if (path.toLowerCase().startsWith(root)) {
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
      if (!parts.length) throw Error('Path escapes the package volume');
      parts.pop();
    } else parts.push(part);
  }
  return normalizePath(parts.join('/'));
}
