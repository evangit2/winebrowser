import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { probeScalarSseInBrowser } from './lib/wine-loader-browser.mjs';
const bytes = new Uint8Array(
  await readFile(new URL('../tests/fixtures/sse/scalar.exe', import.meta.url)),
);
const report = {
  date: new Date().toISOString(),
  exeSha256: createHash('sha256').update(bytes).digest('hex'),
  ...(await probeScalarSseInBrowser(fileURLToPath(new URL('../', import.meta.url)), {
    files: new Map([['scalar.exe', bytes]]),
  })),
};
await writeFile(
  new URL('../evidence/scalar-sse-browser-results.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
assert.equal(report.status, 'passed', report.failure);
