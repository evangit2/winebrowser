import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import iced from 'iced-x86';
import { CPU } from '../src/cpu.js';
import { Runtime } from '../src/runtime.js';
import { packageNeedsNativeBase } from '../src/wine-base-assets.js';
import { verifyAesZip } from './lib/verify-aes-zip.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const baseline = process.argv.find((a) => a.startsWith('--baseline='))?.slice(11);
assert.ok(baseline, 'Pass --baseline=<git revision>');
const revision = execFileSync('git', ['rev-parse', `${baseline}^{commit}`], {
  encoding: 'utf8',
}).trim();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const directory = path.join(root, '.cache/compiler-performance');
await mkdir(directory, { recursive: true });
const source = execFileSync('git', ['show', `${revision}:src/cpu.js`], { encoding: 'utf8' });
const filename = path.join(directory, 'flags-baseline.mjs');
await writeFile(
  filename,
  source.replaceAll(
    /from '\.\/([^']+)'/g,
    (_, name) => `from '${pathToFileURL(path.join(root, 'src', name)).href}'`,
  ),
);
const Before = (await import(pathToFileURL(filename))).CPU;

// Check every condition on all flag combinations, then arithmetic states at
// boundary operands and deterministic random operands, including carry and AF.
let checked = 0;
for (let bits = 0; bits < 32; bits++) {
  const f = Object.fromEntries(
    ['cf', 'zf', 'sf', 'of', 'pf'].map((key, n) => [key, (bits >>> n) & 1]),
  );
  for (let condition = -1; condition <= 16; condition++) {
    assert.ok(
      Object.is(
        Before.prototype.condition.call({ f }, condition),
        CPU.prototype.condition.call({ f }, condition),
      ),
    );
    checked++;
  }
}
let seed = 0x12345678;
const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
const values = [
  0, 1, 15, 16, 127, 128, 255, 256, 32767, 32768, 65535, 0x7fffffff, 0x80000000, 0xffffffff,
];
for (const width of [8, 16, 32])
  for (let kind = 0; kind < 8; kind++)
    for (let n = 0; n < 2048; n++) {
      const a = n < values.length ? values[n] : random(),
        b = random(),
        result = random();
      const flags = { cf: n & 1, zf: 0, sf: 0, of: 1, pf: 1 };
      const before = { f: { ...flags }, af: (n >>> 1) & 1 },
        after = { f: { ...flags }, af: before.af };
      Before.prototype.flags.call(before, a, b, result, kind, width);
      CPU.prototype.flags.call(after, a, b, result, kind, width);
      assert.deepEqual(after, before);
      checked++;
    }

const manifest = JSON.parse(await readFile('runtime/wine-base/manifest.json'));
const builtins = new Map(),
  nls = new Map();
for (const [rows, target] of [
  [manifest.dlls, builtins],
  [manifest.nls, nls],
])
  for (const row of rows) {
    const bytes = new Uint8Array(await readFile('public/runtime/wine-base/' + row.path));
    assert.equal(hash(bytes), row.sha256);
    target.set(row.name, bytes);
  }
for (const name of ['shell32.dll', 'wine-format.dll'])
  builtins.set(name, new Uint8Array(await readFile('public/runtime/' + name)));
const cli = new Map();
for (const name of ['7z.exe', '7z.dll', 'message.txt', 'binary.bin'])
  cli.set(name, new Uint8Array(await readFile('public/examples/7zip-full/' + name)));
assert.equal(
  hash(cli.get('7z.exe')),
  'cd74719140d12a6c837a6f78257df326f79b1a6ffcd632e9a2048e278899b733',
);
assert.equal(
  hash(cli.get('7z.dll')),
  'd132e89038c802c5d5281e543a83dc407680effe0144f21b4fb431dd45fca61d',
);
const putty = new Uint8Array(await readFile('.cache/targets/putty-x86.exe'));
assert.equal(hash(putty), '4c70267ca03a00ea761ec358498b990a7221decb36eace9b7dbe6a751be0fb3b');
const expected = Object.fromEntries(
  ['message.txt', 'binary.bin'].map((name) => [name, Buffer.from(cli.get(name))]),
);
const password = 'BrowserTest42';
const runs = [];
async function run(mode, workload, pair) {
  const gui = workload === 'putty-configuration';
  const files = gui ? new Map([['putty.exe', putty]]) : cli;
  const native = packageNeedsNativeBase(files);
  let ready, r;
  r = new Runtime(iced, {
    files,
    exe: gui ? 'putty.exe' : '7z.exe',
    maxBlocks: 10000000,
    args: gui
      ? []
      : [
          'a',
          'encrypted.zip',
          'message.txt',
          'binary.bin',
          '-tzip',
          `-p${password}`,
          '-mem=AES256',
          '-mmt=1',
        ],
    builtinFiles: native ? builtins : new Map(),
    nlsFiles: native ? nls : undefined,
    emit: (event) => {
      if (
        !gui ||
        ready ||
        event.type !== 'window' ||
        event.window.controlId !== 1058 ||
        !event.window.list?.items.some((item) => item.text === 'Default Settings')
      )
        return;
      ready = {
        elapsedMs: performance.now() - started,
        instructions: r.cpu.instructions,
        translationMs: r.cpu.translationMs,
      };
      const dialog = [...r.windows.windows.values()].find((w) => w.title === 'PuTTY Configuration');
      assert.ok(dialog);
      r.windows.post(dialog.id, 0x111, 2, 0); // Native IDCANCEL, then normal process exit.
    },
  });
  const methods = mode === 'before' ? Before.prototype : CPU.prototype;
  r.cpu.flags = methods.flags;
  r.cpu.condition = methods.condition;
  const started = performance.now();
  try {
    const result = await r.run();
    const elapsedMs = performance.now() - started;
    assert.equal(result.exitCode, 0);
    if (gui) assert.ok(ready, 'Native saved-session list must be populated before Cancel');
    else
      verifyAesZip(
        Buffer.from(result.outputs.find((o) => o.path === 'encrypted.zip').bytes),
        expected,
        password,
      );
    const record = {
      pair,
      mode,
      workload,
      elapsedMs,
      translationMs: result.x86TranslationMs,
      instructions: result.instructions,
      compiledBlocks: result.totalCompiledBlocks,
      ...(gui ? { ready } : {}),
    };
    runs.push(record);
    console.log(JSON.stringify(record));
  } finally {
    r.windows.dispose();
    r.cpu.dispose();
  }
}
for (let pair = 0; pair < 7; pair++)
  for (const workload of ['putty-configuration', '7zip-aes-zip'])
    for (const mode of pair % 2 ? ['after', 'before'] : ['before', 'after'])
      await run(mode, workload, pair);
const median = (a) => {
  a.sort((x, y) => x - y);
  const i = a.length >>> 1;
  return a.length % 2 ? a[i] : (a[i - 1] + a[i]) / 2;
};
const workloads = ['putty-configuration', '7zip-aes-zip'].map((workload) => {
  const medians = Object.fromEntries(
    ['before', 'after'].map((mode) => [
      mode,
      median(
        runs
          .filter((r) => r.pair > 0 && r.mode === mode && r.workload === workload)
          .map((r) => (workload === 'putty-configuration' ? r.ready.elapsedMs : r.elapsedMs)),
      ),
    ]),
  );
  return {
    workload,
    medianBeforeMs: medians.before,
    medianAfterMs: medians.after,
    reductionPercent: (100 * (medians.before - medians.after)) / medians.before,
  };
});
const report = {
  date: new Date().toISOString(),
  baselineCommit: revision,
  node: process.version,
  semanticComparisons: checked,
  scope:
    'Paired Node runtime runs with unchanged upstream binaries and inputs. Both use the current compiler and support libraries; only CPU.flags and CPU.condition use baseline or revised methods. Seven pairs alternate order; pair zero is excluded from medians. PuTTY measures native Configuration population, then dispatches native Cancel and checks normal exit. AES ZIP outputs are independently decrypted and authenticated. These are developer measurements of VM workloads, not browser render/download timings or general frame-rate claims.',
  programs: [
    { name: 'putty.exe', sha256: hash(putty) },
    { name: '7z.exe', sha256: hash(cli.get('7z.exe')) },
    { name: '7z.dll', sha256: hash(cli.get('7z.dll')) },
  ],
  workloads,
  runs,
};
await writeFile('evidence/cpu-flags-benchmark.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(workloads, null, 2));
