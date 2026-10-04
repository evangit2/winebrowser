import { resolveGuestPath, packageDosPath } from './guest-paths.js';
import { normalizePath } from './package.js';

export const OFN = Object.freeze({
  READONLY: 1,
  OVERWRITEPROMPT: 2,
  HIDEREADONLY: 4,
  NOCHANGEDIR: 8,
  ALLOWMULTISELECT: 0x200,
  EXTENSIONDIFFERENT: 0x400,
  PATHMUSTEXIST: 0x800,
  FILEMUSTEXIST: 0x1000,
  CREATEPROMPT: 0x2000,
  EXPLORER: 0x80000,
});
export const parentPath = (path) =>
  path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
export const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);
export function matchesFileFilter(name, pattern) {
  return pattern.split(';').some((glob) => {
    glob = glob.trim();
    if (glob === '*.*') glob = '*';
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replaceAll('*', '.*')
      .replaceAll('?', '.');
    return new RegExp(`^${escaped}$`, 'i').test(name);
  });
}
export function fileDialogDirectories(files, explicit = []) {
  const dirs = new Set(['']);
  for (const path of [
    ...files.map((f) => f.path),
    ...explicit.map((p) => p.replace(/\/$/, '') + '/_'),
  ]) {
    let parent = parentPath(path);
    while (parent) {
      dirs.add(parent);
      parent = parentPath(parent);
    }
  }
  return [...dirs].sort();
}
export function fileDialogSelection(
  request,
  selection,
  files = request.files,
  directories = request.directories,
) {
  if (
    !selection ||
    !Array.isArray(selection.names) ||
    !selection.names.length ||
    selection.names.length > 2048
  )
    return { error: 'Choose a file.' };
  const filter =
    request.filters.find((f) => f.index === selection.filterIndex) ?? request.filters[0];
  const known = new Set(files.map((f) => f.path)),
    paths = [],
    names = [];
  try {
    for (const name of selection.names) {
      if (typeof name !== 'string' || !name.trim() || /[<>"|?*\0]/.test(name))
        throw Error('Enter a valid file name.');
      let path = resolveGuestPath(name, selection.directory, { allowRoot: true });
      let display = name.replaceAll('\\', '/').split('/').pop();
      if (
        !display ||
        display === '.' ||
        display === '..' ||
        !path ||
        directories.includes(path) ||
        /[\x00-\x1f]/.test(path)
      )
        throw Error('Choose a file, not a folder.');
      if (
        selection.names.length === 1 &&
        request.defaultExtension &&
        !baseName(path).includes('.')
      ) {
        const filterExt = filter?.pattern.split(';')[0].match(/\.([^*?./\\]+)$/)?.[1];
        const ext = filterExt ?? request.defaultExtension;
        const extended = normalizePath(path + '.' + ext);
        if (request.save || known.has(extended)) {
          path = extended;
          display += '.' + ext;
        }
      }
      if (request.flags & OFN.PATHMUSTEXIST && !directories.includes(parentPath(path)))
        throw Error('That folder does not exist.');
      if (request.flags & OFN.FILEMUSTEXIST && !known.has(path))
        throw Error('That file does not exist.');
      paths.push(path);
      names.push(display);
    }
    if (paths.length > 1 && (!(request.flags & OFN.ALLOWMULTISELECT) || request.save))
      throw Error('Choose one file.');
    if (
      new Set(paths).size !== paths.length ||
      paths.some((p) => parentPath(p) !== parentPath(paths[0]))
    )
      throw Error('Choose different files from the same folder.');
  } catch (e) {
    return { error: e.message };
  }
  let confirmation = '';
  if (request.save && request.flags & OFN.OVERWRITEPROMPT && known.has(paths[0]))
    confirmation = `Replace ${baseName(paths[0])}?`;
  if (!request.save && request.flags & OFN.CREATEPROMPT && !known.has(paths[0]))
    confirmation = `Create ${baseName(paths[0])}?`;
  return { paths, names, filterIndex: filter?.index ?? 1, confirmation };
}
export function fileDialogPathLabel(path) {
  return packageDosPath(path);
}
