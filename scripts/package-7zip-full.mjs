import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { ModuleGraph } from '../src/modules.js';
import { API_NAMES } from '../src/win32.js';
import { packageNeedsNativeBase } from '../src/wine-base-assets.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inputs = [
  {
    name: '7z2603.exe',
    url: 'https://github.com/ip7z/7zip/releases/download/26.03/7z2603.exe',
    sha256: '0f6ec2eda1f8c5dc4c267ee761c0dad8a9d5e8863e0c84b7ac026bc9625a1560',
  },
  {
    name: '7zip-source.tar.xz',
    url: 'https://github.com/ip7z/7zip/releases/download/26.03/7z2603-src.tar.xz',
    sha256: '9cbde5099c6deb73691b0579063da5827522ccbbcba3f0020fd04e8c8c16c0d4',
  },
];
await mkdir('.cache/foss', { recursive: true });
const verified = new Map();
for (const input of inputs) {
  let bytes;
  try {
    bytes = await readFile('.cache/foss/' + input.name);
  } catch {
    const response = await fetch(input.url);
    assert.ok(response.ok, input.url);
    bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(hash(bytes), input.sha256);
    await writeFile('.cache/foss/' + input.name, bytes);
  }
  assert.equal(hash(bytes), input.sha256, input.name);
  verified.set(input.name, bytes);
}
execFileSync(
  process.env.WINEBROWSER_7ZZ || '7zz',
  ['x', '-y', '-o.cache/foss/7zip-full', '.cache/foss/7z2603.exe'],
  { stdio: 'ignore' },
);
const files = new Map();
for (const name of ['7z.exe', '7z.dll', 'License.txt', 'readme.txt'])
  files.set(name, new Uint8Array(await readFile('.cache/foss/7zip-full/' + name)));
assert.equal(
  hash(files.get('7z.exe')),
  'cd74719140d12a6c837a6f78257df326f79b1a6ffcd632e9a2048e278899b733',
);
assert.equal(
  hash(files.get('7z.dll')),
  'd132e89038c802c5d5281e543a83dc407680effe0144f21b4fb431dd45fca61d',
);
files.set(
  'message.txt',
  new TextEncoder().encode('Full native 7-Zip codec DLL: ZIP, LZMA2 and encrypted ZIP.\n'),
);
files.set(
  'binary.bin',
  Uint8Array.from({ length: 8192 }, (_, i) => (i * 37 + 11) & 255),
);
const entry = '7z.exe',
  args = ['a', 'out.zip', 'message.txt', 'binary.bin', '-tzip', '-mmt=1'];
assert.equal(packageNeedsNativeBase(files), true);
const base = JSON.parse(await readFile('runtime/wine-base/manifest.json', 'utf8'));
const builtins = new Map();
for (const row of base.dlls) {
  const bytes = new Uint8Array(await readFile('public/runtime/wine-base/' + row.path));
  assert.equal(hash(bytes), row.sha256);
  builtins.set(row.name, bytes);
}
for (const name of ['shell32.dll', 'wine-format.dll'])
  builtins.set(name, new Uint8Array(await readFile('public/runtime/' + name)));
const graph = new ModuleGraph(files, entry, API_NAMES, builtins);
// The CLI loads its codec DLL dynamically. Audit that dependency too.
graph.load('7z.dll');
assert.deepEqual(graph.unresolved, []);
const provenance =
  'Unchanged upstream 7-Zip 26.03 PE32 7z.exe and 7z.dll extracted from the original installer. LGPL-2.1-or-later, BSD and upstream unRAR restriction; original license and complete source included. Native Wine base loads automatically.';
const format = (value) =>
  execFileSync(
    process.execPath,
    ['node_modules/prettier/bin/prettier.cjs', '--stdin-filepath', 'manifest.json'],
    { input: JSON.stringify(value, null, 2) + '\n' },
  );
files.set(
  'PROVENANCE.json',
  format({
    format: 1,
    name: '7zip-full',
    entry,
    args,
    provenance,
    inputs,
    files: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: hash(bytes) })),
    dependencyClosure: [...graph.modules.values()].map((m) => ({
      name: m.name,
      path: m.path,
      host: !!m.host,
      imports: m.pe?.imports.length ?? 0,
      sha256: m.pe ? hash(m.bytes) : null,
    })),
    dynamicDependencies: ['7z.dll'],
    unresolvedImports: [],
  }),
);
const zip = (entries) =>
  zipSync(
    Object.fromEntries(
      [...entries]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, bytes]) => [name, [bytes, { mtime: new Date('2000-01-01T00:00:00Z') }]]),
    ),
    { level: 9 },
  );
const directory = 'public/examples/7zip-full';
await mkdir(directory, { recursive: true });
for (const [name, bytes] of files) await writeFile(directory + '/' + name, bytes);
const archive = zip(files),
  source = zip(new Map([['7z2603-src.tar.xz', verified.get('7zip-source.tar.xz')]]));
await writeFile(directory + '/7zip-full.zip', archive);
await writeFile(directory + '/source.zip', source);
const manifest = JSON.parse(await readFile('public/examples/manifest.json', 'utf8'));
manifest.interactive = manifest.interactive.filter((e) => e.name !== '7zip-full');
manifest.interactive.push({
  name: '7zip-full',
  description:
    'Full unchanged 7-Zip EXE and native codec DLL: creates a ZIP of text and binary inputs. ZIP/7z extraction, CRC and AES-256 ZIP encryption are browser-tested. Use -pPASSWORD -mem=AES256 for encrypted ZIP.',
  entry,
  args,
  exe: '7zip-full/7z.exe',
  exeSha256: hash(files.get('7z.exe')),
  zip: '7zip-full/7zip-full.zip',
  zipSha256: hash(archive),
  sourceZip: '7zip-full/source.zip',
  sourceZipSha256: hash(source),
  provenance,
});
await writeFile('public/examples/manifest.json', format(manifest));
console.log(
  JSON.stringify(
    {
      files: [...files.keys()],
      archiveSha256: hash(archive),
      sourceSha256: hash(source),
      modules: [...graph.modules.keys()],
    },
    null,
    2,
  ),
);
