import { resolveGuestPath } from './guest-paths.js';

export const DLL_SEARCH_FLAGS = 0x100 | 0x200 | 0x400 | 0x800 | 0x1000;
export const isSystemDllPath = (path) =>
  /^(?:[a-z]:)?\/windows\/system32(?:\/|$)/i.test(path.replaceAll('\\', '/'));

export function validLibraryFlags(flags) {
  return !(flags & ~(8 | DLL_SEARCH_FLAGS)) && !(flags & 8 && flags & DLL_SEARCH_FLAGS);
}

// Search flags constrain dependencies too. The executable's directory and
// current working directory are distinct; SYSTEM32 never searches package files.
export function librarySearchOptions(runtime, name, flags) {
  if (!validLibraryFlags(flags))
    throw Object.assign(Error('Invalid DLL search flags'), { win32Error: 87 });
  if (!(flags & (8 | DLL_SEARCH_FLAGS))) return {};
  const directories = [];
  const add = (path) => {
    if (!directories.includes(path)) directories.push(path);
  };
  if (flags & (8 | 0x100)) {
    if (!/^(?:[a-z]:[\\/]|[\\/]\?\?[\\/]|[\\/]{2}\?[\\/])/i.test(name))
      throw Object.assign(Error('DLL load directory requires an absolute filename'), {
        win32Error: 87,
      });
    const path = resolveGuestPath(name);
    add(path.slice(0, path.lastIndexOf('/') + 1));
  }
  if (flags & 8) {
    add(runtime.cwd);
    add('');
  } else if (flags & (0x200 | 0x1000)) add(runtime.graph.cwd);
  // User-directory management currently belongs to the native Wine loader.
  // A host-only USER_DIRS search has no configured directories, not a fallback
  // to the application directory or package root.
  return { searchDirectories: directories, searchRuntime: !!(flags & (8 | 0x800 | 0x1000)) };
}
