import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { probeX87LogInBrowser } from './lib/wine-loader-browser.mjs';
const bytes = new Uint8Array(
  await readFile(new URL('../tests/fixtures/x87/logarithm.exe', import.meta.url)),
);
const report = {
  date: new Date().toISOString(),
  exeSha256: createHash('sha256').update(bytes).digest('hex'),
  ...(await probeX87LogInBrowser(fileURLToPath(new URL('../', import.meta.url)), {
    files: new Map([['logarithm.exe', bytes]]),
  })),
};
await writeFile(
  new URL('../evidence/x87-log-browser-results.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
assert.equal(report.status, 'passed', report.failure);
