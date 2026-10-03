import manifest from '../runtime/wine-base/manifest.json';
import { packageId } from './storage.js';
import { parsePE } from './pe.js';
import { API_NAMES } from './win32.js';
import { canonicalHostSymbol } from './host-export-ordinals.js';
import { resolveApiSet } from './api-sets.js';

// Supplied DLLs and delay imports may only be reached after startup. Inspect
// their dependencies first so they can share a native system-library graph with
// the executable; switching an already initialized Kernel32 is not valid.
export function packageNeedsNativeBase(files) {
  const names = new Set(manifest.dlls.map((row) => row.name));
  for (const [path, bytes] of files) {
    if (!/\.(dll|exe)$/i.test(path)) continue;
    let pe;
    try {
      pe = parsePE(bytes, { allowDll: true });
    } catch {
      continue;
    } // The regular loader diagnoses a malformed DLL when requested.
    // EXE eager imports already undergo the ordinary graph inspection.
    // Delay-only CRT dependencies must also select the native base before
    // initialization; selecting it at the first lazy call would be too late.
    const imports = /\.dll$/i.test(path) ? [...pe.imports, ...pe.delayImports] : pe.delayImports;
    for (const entry of imports) {
      const dll = resolveApiSet(entry.dll).toLowerCase();
      // A native third-party codec/CRT client needs the complete native
      // library semantics even when every imported name has a host handler.
      // Export-name coverage alone does not establish behavioral equivalence.
      if (['msvcrt.dll', 'ucrtbase.dll', 'msacm32.dll'].includes(dll)) return true;
      if (
        names.has(dll) &&
        !API_NAMES[dll]?.includes(
          canonicalHostSymbol(dll, entry.name ?? entry.ordinal, API_NAMES[dll]),
        )
      )
        return true;
    }
  }
  return false;
}

// Load the source-built closure for missing imports or native CRT/codec clients.
// Package DLLs still precede runtime DLLs in ModuleGraph's normal search order.
export async function loadWineBaseAssets(baseUrl, fetchAsset = fetch) {
  const builtinFiles = new Map(),
    nlsFiles = new Map();
  const rows = [...manifest.dlls, ...manifest.nls];
  const loaded = await Promise.all(
    rows.map(async (row) => {
      if (row.path !== row.name || !/^[a-z0-9_.-]+$/.test(row.path))
        throw Error('Invalid Wine base component path');
      const response = await fetchAsset(`${baseUrl}runtime/wine-base/${row.path}`);
      if (!response.ok) throw Error(`Wine base component unavailable: ${row.name}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== row.bytes || (await packageId(bytes)) !== row.sha256)
        throw Error(`Wine base component hash mismatch: ${row.name}`);
      return bytes;
    }),
  );
  rows.forEach((row, i) =>
    (i < manifest.dlls.length ? builtinFiles : nlsFiles).set(row.name, loaded[i]),
  );
  return { builtinFiles, nlsFiles };
}
