import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { probeSharedDataInBrowser } from './lib/wine-loader-browser.mjs';

const files = new Map(
  await Promise.all(
    [['shared-data.exe', 'shared-data.exe']].map(async ([path, name]) => [
      path,
      new Uint8Array(
        await readFile(new URL('../tests/fixtures/shared-data/' + name, import.meta.url)),
      ),
    ]),
  ),
);
const report = {
  date: new Date().toISOString(),
  sha256: Object.fromEntries(
    [...files].map(([path, data]) => [path, createHash('sha256').update(data).digest('hex')]),
  ),
  ...(await probeSharedDataInBrowser(fileURLToPath(new URL('../', import.meta.url)), { files })),
};
await writeFile(
  new URL('../evidence/shared-data-browser-results.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
assert.equal(report.status, 'passed', report.failure);
