import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { resolveGuestPath } from '../src/guest-paths.js';
import { encodeAnsi, decodeAnsi } from '../src/encoding.js';
const bytes = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', bytes]]), exe: 'console.exe' });
  t.after(() => r.windows.dispose());
  const call = (name, ...a) => r.apiProvider.get(name)(r, (i) => a[i] ?? 0);
  const str = (s, w = false) => (s === null ? 0 : r.allocString(s, w));
  return { r, call, str };
}
test('profile ANSI values, case-insensitive updates and deletions share real guest file storage', (t) => {
  const { r, call, str } = setup(t),
    file = str('C:\\winebrowser\\settings.ini');
  r.files.set(
    'settings.ini',
    encodeAnsi(
      '; keep comment\r\n[ Options ]\r\nName = "café"\r\nNumber=0x2a\r\nEmpty=\r\nBareLine\r\n[Other]\r\nFlag=on\r\n',
    ).bytes,
  );
  const out = r.allocate(80);
  r.data.fill(0xa5, out, out + 80);
  const get = (section, key, def = '', n = 80) =>
    call('kernel32.dll!GetPrivateProfileStringA', str(section), str(key), str(def), out, n, file)
      .result;
  assert.equal(get('options', 'NAME'), 4);
  assert.equal(r.string(out), 'café');
  assert.equal(r.data[out + 5], 0xa5);
  assert.equal(get('options', 'missing', '  fallback  '), 10);
  assert.equal(r.string(out), '  fallback');
  assert.equal(get('options', 'Name', '', 3), 2);
  assert.equal(r.string(out), 'ca');
  assert.equal(
    call('kernel32.dll!GetPrivateProfileIntA', str('Options'), str('Number'), 9, file).result,
    42,
  );
  assert.equal(
    call('kernel32.dll!GetPrivateProfileIntA', str('Options'), str('Empty'), 9, file).result,
    9,
  );
  assert.equal(
    call('kernel32.dll!WritePrivateProfileStringA', str('OPTIONS'), str('NAME'), str('new'), file)
      .result,
    1,
  );
  assert.equal(get('Options', 'Name'), 3);
  assert.equal(r.string(out), 'new');
  assert.ok(decodeAnsi(r.files.get('settings.ini')).includes('; keep comment'));
  assert.ok(r.dirty.has('settings.ini'));
  const h = call('kernel32.dll!CreateFileA', file, 0x80000000, 7, 0, 3, 0, 0).result,
    read = r.allocate(256),
    done = r.allocate(4);
  assert.notEqual(h, 0xffffffff);
  assert.equal(call('kernel32.dll!ReadFile', h, read, 256, done, 0).result, 1);
  assert.match(decodeAnsi(r.data.slice(read, read + r.read32(done))), /Name=new/);
  call('kernel32.dll!CloseHandle', h);
  assert.equal(
    call('kernel32.dll!WritePrivateProfileStringA', str('Options'), str('Name'), 0, file).result,
    1,
  );
  assert.equal(get('Options', 'Name', 'default'), 7);
  assert.equal(call('kernel32.dll!WritePrivateProfileStringA', str('Other'), 0, 0, file).result, 1);
  assert.equal(get('Other', 'Flag', 'missing'), 7);
  assert.equal(call('kernel32.dll!WritePrivateProfileStringA', 0, 0, 0, file).result, 0);
});
test('profile MULTI_SZ section/key lists have native counts, double termination and intact output guards', (t) => {
  const { r, call, str } = setup(t),
    file = str('./config.ini');
  r.files.set(
    'config.ini',
    encodeAnsi('[Main]\r\na=1\r\nb=2\r\n;comment\r\nBare\r\n[Next]\r\nx=3\r\n').bytes,
  );
  const out = r.allocate(64);
  r.data.fill(0xa5, out, out + 64);
  const get = (section, key, n) =>
    call('kernel32.dll!GetPrivateProfileStringA', str(section), str(key), 0, out, n, file).result;
  assert.equal(get(null, null, 64), 10);
  assert.deepEqual(
    [...r.data.slice(out, out + 11)],
    [77, 97, 105, 110, 0, 78, 101, 120, 116, 0, 0],
  );
  assert.equal(r.data[out + 11], 0xa5);
  r.data.fill(0xa5, out, out + 64);
  assert.equal(get('Main', null, 5), 4);
  assert.deepEqual([...r.data.slice(out, out + 5)], [97, 0, 98, 0, 0]);
  assert.equal(r.data[out + 5], 0xa5);
  r.data.fill(0xa5, out, out + 64);
  assert.equal(get(null, null, 6), 4);
  assert.deepEqual([...r.data.slice(out, out + 6)], [77, 97, 105, 110, 0, 0]);
  assert.equal(r.data[out + 6], 0xa5);
  assert.equal(get(null, null, 1), 0);
  assert.equal(r.data[out], 0);
  assert.equal(
    call('kernel32.dll!GetPrivateProfileSectionA', str('Main'), out, 64, file).result,
    13,
  );
  assert.equal(r.string(out), 'a=1');
});
test('profile UTF16 LE/BE and UTF8 BOM files keep their encoding when changed through ANSI and Unicode APIs', (t) => {
  const { r, call, str } = setup(t),
    out = r.allocate(160);
  for (const encoding of ['utf-16le', 'utf-16be', 'utf-8']) {
    const value = '[文]\r\nKey=Ω €\r\n',
      path = `${encoding}.ini`,
      file = str('./' + path, true);
    let data;
    if (encoding === 'utf-8') {
      const body = new TextEncoder().encode(value);
      data = new Uint8Array(body.length + 3);
      data.set([0xef, 0xbb, 0xbf]);
      data.set(body, 3);
    } else {
      data = new Uint8Array(2 + value.length * 2);
      const v = new DataView(data.buffer),
        le = encoding === 'utf-16le';
      v.setUint16(0, 0xfeff, le);
      for (let i = 0; i < value.length; i++) v.setUint16(2 + i * 2, value.charCodeAt(i), le);
    }
    r.files.set(path, data);
    assert.equal(
      call(
        'kernel32.dll!GetPrivateProfileStringW',
        str('文', true),
        str('key', true),
        0,
        out,
        80,
        file,
      ).result,
      3,
    );
    assert.equal(r.wideString(out), 'Ω €');
    assert.equal(
      call(
        'kernel32.dll!WritePrivateProfileStringW',
        str('文', true),
        str('Key', true),
        str('Ω changed', true),
        file,
      ).result,
      1,
    );
    assert.deepEqual(
      [...r.files.get(path).subarray(0, encoding === 'utf-8' ? 3 : 2)],
      [...data.subarray(0, encoding === 'utf-8' ? 3 : 2)],
    );
    assert.equal(
      call(
        'kernel32.dll!GetPrivateProfileStringW',
        str('文', true),
        str('key', true),
        0,
        out,
        80,
        file,
      ).result,
      9,
    );
    assert.equal(r.wideString(out), 'Ω changed');
  }
});
test('profile filenames and system file APIs resolve one isolated Windows namespace, with sharing and parent failures', async (t) => {
  const { r, call, str } = setup(t),
    out = r.allocate(40);
  assert.equal(resolveGuestPath('C:\\Windows\\System32\\..\\app.ini'), 'windows/app.ini');
  assert.throws(() => resolveGuestPath('C:\\Windows\\..\\outside.ini'));
  assert.equal(
    call(
      'kernel32.dll!WritePrivateProfileStringA',
      str('App'),
      str('Name'),
      str('value'),
      str('settings.ini'),
    ).result,
    1,
  );
  assert.ok(r.files.has('windows/settings.ini'));
  const file = str('C:\\Windows\\settings.ini');
  assert.equal(
    call('kernel32.dll!GetPrivateProfileStringA', str('App'), str('Name'), 0, out, 40, file).result,
    5,
  );
  assert.equal((await call('kernel32.dll!SetCurrentDirectoryA', str('C:\\Windows'))).result, 1);
  assert.equal(call('kernel32.dll!GetCurrentDirectoryA', 40, out).result, 10);
  assert.equal(r.string(out), 'C:\\Windows');
  assert.equal(
    (await call('kernel32.dll!SetCurrentDirectoryA', str('C:\\winebrowser\\'))).result,
    1,
  );
  const h = call('kernel32.dll!CreateFileA', file, 0x80000000, 1, 0, 3, 0, 0).result;
  assert.equal(
    call('kernel32.dll!WritePrivateProfileStringA', str('App'), str('Name'), str('blocked'), file)
      .result,
    0,
  );
  assert.equal(r.lastError, 32);
  call('kernel32.dll!CloseHandle', h);
  assert.equal(
    call(
      'kernel32.dll!WritePrivateProfileStringA',
      str('App'),
      str('Name'),
      str('x'),
      str('./absent/f.ini'),
    ).result,
    0,
  );
  assert.equal(r.lastError, 3);
  assert.equal(
    call('kernel32.dll!WriteProfileStringA', str('App'), str('Name'), str('default')).result,
    1,
  );
  assert.ok(r.files.has('windows/win.ini'));
  assert.equal(
    call('kernel32.dll!GetProfileStringA', str('App'), str('Name'), 0, out, 40).result,
    7,
  );
  assert.equal(r.string(out), 'default');
});
