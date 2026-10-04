import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { chooseBrowserFile } from '../src/win32-file-dialog.js';
import { OFN, fileDialogSelection, matchesFileFilter } from '../src/file-dialog-model.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup(wide = false, save = false, capacity = 260, flags = OFN.NOCHANGEDIR) {
  const r = new Runtime(iced, {
    files: new Map([
      ['console.exe', exe],
      ['docs/test.txt', new Uint8Array([65])],
      ['docs/second.txt', new Uint8Array([66])],
    ]),
    exe: 'console.exe',
  });
  const p = r.allocate(88),
    buffer = r.allocate(capacity * (wide ? 2 : 1)),
    title = r.allocate(32 * (wide ? 2 : 1));
  r.write32(p, 88);
  r.write32(p + 28, buffer);
  r.write32(p + 32, capacity);
  r.write32(p + 36, title);
  r.write32(p + 40, 32);
  r.write32(p + 52, flags);
  r.request = async () => null;
  return { r, p, buffer, title, call: () => chooseBrowserFile(r, () => p, wide, save) };
}
test('Open/Save A/W cancellation preserves filenames, structs, outputs, imports and cwd', async () => {
  for (const wide of [false, true])
    for (const save of [false, true]) {
      const { r, p, buffer, call } = setup(wide, save);
      r.write32(p, 76);
      if (wide) r.view.setUint16(buffer, 65, true);
      else r.data[buffer] = 65;
      const before = r.data.slice(p, buffer + 8),
        cwd = r.cwd;
      assert.equal((await call()).result, 0);
      assert.equal(r.commonDialogError, 0);
      assert.deepEqual(r.data.slice(p, buffer + 8), before);
      assert.equal(r.cwd, cwd);
    }
});
test('A/W selected files write native offsets, title, extension and nFilterIndex, without creating output', async () => {
  for (const wide of [false, true]) {
    const { r, p, buffer, title, call } = setup(wide, true);
    r.write32(p + 12, r.allocString('Text\0*.txt\0All\0*.*\0\0', wide));
    r.write32(p + 60, r.allocString('txt', wide));
    r.request = async (kind, req) => {
      assert.equal(kind, 'choose-file');
      assert.equal(req.save, true);
      assert.equal(req.filters.length, 2);
      assert.equal(req.files.length, 3);
      return { names: ['saved'], directory: 'docs', filterIndex: 1, readonly: false };
    };
    assert.equal((await call()).result, 1);
    const path = wide ? r.wideString(buffer) : r.string(buffer);
    assert.equal(path, 'C:\\winebrowser\\docs\\saved.txt');
    assert.equal(r.view.getUint16(p + 56, true), path.indexOf('saved'));
    assert.equal(r.view.getUint16(p + 58, true), path.length - 3);
    assert.equal(wide ? r.wideString(title) : r.string(title), 'saved.txt');
    assert.equal(r.read32(p + 24), 1);
    assert.equal(r.read32(p + 52) & OFN.EXTENSIONDIFFERENT, 0);
    assert.equal(r.files.has('docs/saved.txt'), false);
    assert.equal(r.cwd, '');
  }
});
test('Explorer multiselect has native double-NUL directory/names output and offset', async () => {
  for (const wide of [false, true]) {
    const { r, p, buffer, call } = setup(
      wide,
      false,
      260,
      OFN.EXPLORER | OFN.ALLOWMULTISELECT | OFN.FILEMUSTEXIST,
    );
    r.request = async () => ({
      names: ['test.txt', 'second.txt'],
      directory: 'docs',
      filterIndex: 1,
    });
    assert.equal((await call()).result, 1);
    const expected = 'C:\\winebrowser\\docs\0test.txt\0second.txt\0\0';
    const value = wide
      ? new TextDecoder('utf-16le').decode(r.data.slice(buffer, buffer + expected.length * 2))
      : new TextDecoder().decode(r.data.slice(buffer, buffer + expected.length));
    assert.equal(value, expected);
    assert.equal(r.view.getUint16(p + 56, true), 20);
    assert.equal(r.view.getUint16(p + 58, true), 0);
    assert.equal(r.cwd, 'docs/');
  }
});
test('FNERR_BUFFERTOOSMALL writes only required WORD and never commits imported files', async () => {
  for (const wide of [false, true]) {
    const { r, p, buffer, call } = setup(wide, false, 4);
    r.request = async (_kind, req) => ({
      names: ['new.txt'],
      directory: req.importPrefix.slice(0, -1),
      imports: [{ path: req.importPrefix + 'new.txt', bytes: new Uint8Array([65]) }],
    });
    const before = r.data.slice(buffer, buffer + 12),
      struct = r.data.slice(p, p + 88);
    assert.equal((await call()).result, 0);
    assert.equal(r.commonDialogError, 0x3003);
    assert.equal(r.view.getUint16(buffer, true), 'C:\\winebrowser\\_opened\\1\\new.txt\0'.length);
    assert.deepEqual(r.data.slice(buffer + 2, buffer + 12), before.slice(2));
    assert.deepEqual(r.data.slice(p, p + 88), struct);
    assert.equal(r.files.size, 3);
  }
});
test('missing files, invalid paths, hooks, malformed structs, import collisions and unconfirmed overwrite fail honestly', async () => {
  const { r, p, buffer, call } = setup(false, true, 260, OFN.OVERWRITEPROMPT | OFN.FILEMUSTEXIST);
  const before = r.data.slice(buffer, buffer + 260);
  for (const selected of [
    { names: ['test.txt'], directory: 'docs' },
    { names: ['missing.txt'], directory: 'docs' },
    { names: ['C:\\outside.txt'], directory: '' },
    {
      names: ['test.txt'],
      directory: 'docs',
      imports: [{ path: 'console.exe', bytes: new Uint8Array([0]) }],
    },
  ]) {
    r.request = async () => selected;
    assert.equal((await call()).result, 0);
    assert.equal(r.commonDialogError, 0x3002);
    assert.deepEqual(r.data.slice(buffer, buffer + 260), before);
    assert.equal(r.files.size, 3);
  }
  r.write32(p + 52, 0x20);
  r.request = async () => {
    throw Error('must not show picker');
  };
  assert.equal((await call()).result, 0);
  assert.equal(r.lastError, 120);
  assert.equal(r.commonDialogError, 2);
  r.write32(p, 80);
  assert.equal((await call()).result, 0);
  assert.equal(r.commonDialogError, 1);
});
test('browser imports remain input snapshots with collision isolation and native access after selection', async () => {
  const { r, buffer, call } = setup(false, false, 260, OFN.FILEMUSTEXIST | OFN.PATHMUSTEXIST);
  const bytes = new Uint8Array([65, 66]);
  r.request = async (_kind, req) => ({
    names: ['local.txt'],
    directory: req.importPrefix.slice(0, -1),
    imports: [{ path: req.importPrefix + 'local.txt', bytes }],
  });
  assert.equal((await call()).result, 1);
  assert.equal(r.string(buffer), 'C:\\winebrowser\\_opened\\1\\local.txt');
  assert.deepEqual(r.files.get('_opened/1/local.txt'), bytes);
  bytes[0] = 0;
  assert.equal(r.files.get('_opened/1/local.txt')[0], 65);
  assert.equal(r.dirty.has('_opened/1/local.txt'), false);
});
test('filter matching, default extension fallback, existing no-extension files and path validation', () => {
  assert.ok(matchesFileFilter('hello.TXT', '*.txt;*.log'));
  assert.ok(matchesFileFilter('README', '*.*'));
  assert.ok(!matchesFileFilter('file.exe', '*.txt'));
  const req = {
    files: [{ path: 'docs/plain' }, { path: 'docs/test.txt' }],
    directories: ['', 'docs'],
    flags: OFN.FILEMUSTEXIST | OFN.PATHMUSTEXIST,
    defaultExtension: 'txt',
    filters: [{ label: 'Text', pattern: '*.txt', index: 1 }],
  };
  assert.deepEqual(
    fileDialogSelection(req, { names: ['test'], directory: 'docs', filterIndex: 1 }).paths,
    ['docs/test.txt'],
  );
  assert.deepEqual(
    fileDialogSelection(req, { names: ['plain'], directory: 'docs', filterIndex: 1 }).paths,
    ['docs/plain'],
  );
  assert.ok(
    fileDialogSelection(req, { names: ['../missing.txt'], directory: 'docs', filterIndex: 1 })
      .error,
  );
});

test('A CP1252 and W Unicode output preserves caller casing, uses correct offsets, clips titles and keeps surrounding bytes', async () => {
  for (const wide of [false, true]) {
    const { r, p, buffer, title, call } = setup(wide, true);
    r.write32(p + 40, 4);
    r.data.fill(0xa5, title, title + 16);
    const name = wide ? 'Sample-Ω.log' : 'Sample-€.log';
    r.request = async () => ({ names: [name], directory: 'docs', filterIndex: 1, readonly: true });
    assert.equal((await call()).result, 1);
    const path = 'C:\\winebrowser\\docs\\' + name;
    assert.equal(wide ? r.wideString(buffer) : r.string(buffer), path);
    assert.equal(r.view.getUint16(p + 56, true), 20);
    assert.equal(r.view.getUint16(p + 58, true), 29);
    assert.equal(wide ? r.wideString(title) : r.string(title), 'Sam');
    assert.ok(r.data.slice(title + 4 * (wide ? 2 : 1), title + 16).every((v) => v === 0xa5));
    assert.ok(r.read32(p + 52) & OFN.READONLY);
  }
});
test('A output never substitutes unrepresentable Unicode; custom filter updates only on success', async () => {
  const { r, p, buffer, call } = setup(false, true);
  const custom = r.allocate(80);
  r.data.set(new TextEncoder().encode('Custom\0*.txt\0'), custom);
  r.write32(p + 16, custom);
  r.write32(p + 20, 80);
  r.write32(p + 12, r.allocString('Logs\0*.log\0\0'));
  const original = r.data.slice(custom, custom + 80);
  r.request = async () => ({ names: ['Ω.log'], directory: 'docs', filterIndex: 1 });
  assert.equal((await call()).result, 0);
  assert.equal(r.commonDialogError, 0x3002);
  assert.equal(r.lastError, 1113);
  assert.deepEqual(r.data.slice(custom, custom + 80), original);
  assert.equal(r.string(buffer), '');
  r.request = async () => ({ names: ['chosen.log'], directory: 'docs', filterIndex: 1 });
  assert.equal((await call()).result, 1);
  assert.equal(new TextDecoder().decode(r.data.slice(custom, custom + 13)), 'Custom\0*.log\0');
});

test('file imports avoid ancestor/leaf collisions and one-byte output buffers remain guarded', async () => {
  const { r, buffer, call } = setup(false, true, 1);
  r.files.set('_opened', new Uint8Array([7]));
  const before = r.data.slice(buffer, buffer + 8);
  r.request = async (_kind, req) => {
    assert.equal(req.importPrefix, '_opened-1/1/');
    return {
      names: ['local.txt'],
      directory: req.importPrefix.slice(0, -1),
      imports: [{ path: req.importPrefix + 'local.txt', bytes: new Uint8Array([1]) }],
    };
  };
  assert.equal((await call()).result, 0);
  assert.equal(r.commonDialogError, 0x3003);
  assert.deepEqual(r.data.slice(buffer, buffer + 8), before);
  assert.equal(r.files.size, 4);
});

test('Explorer multi-select keeps literal extensionless names; trailing separators cannot return a folder as a file', () => {
  const req = {
    files: [{ path: 'docs/plain' }, { path: 'docs/plain.txt' }],
    directories: ['', 'docs'],
    flags: OFN.ALLOWMULTISELECT | OFN.EXPLORER | OFN.FILEMUSTEXIST,
    defaultExtension: 'txt',
    filters: [{ pattern: '*.txt', index: 1 }],
  };
  assert.deepEqual(
    fileDialogSelection(req, { names: ['plain', 'plain.txt'], directory: 'docs', filterIndex: 1 })
      .paths,
    ['docs/plain', 'docs/plain.txt'],
  );
  assert.ok(
    fileDialogSelection(req, { names: ['plain.txt/'], directory: 'docs', filterIndex: 1 }).error,
  );
});
