import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url)),
  dir = path.join(root, '.cache/packed-sse-oracle');
await mkdir(dir, { recursive: true });
const source = 'tests/fixtures/packed-sse/client.c',
  binary = path.join(dir, 'oracle');
const flags = process.platform === 'darwin' ? ['-arch', 'x86_64'] : [];
execFileSync(process.env.CC || 'cc', [
  ...flags,
  '-msse2',
  '-O1',
  '-DWB_SSE_ORACLE',
  path.join(root, source),
  '-o',
  binary,
]);
execFileSync(binary, [], { cwd: dir });
const actual = await readFile(path.join(dir, 'packed-sse-results.bin'));
assert.equal(actual.length, 8400 * 24);
const target = path.join(root, 'tests/fixtures/packed-sse/native-oracle.bin');
const sha = (b) => createHash('sha256').update(b).digest('hex');
if (process.argv.includes('--update')) {
  await writeFile(target, actual);
  await writeFile(
    path.join(root, 'tests/fixtures/packed-sse/native-oracle.json'),
    JSON.stringify(
      {
        source,
        sourceSha256: sha(await readFile(path.join(root, source))),
        records: 8400,
        recordBytes: 24,
        bytes: actual.length,
        sha256: sha(actual),
        reference:
          'Native x86 SSE/SSE2 instructions compiled from the same C source with WB_SSE_ORACLE. macOS uses x86_64 Rosetta; CI repeats this on a Linux x86_64 runner.',
        floatingPointResultsComputedByJavascript: false,
        roundingModes: 4,
        dazAndFtz: true,
        registerAndMemoryOperands: true,
      },
      null,
      2,
    ) + '\n',
  );
} else {
  const expected = await readFile(target);
  assert.ok(
    actual.equals(expected),
    'Native SSE oracle differs from retained answers: ' + sha(actual),
  );
}
console.log(
  JSON.stringify({
    status: 'passed',
    platform: process.platform,
    architecture: 'x86_64',
    records: 8400,
    sha256: sha(actual),
  }),
);
