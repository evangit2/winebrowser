import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { ModuleGraph } from '../src/modules.js';
import { API_NAMES } from '../src/win32.js';
import { loadWineBaseAssets } from '../src/wine-base-assets.js';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const meta = JSON.parse(await readFile('.cache/lame/build.json', 'utf8'));
const exe = await readFile('.cache/lame/lame.exe');
assert.equal(hash(exe), meta.exeSha256);
const archive = await readFile('.cache/lame/lame-3.100.tar.gz');
assert.equal(hash(archive), meta.sourceArchiveSha256);
const directory = 'public/examples/lame';
await mkdir(directory, { recursive: true });
function wav(rate, channels, frames) {
  const out = Buffer.alloc(44 + frames * channels * 2);
  out.write('RIFF');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(out.length - 44, 40);
  // Exact integer triangle waves keep package input bytes independent of libm.
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++) {
      const phase = (i * (c ? 5 : 3)) % 200;
      const value = (phase < 100 ? phase : 200 - phase) - 50;
      out.writeInt16LE(value * (c ? 180 : 240), 44 + 2 * (i * channels + c));
    }
  return out;
}
const files = {
  'lame.exe': exe,
  'stereo.wav': wav(44100, 2, 4410),
  'mono.wav': wav(22050, 1, 4410),
  'resample.wav': wav(48000, 2, 4800),
  COPYING: await readFile('.cache/lame/source/lame-3.100/COPYING'),
  'GCC-COPYING3': await readFile('third_party/gcc/COPYING3'),
  'GCC-COPYING.RUNTIME': await readFile('third_party/gcc/COPYING.RUNTIME'),
  'README.txt': Buffer.from(
    'LAME 3.100: original LGPL-2.0-or-later Windows i386 WAV/PCM encoder.\nRun lame.exe --silent --noreplaygain -b 128 stereo.wav output.mp3\nFull unmodified upstream source, license, build recipe and configuration are in source.zip.\nOptional MP3 decoder and libsndfile are not built. No game binaries are included.\n',
  ),
};
const { builtinFiles } = await loadWineBaseAssets('public/', async (p) => ({
  ok: true,
  arrayBuffer: async () => {
    const b = await readFile(p);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  },
}));
const graph = new ModuleGraph(new Map(Object.entries(files)), 'lame.exe', API_NAMES, builtinFiles);
assert.deepEqual(graph.unresolved, []);
const args = ['--silent', '--noreplaygain', '-b', '128', 'stereo.wav', 'output.mp3'];
const provenance = {
  format: 1,
  ...meta,
  args,
  files: Object.entries(files).map(([path, b]) => ({ path, bytes: b.length, sha256: hash(b) })),
  dependencyClosure: [...graph.modules.values()].map((m) => ({
    name: m.name,
    path: m.path,
    host: !!m.host,
    imports: m.pe?.imports?.length ?? 0,
    sha256: m.pe ? hash(m.bytes) : null,
  })),
  unresolvedImports: [],
};
files['PROVENANCE.json'] = Buffer.from(JSON.stringify(provenance, null, 2) + '\n');
const zip = (f) =>
  zipSync(
    Object.fromEntries(
      Object.entries(f).map(([name, bytes]) => [
        name,
        [bytes, { mtime: new Date(1980, 0, 1, 0, 0, 0) }],
      ]),
    ),
    { level: 9 },
  );
for (const [name, b] of Object.entries(files)) await writeFile(directory + '/' + name, b);
const pkg = zip(files);
await writeFile(directory + '/lame.zip', pkg);
const source = zip({
  'lame-3.100.tar.gz': archive,
  'scripts/build-lame.py': await readFile('scripts/build-lame.py'),
  'config.h': await readFile('.cache/lame/source/lame-3.100/config.h'),
  'BUILD.json': Buffer.from(JSON.stringify(meta, null, 2) + '\n'),
  COPYING: files.COPYING,
  'GCC-COPYING3': files['GCC-COPYING3'],
  'GCC-COPYING.RUNTIME': files['GCC-COPYING.RUNTIME'],
  'README.txt': Buffer.from(
    'Install i686 MinGW GCC, make and Python 3. Rebuild: python3 scripts/build-lame.py --source-archive lame-3.100.tar.gz\nThe source is unchanged. See BUILD.json for the pinned source, compiler and exact encoder options.\n',
  ),
});
await writeFile(directory + '/source.zip', source);
const manifest = JSON.parse(await readFile('public/examples/manifest.json', 'utf8'));
manifest.interactive = manifest.interactive.filter((row) => row.name !== 'lame');
manifest.interactive.push({
  name: 'lame',
  description:
    'LAME 3.100 MP3 encoder: converts the included stereo WAV to a 128 kbit/s MP3. Download output.mp3 when it finishes. Supply your own WAV alongside the EXE to encode it.',
  entry: 'lame.exe',
  args,
  exe: 'lame/lame.exe',
  exeSha256: hash(exe),
  zip: 'lame/lame.zip',
  zipSha256: hash(pkg),
  sourceZip: 'lame/source.zip',
  sourceZipSha256: hash(source),
  provenance:
    'LGPL-2.0-or-later LAME 3.100, built from unchanged hash-pinned upstream source as a Windows i386 SSE2/UCRT encoder. Complete original source, license and rebuild recipe included.',
});
await writeFile('public/examples/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      exeSha256: hash(exe),
      zipSha256: hash(pkg),
      sourceZipSha256: hash(source),
      unresolvedImports: graph.unresolved,
      dependencyClosure: provenance.dependencyClosure,
    },
    null,
    2,
  ),
);
