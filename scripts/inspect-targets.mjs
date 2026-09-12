import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inspect } from '../src/runtime.js';

// Downloads live in fetch-targets.mjs. Inspection never replaces pinned artifacts.
const manifest = JSON.parse(await readFile('tests/targets.json', 'utf8'));
const builtinFiles = new Map([
  ['shell32.dll', new Uint8Array(await readFile('public/runtime/shell32.dll'))],
  ['wine-format.dll', new Uint8Array(await readFile('public/runtime/wine-format.dll'))],
]);
const results = [];
for (const target of manifest.targets) {
  const result = { id: target.id, path: target.path, sha256: target.sha256 };
  try {
    const bytes = new Uint8Array(await readFile(target.path));
    if (createHash('sha256').update(bytes).digest('hex') !== target.sha256)
      throw Error('Target SHA-256 differs from pinned manifest; run fetch:targets');
    result.bytes = bytes.length;
    const name = target.path.split('/').at(-1).toLowerCase();
    const pe = inspect(bytes, new Map([[name, bytes]]), name, builtinFiles);
    Object.assign(result, {
      machine: pe.machine,
      imports: pe.imports.length,
      status: pe.unsupported.length ? 'blocked-imports' : 'imports-resolved-not-executed',
      unsupported: pe.unsupported,
    });
  } catch (error) {
    Object.assign(result, {
      status: error.code === 'ENOENT' ? 'not-fetched' : 'blocked-loader',
      error: error.message,
    });
  }
  results.push(result);
}
await mkdir('evidence', { recursive: true });
await writeFile(
  'evidence/target-blockers.json',
  JSON.stringify(
    {
      date: new Date().toISOString(),
      scope:
        'Static PE/import graph inspection only. No binaries executed; passing imports do not establish compatibility. Target DLL assets are not automatically discovered.',
      results,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  results.map(({ id, status, error, unsupported }) => ({
    id,
    status,
    error,
    missingImports: unsupported?.length,
  })),
);
