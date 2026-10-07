import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import path from 'node:path';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const cases = [
  {
    name: 'stereo-cbr',
    input: 'stereo.wav',
    args: ['--silent', '--noreplaygain', '-b', '128', 'stereo.wav', 'output.mp3'],
  },
  {
    name: 'mono-vbr',
    input: 'mono.wav',
    args: ['--silent', '--noreplaygain', '-V', '4', 'mono.wav', 'output.mp3'],
  },
  {
    name: 'resample-cbr',
    input: 'resample.wav',
    args: [
      '--silent',
      '--noreplaygain',
      '--resample',
      '44.1',
      '-b',
      '96',
      'resample.wav',
      'output.mp3',
    ],
  },
];
await mkdir('tests/fixtures/lame', { recursive: true });
const exe = await readFile('public/examples/lame/lame.exe');
const results = [];
for (const row of cases) {
  const cwd = '.cache/lame/native/' + row.name;
  await mkdir(cwd, { recursive: true });
  await copyFile('public/examples/lame/lame.exe', cwd + '/lame.exe');
  await copyFile('public/examples/lame/' + row.input, cwd + '/' + row.input);
  await rm(cwd + '/output.mp3', { force: true });
  execFileSync(process.env.WINE || 'wine', ['lame.exe', ...row.args], {
    cwd,
    env: {
      ...process.env,
      WINEPREFIX: process.env.WINEPREFIX || path.resolve('.cache/lame/wine-prefix'),
      WINEDEBUG: '-all',
      MVK_CONFIG_LOG_LEVEL: '0',
      WINEDLLOVERRIDES: 'winemenubuilder.exe=d',
    },
    timeout: 120000,
  });
  const mp3 = await readFile(cwd + '/output.mp3');
  execFileSync(process.env.FFMPEG || 'ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    cwd + '/output.mp3',
    '-c:a',
    'pcm_s16le',
    cwd + '/decoded.wav',
  ]);
  const decoded = await readFile(cwd + '/decoded.wav');
  assert.equal(decoded.toString('ascii', 0, 4), 'RIFF');
  let format, pcm;
  for (let offset = 12; offset + 8 <= decoded.length;) {
    const size = decoded.readUInt32LE(offset + 4),
      id = decoded.toString('ascii', offset, offset + 4);
    if (id === 'fmt ')
      format = {
        channels: decoded.readUInt16LE(offset + 10),
        sampleRate: decoded.readUInt32LE(offset + 12),
      };
    if (id === 'data') pcm = decoded.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size & 1);
  }
  assert.ok(format && pcm?.length > 4000);
  const outputPath = 'tests/fixtures/lame/' + row.name + '.mp3';
  const result = {
    ...row,
    exeSha256: sha(exe),
    inputSha256: sha(await readFile(cwd + '/' + row.input)),
    outputPath,
    outputBytes: mp3.length,
    outputSha256: sha(mp3),
    decoded: {
      ...format,
      pcmBytes: pcm.length,
      frames: pcm.length / 2 / format.channels,
      pcmSha256: sha(pcm),
    },
  };
  if (process.argv.includes('--update')) await writeFile(outputPath, mp3);
  else assert.ok(mp3.equals(await readFile(outputPath)), row.name + ' native MP3 changed');
  results.push(result);
}
const report = {
  generator: 'scripts/check-lame-native.mjs',
  reference:
    'Same unmodified Windows i386 EXE executed under native Wine; MP3 independently decoded with ffmpeg. No browser runtime or JavaScript encoder computes reference output.',
  wine: execFileSync(process.env.WINE || 'wine', ['--version'], { encoding: 'utf8' }).trim(),
  ffmpeg: execFileSync(process.env.FFMPEG || 'ffmpeg', ['-version'], { encoding: 'utf8' }).split(
    '\n',
  )[0],
  cases: results,
};
if (process.argv.includes('--update'))
  await writeFile(
    'tests/fixtures/lame/native-reference.json',
    JSON.stringify(report, null, 2) + '\n',
  );
console.log(JSON.stringify(report, null, 2));
