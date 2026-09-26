import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zipSync } from 'fflate';
import iced from 'iced-x86';
import { selectedFiles, droppedFiles, validateImportFiles } from '../src/import-files.js';
import { unpackFiles } from '../src/import-files.js';
import { packageFilesId } from '../src/storage.js';
import { Runtime } from '../src/runtime.js';

const input = (path, data, archive = false) => ({
  path,
  file: new File([data], path.split('/').at(-1)),
  archive,
});
const text = new TextEncoder();

test('loose program files and assets from a ZIP execute with their original relative paths', async () => {
  const exe = await readFile(new URL('../public/demos/files/files.exe', import.meta.url));
  const pkg = await unpackFiles([
    input('Program/Files.EXE', exe),
    input(
      'assets.zip',
      zipSync({ 'Program/assets/message.txt': text.encode('uploaded asset\r\n') }),
      true,
    ),
    input('Program/Extras/readme.txt', 'readme'),
  ]);
  assert.deepEqual(pkg.executables, ['program/files.exe']);
  const events = [];
  const result = await new Runtime(iced, {
    ...pkg,
    exe: pkg.executables[0],
    emit: (event) => events.push(event),
  }).run();
  assert.equal(result.exitCode, 0);
  assert.equal(
    events
      .filter((event) => event.type === 'stdout')
      .map((event) => event.text)
      .join(''),
    'uploaded asset\r\n',
  );
  assert.equal(result.outputs[0].path, 'program/output.txt');
});

test('folder uploads retain nested ZIPs as data and have stable path-sensitive package identities', async () => {
  const archive = zipSync({ 'inner.exe': text.encode('data') });
  const file = new File([archive], 'data.zip');
  Object.defineProperty(file, 'webkitRelativePath', { value: 'Game/Data.zip' });
  const selection = selectedFiles([file]);
  assert.equal(selection[0].archive, false);
  const pkg = await unpackFiles(selection);
  assert.deepEqual([...pkg.files.keys()], ['game/data.zip']);
  assert.deepEqual(pkg.files.get('game/data.zip'), archive);
  const files = new Map([
    ['a', text.encode('one')],
    ['b', text.encode('two')],
  ]);
  assert.equal(await packageFilesId(files), await packageFilesId(new Map([...files].reverse())));
  assert.notEqual(
    await packageFilesId(files),
    await packageFilesId(
      new Map([
        ['c', text.encode('one')],
        ['b', text.encode('two')],
      ]),
    ),
  );
});

test('merging inputs rejects traversal, duplicate paths, and file/directory conflicts across archives', async () => {
  await assert.rejects(unpackFiles([input('../escape.exe', 'x')]), /traversal/);
  await assert.rejects(unpackFiles([input('a.exe', 'a'), input('A.EXE', 'b')]), /Duplicate import/);
  for (const reverse of [false, true]) {
    const files = [input('data', 'a'), input('data/file', 'b')];
    await assert.rejects(unpackFiles(reverse ? files.reverse() : files), /conflicts with child/);
  }
  await assert.rejects(
    unpackFiles([
      input('app.zip', zipSync({ 'data.bin': text.encode('a') }), true),
      input('DATA.bin', 'b'),
    ]),
    /duplicate or case-colliding/,
  );
  assert.throws(() => validateImportFiles([]), /Choose files/);
  assert.throws(
    () => validateImportFiles(Array.from({ length: 2049 }, (_, n) => input(String(n), ''))),
    /2048/,
  );
  assert.throws(
    () => validateImportFiles([input('big', new Uint8Array(64 * 1024 * 1024 + 1))]),
    /64 MiB/,
  );
});

test('directory drops drain all readEntries batches and propagate unreadable files', async () => {
  const fileEntry = (name) => ({
    isFile: true,
    name,
    file: (resolve) => resolve(new File([name], name)),
  });
  let batch = 0;
  const entry = {
    isDirectory: true,
    name: 'Folder',
    createReader: () => ({
      readEntries: (resolve) =>
        resolve(
          batch++ < 2 ? Array.from({ length: 100 }, (_, n) => fileEntry(`${batch}-${n}.txt`)) : [],
        ),
    }),
  };
  const files = await droppedFiles({
    items: [{ kind: 'file', webkitGetAsEntry: () => entry, getAsFile: () => null }],
    files: [],
  });
  assert.equal(files.length, 200);
  assert.equal(files[199].path, 'Folder/2-99.txt');
  assert.ok(files.every((file) => !file.archive));
  const bad = {
    isFile: true,
    name: 'bad',
    file: (_resolve, reject) => reject(Error('unreadable')),
  };
  await assert.rejects(
    droppedFiles({
      items: [{ kind: 'file', webkitGetAsEntry: () => bad, getAsFile: () => null }],
      files: [],
    }),
    /unreadable/,
  );
  assert.deepEqual(
    (await droppedFiles({ files: [new File(['x'], 'file.txt')] })).map((f) => f.path),
    ['file.txt'],
  );
});
