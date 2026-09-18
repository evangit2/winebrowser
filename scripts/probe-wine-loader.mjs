import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iced from 'iced-x86';
import { probeWineLoader } from './lib/wine-loader-probe.js';

// This diagnostic is deliberately separate from the unchanged installed-Wine
// probe. It accepts only a source-built bridge matching its build manifest and
// the current patch. No private Wine data addresses are read or overwritten.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = process.argv.includes('--browser');
const args = process.argv.slice(2).filter((arg) => arg !== '--browser');
const manifestPath = args[0];
if (!manifestPath)
  throw Error(
    'Usage: node scripts/probe-wine-loader.mjs /path/to/build-manifest.json [nls-directory] [--browser]',
  );
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
assert.equal(manifest.sourceRevision, 'db11d0fe6a169c457e23d007e20404643d067aa8');
assert.equal(
  manifest.sourceSha256,
  '18aaee150ad540885b9706ae73ccf6febca904049de2792199a9dc18a2772e6a',
);
assert.equal(
  manifest.patchSha256,
  hash(await readFile(path.join(root, 'runtime/wine/browser-loader.patch'))),
);
assert.equal(manifest.artifactPathBase, 'manifest-directory');
const dll = new Uint8Array(
  await readFile(path.resolve(path.dirname(manifestPath), manifest.artifact.path)),
);
assert.equal(hash(dll), manifest.artifact.sha256);
assert.equal(dll.length, manifest.artifact.bytes);
const fixture = async (name) => new Uint8Array(await readFile(path.join(root, name)));
const files = new Map([
  ['console.exe', await fixture('public/demos/console/console.exe')],
  ['math.dll', await fixture('tests/fixtures/modules/math.dll')],
]);
const nlsFiles = new Map();
if (args[1]) {
  const nlsManifest = JSON.parse(
    await readFile(path.join(root, 'runtime/wine/nls-probe-manifest.json'), 'utf8'),
  );
  for (const name of ['c_1252.nls', 'c_437.nls', 'l_intl.nls']) {
    const bytes = new Uint8Array(await readFile(path.join(args[1], name)));
    assert.equal(hash(bytes), nlsManifest.files[name].sha256);
    nlsFiles.set(name, bytes);
  }
}
const report = {
  date: new Date().toISOString(),
  scope:
    'Experimental source-built Wine loader metadata and version bootstrap. No application entry point or graphics execution; normal package loading is unchanged.',
  build: {
    sourceRevision: manifest.sourceRevision,
    sourceSha256: manifest.sourceSha256,
    patchSha256: manifest.patchSha256,
    dllSha256: manifest.artifact.sha256,
    dllBytes: dll.length,
    compilers: manifest.compilers,
  },
  nls: [...nlsFiles].map(([name, bytes]) => ({ name, sha256: hash(bytes), bytes: bytes.length })),
  status: 'blocked',
  cases: [],
};
const result = browser
  ? await (
      await import('./lib/wine-loader-browser.mjs')
    ).probeWineLoaderInBrowser(root, { files, dll, nlsFiles })
  : await probeWineLoader(iced, { files, dll, nlsFiles });
Object.assign(report, result);
if (report.status === 'blocked') process.exitCode = 1;
await writeFile(
  path.join(
    root,
    browser ? 'evidence/wine-loader-browser-results.json' : 'evidence/wine-loader-results.json',
  ),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    { status: report.status, cases: report.cases, failure: report.failure, blocks: report.blocks },
    null,
    2,
  ),
);
