import { resolveGuestPath, packageDosPath } from './guest-paths.js';
import { environmentEntries } from './guest-environment.js';
import { fileMetadata } from './file-metadata.js';

// SearchPath is a process file search, separate from LoadLibrary's loader flags.
// Like Wine's contains_path, a relative "assets/file" still uses the search list;
// ./ and ../ explicitly select the current directory instead.
function qualified(name) {
  return /^(?:[\\/]|[a-z]:|\.\.?[\\/])/i.test(name);
}
function appendExtension(name, extension) {
  const leaf = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  return extension && !leaf.includes('.') ? name + extension : name;
}
function pathEntries(path) {
  // Empty components inside a list mean the current directory. A trailing
  // delimiter terminates the list (RtlDosSearchPath_U's while (*paths)).
  const entries = path.split(';');
  if (entries.at(-1) === '') entries.pop();
  return entries;
}
function defaultDirectories(r) {
  const application = r.exe.includes('/') ? r.exe.slice(0, r.exe.lastIndexOf('/')) : '';
  const current = packageDosPath(r.cwd);
  const system = ['C:\\Windows\\System32', 'C:\\Windows\\System', 'C:\\Windows'];
  const directories = [packageDosPath(application)];
  if (!r.searchPathSafeMode) directories.push(current);
  directories.push(...system);
  if (r.searchPathSafeMode) directories.push(current);
  const entry = environmentEntries(r, true).find((value) => /^path=/i.test(value));
  if (entry) directories.push(...pathEntries(entry.slice(5)));
  return directories;
}
export function findGuestSearchPath(r, path, name, extension) {
  const exists = (candidate) => {
    try {
      const normalized = resolveGuestPath(candidate, r.cwd, { allowRoot: true });
      return fileMetadata(r, normalized).status === 0 ? packageDosPath(normalized) : null;
    } catch {
      // Other drives, UNC and paths outside the isolated guest volume are not
      // backed by files. A bad list component does not prevent trying the next.
      return null;
    }
  };
  if (qualified(name)) return exists(name) ?? exists(appendExtension(name, extension));
  const explicit = !!path;
  const directories = explicit ? pathEntries(path) : defaultDirectories(r);
  // RtlDosSearchPath_U suppresses extensions on any dot in a relative name;
  // the default SearchPathW branch first uses its basename-aware append_ext.
  const target = explicit
    ? extension && !name.includes('.')
      ? name + extension
      : name
    : appendExtension(name, extension);
  for (const directory of directories) {
    const candidate = exists(directory ? directory + '\\' + target : target);
    if (candidate) return candidate;
  }
  return null;
}
