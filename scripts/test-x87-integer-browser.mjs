import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { probeX87IntegerInBrowser } from './lib/wine-loader-browser.mjs';

const files = new Map(
  await Promise.all(
    [['x87-integer.exe', 'x87-integer.exe']].map(async ([path, name]) => [
      path,
      new Uint8Array(
        await readFile(new URL('../tests/fixtures/x87-integer/' + name, import.meta.url)),
      ),
    ]),
  ),
);
const report = {
  date: new Date().toISOString(),
  sha256: Object.fromEntries(
    [...files].map(([path, data]) => [path, createHash('sha256').update(data).digest('hex')]),
  ),
  ...(await probeX87IntegerInBrowser(fileURLToPath(new URL('../', import.meta.url)), { files })),
};
await writeFile(
  new URL('../evidence/x87-integer-browser-results.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(JSON.stringify(report, null, 2));
assert.equal(report.status, 'passed', report.failure);
