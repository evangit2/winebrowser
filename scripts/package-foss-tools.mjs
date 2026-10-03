import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { zipSync, unzipSync } from 'fflate';
import { ModuleGraph } from '../src/modules.js';
import { API_NAMES } from '../src/win32.js';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const inputs = [
  [
    'diff-bin.zip',
    'https://downloads.sourceforge.net/gnuwin32/diffutils-2.8.7-1-bin.zip',
    '6d64ee291c9b49a2841dbccea9795140802ff6b73fd2f4848635bbc974dc5a9c',
  ],
  [
    'diff-dep.zip',
    'https://downloads.sourceforge.net/gnuwin32/diffutils-2.8.7-1-dep.zip',
    '9b64b20aa9e0b5be1045b4bdbd182e1f47b2136a55985083df0eaac3673b91a1',
  ],
  [
    'diff-source.zip',
    'https://downloads.sourceforge.net/gnuwin32/diffutils-2.8.7-1-src.zip',
    '622cdfe2dcf94d5f9fd05b9546395e624fe1b84ccb7ab473bbbe893f04423821',
  ],
  [
    'libintl-source.zip',
    'https://gnuwin32.sourceforge.net/downlinks/libintl-src-zip.php',
    'e51f536e6aaffdfe11f2c48280c985c18cc252264258362325816aaa127cd4da',
  ],
  [
    'libiconv-source.zip',
    'https://gnuwin32.sourceforge.net/downlinks/libiconv-src-zip.php',
    '06e31e8c7019fbaa0dd58aeaff97cdfe7238e67865b52de5f53083e2e04ed33f',
  ],
  [
    'optipng.zip',
    'https://downloads.sourceforge.net/optipng/optipng-0.7.8-win32.zip',
    '36587548648f75e92a317f052e83a8a55281d6b415bbf373106736bc2f50a730',
  ],
  [
    'optipng-source.tar.gz',
    'https://downloads.sourceforge.net/optipng/optipng-0.7.8.tar.gz',
    '25a3bd68481f21502ccaa0f4c13f84dcf6b20338e4c4e8c51f2cefbd8513398c',
  ],
  [
    '7zr.exe',
    'https://github.com/ip7z/7zip/releases/download/26.03/7zr.exe',
    'ad4c82fadcbdf93c03b4fc440f300509c7d60c5c2f4d183e35d9d70d6957037d',
  ],
  [
    '7zip-source.tar.xz',
    'https://www.7-zip.org/a/7z2603-src.tar.xz',
    '9cbde5099c6deb73691b0579063da5827522ccbbcba3f0020fd04e8c8c16c0d4',
  ],
];
await mkdir('.cache/foss', { recursive: true });
const verified = {};
for (const [name, url, sha256] of inputs) {
  let bytes;
  try {
    bytes = await readFile('.cache/foss/' + name);
  } catch {
    const response = await fetch(url);
    assert.ok(response.ok, url);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile('.cache/foss/' + name, bytes);
  }
  assert.equal(hash(bytes), sha256, name);
  verified[name] = bytes;
}
const diff = unzipSync(verified['diff-bin.zip']),
  dep = unzipSync(verified['diff-dep.zip']),
  opt = unzipSync(verified['optipng.zip']);
const diffSource = unzipSync(verified['diff-source.zip']),
  intlSource = unzipSync(verified['libintl-source.zip']),
  iconvSource = unzipSync(verified['libiconv-source.zip']);
const license = (files, suffix) => {
  const entry = Object.entries(files).find(([name]) => name.endsWith(suffix));
  assert.ok(entry, suffix);
  return entry[1];
};
const before = Buffer.from('alpha\nbeta\ngamma\n'),
  after = Buffer.from('alpha\nBETA\ngamma\ndelta\n');
const binary = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) & 255));
// A lossless, deliberately uncompressed 64x64 PNG with four coloured tiles.
const png = execFileSync('python3', [
  '-c',
  `import zlib,struct,sys\ndef c(t,b):return struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b))\ncolours=[(32,160,224),(224,64,32),(64,224,96),(224,192,32)]\nraw=b''.join(b'\\x00'+b''.join(bytes(colours[(x//16+y//16)%4]) for x in range(64)) for y in range(64))\nsys.stdout.buffer.write(b'\\x89PNG\\r\\n\\x1a\\n'+c(b'IHDR',struct.pack('>IIBBBBB',64,64,8,2,0,0,0))+c(b'IDAT',zlib.compress(raw,0))+c(b'IEND',b''))`,
]);
const archiveLicense = (name) =>
  execFileSync('tar', ['-xOf', '.cache/foss/7zip-source.tar.xz', 'DOC/' + name]);
const packages = [
  {
    name: 'gnu-diff',
    entry: 'diff.exe',
    args: ['-u', 'before.txt', 'after.txt'],
    description:
      'Unchanged GNU diffutils 2.8.7 Windows release with native libintl and libiconv DLLs. Shows a unified patch; exit 1 means files differ. Select cmp.exe to compare bytes.',
    files: {
      'diff.exe': diff['bin/diff.exe'],
      'cmp.exe': diff['bin/cmp.exe'],
      'libintl3.dll': dep['bin/libintl3.dll'],
      'libiconv2.dll': dep['bin/libiconv2.dll'],
      'COPYING.txt': license(diffSource, '/COPYING'),
      'libintl-COPYING.LIB': license(intlSource, '/COPYING.LIB-2.1'),
      'libiconv-COPYING.LIB': license(iconvSource, '/COPYING.LIB'),
      'before.txt': before,
      'after.txt': after,
    },
    sources: ['diff-source.zip', 'libintl-source.zip', 'libiconv-source.zip'],
    provenance:
      'Original GnuWin32 PE32 binaries, GNU diffutils GPL and libintl/libiconv LGPL. Companion DLLs are unchanged; Wine-source MSVCP60/MSVCRT/kernel32/kernelbase/ntdll load automatically.',
  },
  {
    name: 'optipng',
    entry: 'optipng.exe',
    args: ['-o1', '-out', 'optimized.png', 'input.png'],
    description:
      'Unchanged OptiPNG 0.7.8 Windows release: losslessly optimizes a four-colour PNG with its real libpng and zlib code. Download optimized.png after exit.',
    files: {
      'optipng.exe': opt['optipng-0.7.8-win32/optipng.exe'],
      'LICENSE.txt': opt['optipng-0.7.8-win32/doc/license.txt'],
      'AUTHORS.txt': opt['optipng-0.7.8-win32/doc/authors.txt'],
      'input.png': png,
    },
    sources: ['optipng-source.tar.gz'],
    provenance:
      'Original upstream PE32 OptiPNG 0.7.8 EXE; zlib/libpng included upstream. Permissive OptiPNG license and corresponding original source included.',
  },
  {
    name: '7zip',
    entry: '7zr.exe',
    args: ['a', 'out.7z', 'message.txt', 'binary.bin'],
    description:
      'Unchanged 7-Zip 26.03 standalone Windows archiver: compresses text and binary inputs to out.7z. Download the archive, or use t/x to test and extract an uploaded .7z.',
    files: {
      '7zr.exe': verified['7zr.exe'],
      'License.txt': archiveLicense('License.txt'),
      'copying.txt': archiveLicense('copying.txt'),
      'unRarLicense.txt': archiveLicense('unRarLicense.txt'),
      'message.txt': before,
      'binary.bin': binary,
    },
    sources: ['7zip-source.tar.xz'],
    provenance:
      'Original upstream 7zr.exe 26.03 PE32 release. LGPL-2.1-or-later with upstream unRAR restriction; licenses and complete corresponding source included.',
  },
];
const builtins = new Map();
const base = JSON.parse(await readFile('runtime/wine-base/manifest.json', 'utf8'));
for (const row of base.dlls)
  builtins.set(row.name, new Uint8Array(await readFile('public/runtime/wine-base/' + row.path)));
builtins.set('shell32.dll', new Uint8Array(await readFile('public/runtime/shell32.dll')));
builtins.set('wine-format.dll', new Uint8Array(await readFile('public/runtime/wine-format.dll')));
const zip = (files) =>
  zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [
        name,
        [bytes, { mtime: new Date('2000-01-01T00:00:00Z') }],
      ]),
    ),
    { level: 9 },
  );
const manifest = JSON.parse(await readFile('public/examples/manifest.json', 'utf8'));
const jsonBytes = (value) =>
  execFileSync(
    process.execPath,
    ['node_modules/prettier/bin/prettier.cjs', '--stdin-filepath', 'manifest.json'],
    { input: JSON.stringify(value, null, 2) + '\n' },
  );
for (const pkg of packages) {
  const directory = 'public/examples/' + pkg.name;
  await mkdir(directory, { recursive: true });
  const files = new Map(Object.entries(pkg.files));
  const bootstrap = new Map(
    [...builtins].filter(([name]) => ['shell32.dll', 'wine-format.dll'].includes(name)),
  );
  const initial = new ModuleGraph(files, pkg.entry, API_NAMES, bootstrap);
  const nativeClient = Object.keys(pkg.files).some((name) => name.endsWith('.dll'));
  const graph =
    nativeClient || initial.unresolved.length
      ? new ModuleGraph(files, pkg.entry, API_NAMES, builtins)
      : initial;
  assert.deepEqual(graph.unresolved, []);
  const audit = [...graph.modules.values()].map((m) => ({
    name: m.name,
    path: m.path,
    host: !!m.host,
    imports: m.pe?.imports?.length ?? 0,
    sha256: m.pe ? hash(m.bytes) : null,
  }));
  const provenance = {
    format: 1,
    name: pkg.name,
    entry: pkg.entry,
    args: pkg.args,
    provenance: pkg.provenance,
    inputs: inputs
      .filter(
        ([name]) =>
          pkg.sources.includes(name) ||
          Object.values(pkg.files).includes(verified[name]) ||
          (pkg.name === 'gnu-diff' && ['diff-bin.zip', 'diff-dep.zip'].includes(name)) ||
          (pkg.name === 'optipng' && name === 'optipng.zip'),
      )
      .map(([name, url, sha256]) => ({ name, url, sha256 })),
    files: Object.entries(pkg.files).map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: hash(bytes),
    })),
    dependencyClosure: audit,
    unresolvedImports: [],
  };
  pkg.files['PROVENANCE.json'] = jsonBytes(provenance);
  for (const [name, bytes] of Object.entries(pkg.files))
    await writeFile(directory + '/' + name, bytes);
  const archive = zip(pkg.files),
    source = zip(Object.fromEntries(pkg.sources.map((name) => [name, verified[name]])));
  await writeFile(directory + '/' + pkg.name + '.zip', archive);
  await writeFile(directory + '/source.zip', source);
  const row = {
    name: pkg.name,
    description: pkg.description,
    entry: pkg.entry,
    args: pkg.args,
    exe: pkg.name + '/' + pkg.entry,
    exeSha256: hash(pkg.files[pkg.entry]),
    zip: pkg.name + '/' + pkg.name + '.zip',
    zipSha256: hash(archive),
    sourceZip: pkg.name + '/source.zip',
    sourceZipSha256: hash(source),
    provenance: pkg.provenance,
  };
  manifest.interactive = manifest.interactive.filter((x) => x.name !== pkg.name);
  manifest.interactive.push(row);
  console.log(
    pkg.name,
    provenance.files.map((x) => [x.path, x.sha256]),
    audit.map((x) => x.name),
  );
}
await writeFile('public/examples/manifest.json', jsonBytes(manifest));
