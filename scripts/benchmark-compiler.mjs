import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(root, '.cache/compiler-performance');
await mkdir(directory, { recursive: true });
const option = (name) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
const baseline = option('baseline');
assert.ok(
  baseline,
  'Pass --baseline=<git commit> to compare the compiler with a previous revision',
);
const revision = execFileSync('git', ['rev-parse', '--verify', `${baseline}^{commit}`], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const executable = new Uint8Array(await readFile(path.join(root, 'public/examples/7zip/7zr.exe')));
assert.equal(hash(executable), 'ad4c82fadcbdf93c03b4fc440f300509c7d60c5c2f4d183e35d9d70d6957037d');
const payload = Uint8Array.from({ length: 8192 }, (_, i) => (i * 37 + 11) & 255);
const corpus = new Map();
const runtime = new Runtime(iced, {
  files: new Map([
    ['7zr.exe', executable],
    ['payload.bin', payload],
  ]),
  exe: '7zr.exe',
  args: ['a', 'out.7z', 'payload.bin', '-mmt=1'],
  maxBlocks: 10000000,
});
const compile = runtime.cpu.compile.bind(runtime.cpu);
runtime.cpu.compile = (ip, ...args) => {
  const block = compile(ip, ...args);
  corpus.set(ip, { ip, bytes: runtime.data.slice(ip, block.end), count: block.count });
  return block;
};
const result = await runtime.run();
assert.equal(result.exitCode, 0);
assert.ok(result.outputs.some((e) => e.path === 'out.7z'));

// Both revisions import the same CPU support libraries. Only their compiler
// and Wasm encoder differ; capture each emitted binary to check exact equality.
const modes = {};
for (const mode of ['before', 'after']) {
  const cpuSource =
    mode === 'before'
      ? execFileSync('git', ['show', `${revision}:src/cpu.js`], { cwd: root, encoding: 'utf8' })
      : await readFile(path.join(root, 'src/cpu.js'), 'utf8');
  const wasmSource =
    mode === 'before'
      ? execFileSync('git', ['show', `${revision}:src/wasm.js`], { cwd: root, encoding: 'utf8' })
      : await readFile(path.join(root, 'src/wasm.js'), 'utf8');
  await writeFile(path.join(directory, `wasm-${mode}.mjs`), wasmSource);
  const source =
    cpuSource
      .replaceAll(
        /from '\.\/([^']+)'/g,
        (_, name) =>
          `from '${
            name === 'wasm.js'
              ? pathToFileURL(path.join(directory, `wasm-${mode}.mjs`)).href
              : pathToFileURL(path.join(root, 'src', name)).href
          }'`,
      )
      .replace('  moduleBytes,', '  moduleBytes as encodeBlock,') +
    '\nexport const benchmarkBinaries=[];\nconst moduleBytes=code=>{const b=encodeBlock(code);benchmarkBinaries.push(b);return b;};\n';
  const filename = path.join(directory, `compiler-${mode}.mjs`);
  await writeFile(filename, source);
  modes[mode] = await import(pathToFileURL(filename));
}
const end = Math.max(...[...corpus.values()].map((b) => b.ip + b.bytes.length));
const memory = new WebAssembly.Memory({ initial: Math.ceil(end / 65536) + 1 });
const data = new Uint8Array(memory.buffer),
  view = new DataView(memory.buffer);
for (const block of corpus.values()) data.set(block.bytes, block.ip);
const runs = [];
let fingerprint;
for (let pair = 0; pair < 7; pair++) {
  for (const mode of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
    const implementation = modes[mode];
    implementation.benchmarkBinaries.length = 0;
    const cpu = new implementation.CPU(iced, {
      memory,
      read32: (a) => view.getUint32(a, true),
      write32: (a, v) => view.setUint32(a, v, true),
      executableRanges: [[0, end]],
      fsBase: 0x2000,
    });
    const started = performance.now();
    for (const block of corpus.values()) {
      const compiled = cpu.compile(block.ip);
      assert.equal(compiled.end, block.ip + block.bytes.length);
      assert.equal(compiled.count, block.count);
    }
    const elapsedMs = performance.now() - started;
    const binaries = createHash('sha256');
    for (const binary of implementation.benchmarkBinaries) binaries.update(binary);
    const digest = binaries.digest('hex');
    fingerprint ??= digest;
    assert.equal(
      digest,
      fingerprint,
      'The revised compiler must emit identical Wasm for every block',
    );
    runs.push({
      pair,
      mode,
      elapsedMs,
      translationMs: cpu.translationMs,
      blocks: cpu.compilations,
      bytes: cpu.compiledBytes,
      wasmSha256: digest,
    });
    console.log(JSON.stringify(runs.at(-1)));
    cpu.clearCache();
    cpu.dispose();
    if (mode === 'before') cpu.infoFactory?.free();
  }
}
const median = (numbers) => numbers.sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
const medians = Object.fromEntries(
  ['before', 'after'].map((mode) => [
    mode,
    median(runs.filter((r) => r.mode === mode && r.pair > 0).map((r) => r.elapsedMs)),
  ]),
);
const report = {
  date: new Date().toISOString(),
  baselineCommit: revision,
  node: process.version,
  scope:
    'Cold compilation of every block reached by unchanged upstream 7zr.exe compressing an 8192-byte input. Seven pairs alternate order; the warm-up pair is excluded from medians. Generated Wasm bytes and block boundaries are identical. This is a compiler benchmark, not a browser startup or frame-rate measurement.',
  corpus: {
    executableSha256: hash(executable),
    inputSha256: hash(payload),
    blocks: corpus.size,
    guestInstructions: result.instructions,
  },
  medianBeforeMs: medians.before,
  medianAfterMs: medians.after,
  reductionPercent: (100 * (medians.before - medians.after)) / medians.before,
  runs,
};
await writeFile(
  path.join(root, 'evidence/compiler-block-benchmark.json'),
  JSON.stringify(report, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    { before: medians.before, after: medians.after, reductionPercent: report.reductionPercent },
    null,
    2,
  ),
);
