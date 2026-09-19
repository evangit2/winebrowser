import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePE } from '../../src/pe.js';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const installedHashes = {
  'msvcrt.dll': '612edff0b1d2493a6c491aa3be10f1b42a961f8516db8cffe3d59dbe4c192558',
  'kernel32.dll': 'c4b1f1f1210e85acc9f82a898664b1c79b6e83e0485cb59e2e6251885cde9418',
  'kernelbase.dll': '4fae98d80c69cf36fbfc669acbe87676f0ad06dcebb85cff7b4abee13912a6f6',
};

// Optional local Wine inputs: verify provenance before handing bytes to Node or
// an intercepted browser test route. Nothing here publishes installed files.
export async function loadWineProbeInputs(root, { wineDirectory, nlsDirectory }) {
  const manifestPath = path.join(root, '.cache/wine-loader/manifest.json');
  const inputs = {
    manifest: path.relative(root, manifestPath),
    wineDirectory,
    nlsDirectory,
    dlls: [],
    nls: [],
  };
  if (!wineDirectory || !nlsDirectory)
    throw Error(
      'Pass the pinned i386 Wine DLL directory and NLS directory as arguments or WINEBROWSER_WINE_DIR/WINEBROWSER_NLS_DIR.',
    );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.sourceRevision, 'db11d0fe6a169c457e23d007e20404643d067aa8');
  assert.equal(
    manifest.sourceSha256,
    '18aaee150ad540885b9706ae73ccf6febca904049de2792199a9dc18a2772e6a',
  );
  assert.equal(
    manifest.patchSha256,
    sha256(await readFile(path.join(root, 'runtime/wine/browser-loader.patch'))),
  );
  assert.equal(manifest.artifactPathBase, 'manifest-directory');
  const patchedPath = path.resolve(path.dirname(manifestPath), manifest.artifact.path);
  const patched = new Uint8Array(await readFile(patchedPath));
  assert.equal(patched.length, manifest.artifact.bytes);
  assert.equal(sha256(patched), manifest.artifact.sha256);
  assert.equal(parsePE(patched, { allowDll: true }).isDll, true);
  Object.assign(inputs, {
    sourceRevision: manifest.sourceRevision,
    sourceSha256: manifest.sourceSha256,
    patchSha256: manifest.patchSha256,
  });
  inputs.dlls.push({
    name: 'ntdll.dll',
    path: patchedPath,
    bytes: patched.length,
    sha256: sha256(patched),
  });
  const builtinFiles = new Map([['ntdll.dll', patched]]);
  for (const [name, expected] of Object.entries(installedHashes)) {
    const filename = path.join(wineDirectory, name);
    const bytes = new Uint8Array(await readFile(filename));
    assert.equal(sha256(bytes), expected, `${name} differs from the pinned installed DLL`);
    assert.equal(parsePE(bytes, { allowDll: true }).isDll, true);
    builtinFiles.set(name, bytes);
    inputs.dlls.push({ name, path: filename, bytes: bytes.length, sha256: expected });
  }
  const nlsManifest = JSON.parse(
    await readFile(path.join(root, 'runtime/wine/nls-probe-manifest.json'), 'utf8'),
  );
  assert.equal(nlsManifest.wineCommit, manifest.sourceRevision);
  const nlsFiles = new Map();
  for (const [name, expected] of Object.entries(nlsManifest.files)) {
    let filename = path.join(nlsDirectory, name),
      bytes;
    try {
      bytes = new Uint8Array(await readFile(filename));
    } catch (error) {
      if (name !== 'sortdefault.nls' || error.code !== 'ENOENT') throw error;
      filename = path.resolve(nlsDirectory, '../globalization/sorting/sortdefault.nls');
      bytes = new Uint8Array(await readFile(filename));
    }
    assert.equal(bytes.length, expected.bytes, `${name} length differs from the pinned NLS file`);
    assert.equal(sha256(bytes), expected.sha256, `${name} differs from the pinned NLS file`);
    nlsFiles.set(name, bytes);
    inputs.nls.push({ name, path: filename, bytes: bytes.length, sha256: expected.sha256 });
  }
  return { builtinFiles, nlsFiles, inputs };
}
