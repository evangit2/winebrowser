import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { unpackFiles, IMPORT_LIMITS } from '../../src/import-files.js';

// Use the same bounded import/ZIP path as the browser. Diagnostic launchers
// may read a local folder, but it is never copied into the published harness.
export async function readLocalPackage(filename) {
  const root = path.resolve(filename);
  const inputs = [];
  let total = 0;
  async function visit(file, name, depth = 0) {
    if (depth >= IMPORT_LIMITS.depth) throw Error('Package folder nesting limit exceeded');
    const stat = await lstat(file);
    if (stat.isDirectory()) {
      for (const entry of (await readdir(file)).sort())
        await visit(path.join(file, entry), name ? `${name}/${entry}` : entry, depth + 1);
    } else if (stat.isFile()) {
      total += stat.size;
      if (total > IMPORT_LIMITS.bytes || inputs.length >= IMPORT_LIMITS.files)
        throw Error('Local package exceeds the browser import limit');
      inputs.push({
        path: name,
        file: new Blob([await readFile(file)]),
        archive: depth === 0 && /\.zip$/i.test(name),
      });
    } else throw Error(`Unsupported local package entry: ${name}`);
  }
  const directory = (await lstat(root)).isDirectory();
  await visit(root, directory ? '' : path.basename(root));
  return unpackFiles(inputs);
}
