import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mixerWave } from './lib/winmm-probe.js';
import { probeWinmmInBrowser } from './lib/wine-loader-browser.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const executable = new Uint8Array(
  await readFile(new URL('../tests/fixtures/winmm/mixer.exe', import.meta.url)),
);
const report = {
  date: new Date().toISOString(),
  exeSha256: createHash('sha256').update(executable).digest('hex'),
  ...(await probeWinmmInBrowser(root, {
    files: new Map([
      ['mixer.exe', executable],
      ['tone.wav', mixerWave()],
    ]),
  })),
};
await writeFile(
  new URL('../evidence/winmm-browser-results.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
assert.equal(report.status, 'passed', report.failure);
