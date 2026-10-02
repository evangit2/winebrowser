// Optional source-built Wine closure gate; build:wine-base prepares its inputs.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWineProbeInputs } from './lib/wine-probe-inputs.mjs';
import { probeWineCrtInBrowser, probeWineTargetInBrowser } from './lib/wine-loader-browser.mjs';
import { verifySourceBaseUpload } from './lib/source-base-upload.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { builtinFiles, nlsFiles, inputs } = await loadWineProbeInputs(root, {
  sourceBaseManifest: '.cache/wine-base/runtime.json',
});
const executable = new Uint8Array(
  await readFile(path.join(root, 'public/demos/console/console.exe')),
);
const services = await probeWineCrtInBrowser(root, { executable, builtinFiles, nlsFiles });
assert.equal(services.status, 'verified-crt-services');
assert.equal(services.processExitCode, 0);
assert.equal(services.firstFailure, null);
const application = await probeWineTargetInBrowser(root, {
  files: new Map([['console.exe', executable]]),
  exe: 'console.exe',
  builtinFiles,
  nlsFiles,
  limits: { maxExecutionMs: 30000, useRuntimeStartup: true },
  workerTimeoutMs: 60000,
});
assert.equal(application.status, 'entry-returned');
assert.equal(application.exitCode, 0);
assert.equal(application.firstFailure, null);
assert.deepEqual(application.output, ['console demo: hello from WriteFile\r\n']);
const upload = await verifySourceBaseUpload(root, executable, builtinFiles, nlsFiles);
await writeFile(
  path.join(root, 'evidence/wine-source-base-browser-results.json'),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      scope:
        'Pinned source-built Wine base DLLs and source NLS, real CRT/TLS/file services, Runtime.run() console startup and ordinary packaged ZIP upload in Chromium. Supplied package DLLs keep their precedence over automatic runtime base assets.',
      inputs,
      services,
      application,
      upload,
    },
    null,
    2,
  ) + '\n',
);
console.log('Source-built Wine CRT services and console entry/exit verified in Chromium.');
