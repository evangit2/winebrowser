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
const rosettaDiagnostic =
  process.platform === 'darwin' && process.argv.includes('--diagnose-rosetta');
if (process.platform === 'darwin' && !rosettaDiagnostic)
  throw Error(
    'Native x86 Linux is required for the hardware oracle. Rosetta changes NaN classification flags; use --diagnose-rosetta only to inspect those differences.',
  );
if (rosettaDiagnostic && process.argv.includes('--update'))
  throw Error('Rosetta output cannot replace the native x86 hardware reference');
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
          'Native Linux x86_64 SSE/SSE2 instructions compiled from the same C source with WB_SSE_ORACLE. CI repeats this on hardware; Rosetta is not the normative oracle.',
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
  const differences = [];
  for (let i = 0; i < actual.length; i += 24) {
    if (actual.subarray(i, i + 24).equals(expected.subarray(i, i + 24))) continue;
    differences.push({
      record: i / 24,
      control: Math.floor(i / 24 / 1200),
      op: actual.readUInt32LE(i) & 127,
      memory: !!(actual.readUInt32LE(i) & 128),
      actual: Array.from({ length: 6 }, (_, j) => actual.readUInt32LE(i + j * 4).toString(16)),
      expected: Array.from({ length: 6 }, (_, j) => expected.readUInt32LE(i + j * 4).toString(16)),
    });
  }
  if (differences.length) console.error(JSON.stringify({ differences }, null, 2));
  if (rosettaDiagnostic) {
    console.log(
      JSON.stringify({
        status: 'diagnostic-only',
        nativeHardware: false,
        differences: differences.length,
      }),
    );
    process.exit(0);
  }
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
