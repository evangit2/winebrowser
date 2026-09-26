import { normalizePath, unpackPackage } from './package.js';

export const IMPORT_LIMITS = Object.freeze({
  expanded: 128 * 1024 * 1024,
  files: 2048,
  bytes: 64 * 1024 * 1024,
  depth: 64,
});

// Files are immutable browser snapshots. Pass them to the worker without
// reading/decompressing their contents on the UI thread.
export function selectedFiles(files) {
  return [...files].map((file) => ({
    path: file.webkitRelativePath || file.name,
    file,
    archive: !file.webkitRelativePath && /\.zip$/i.test(file.name),
  }));
}

export function validateImportFiles(inputs) {
  if (!Array.isArray(inputs) || !inputs.length) throw Error('Choose files or a folder to open');
  if (inputs.length > IMPORT_LIMITS.files) throw Error('Import exceeds 2048 files');
  let bytes = 0;
  const seen = new Set();
  for (const input of inputs) {
    const path = normalizePath(input.path);
    if (path.split('/').length > IMPORT_LIMITS.depth)
      throw Error('Folder nesting exceeds 64 levels');
    if (seen.has(path)) throw Error(`Duplicate import path: ${path}`);
    seen.add(path);
    if (!(input.file instanceof Blob)) throw Error(`Not a file: ${path}`);
    bytes += input.file.size;
    if (bytes > IMPORT_LIMITS.bytes) throw Error('Selected files exceed 64 MiB');
  }
  return inputs;
}

export async function droppedFiles(transfer) {
  // Capture entries before the drop event's data store becomes inaccessible.
  const items = [...(transfer.items ?? [])].filter((item) => item.kind === 'file');
  const roots = items.map((item) => ({ entry: item.webkitGetAsEntry?.(), file: item.getAsFile() }));
  const fallback = selectedFiles(transfer.files ?? []);
  if (!roots.length) return validateImportFiles(fallback);
  const inputs = [];
  let entries = 0,
    bytes = 0;
  const visit = async (entry, parent = '', depth = 0, fallbackFile) => {
    if (++entries > 4096 || depth >= IMPORT_LIMITS.depth)
      throw Error('Folder is too large or deeply nested');
    if (!entry || entry.isFile) {
      const file = entry
        ? await new Promise((resolve, reject) => entry.file(resolve, reject))
        : fallbackFile;
      if (!file) throw Error('Cannot read dropped file');
      bytes += file.size;
      if (bytes > IMPORT_LIMITS.bytes || inputs.length >= IMPORT_LIMITS.files)
        throw Error('Import exceeds 2048 files or 64 MiB');
      inputs.push({
        path: parent + (entry?.name ?? file.name),
        file,
        archive: !parent && /\.zip$/i.test(file.name),
      });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // Chromium returns directory children in batches, often 100 at a time.
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, parent + entry.name + '/', depth + 1);
      }
    } else throw Error('Unsupported dropped entry');
  };
  for (const { entry, file } of roots) await visit(entry, '', 0, file);
  return validateImportFiles(inputs);
}

function invalidImport(message) {
  throw Error(`Invalid package: ${message}`);
}

// Merge explicit uploads, expanding only archives selected at the top level.
// ZIPs inside program folders remain assets; applications may open them later.
export async function unpackFiles(inputs) {
  validateImportFiles(inputs);
  const files = new Map(),
    parents = new Set();
  let expanded = 0,
    original;
  const add = (path, bytes) => {
    path = normalizePath(path);
    if (files.has(path)) invalidImport(`duplicate or case-colliding path: ${path}`);
    if (parents.has(path)) invalidImport(`file path conflicts with child path: ${path}`);
    const components = path.split('/');
    for (let i = 1; i < components.length; i++) {
      const parent = components.slice(0, i).join('/');
      if (files.has(parent)) invalidImport(`file path conflicts with child path: ${path}`);
      parents.add(parent);
    }
    expanded += bytes.length;
    if (expanded > IMPORT_LIMITS.expanded) invalidImport('expanded package exceeds 128 MiB');
    if (files.size >= IMPORT_LIMITS.files) invalidImport('package contains more than 2048 files');
    files.set(path, bytes);
  };
  for (const input of inputs) {
    const bytes = new Uint8Array(await input.file.arrayBuffer());
    if (input.archive) {
      const pkg = await unpackPackage(bytes, input.path);
      for (const [path, content] of pkg.files) add(path, content);
    } else add(input.path, bytes);
    if (
      inputs.length === 1 &&
      !/[\\/]/.test(input.path) &&
      (input.archive || /\.exe$/i.test(input.path))
    )
      original = bytes;
  }
  return {
    files,
    executables: [...files.keys()].filter((path) => path.endsWith('.exe')).sort(),
    original,
  };
}
