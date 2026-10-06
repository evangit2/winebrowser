import { packageDosPath } from './guest-paths.js';
import { environmentEntries } from './guest-environment.js';

// GetFullPathName is lexical: nonexistent files and paths on other drives can
// have full DOS names even though the file bridge cannot open those volumes.
export function fullDosPath(r, input) {
  if (!input || /^ *$/.test(input)) return null;
  const name = input.replaceAll('/', '\\');
  const cwd = packageDosPath(r.cwd, true);
  let absolute;
  if (/^[a-z]:\\/i.test(name) || name.startsWith('\\\\')) absolute = name;
  else if (/^[a-z]:/i.test(name)) {
    const drive = name.slice(0, 2);
    const saved = environmentEntries(r, true).find((entry) =>
      entry.toLowerCase().startsWith('=' + drive.toLowerCase() + '='),
    );
    const directory =
      drive.toLowerCase() === cwd.slice(0, 2).toLowerCase() ? cwd : saved?.slice(4) || drive + '\\';
    absolute = directory.replace(/\\?$/, '\\') + name.slice(2);
  } else if (name.startsWith('\\')) absolute = cwd.slice(0, 2) + name;
  else absolute = cwd + name;

  let root, tail;
  if (/^[a-z]:\\/i.test(absolute)) {
    root = absolute.slice(0, 3);
    tail = absolute.slice(3);
  } else if (/^\\\\[?.]\\/.test(absolute)) {
    root = absolute.slice(0, 4);
    tail = absolute.slice(4);
  } else {
    const unc = /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.exec(absolute);
    if (!unc) throw Error('Invalid DOS path');
    root = unc[0];
    tail = absolute.slice(root.length);
    if (tail && !root.endsWith('\\')) root += '\\';
  }
  const parts = [];
  const components = tail.split('\\');
  for (const [index, part] of components.entries()) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else
      parts.push(
        index === components.length - 1 ? part.replace(/[ .]+$/, '') : part.replace(/\.$/, ''),
      );
  }
  let path = root + parts.join('\\');
  if (tail.endsWith('\\') && parts.length) path += '\\';
  // DOS device basenames are recognized independently of directory existence.
  const last = parts.at(-1) || '';
  const device = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?=[.:]|$)/i.exec(last);
  if (device && !absolute.startsWith('\\\\')) return { path: '\\\\.\\' + device[0], device: true };
  return { path, device: false };
}
