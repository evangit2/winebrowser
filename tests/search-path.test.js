import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));

test('unchanged native SDK file-search client executes its stdcall ABI through the host provider', async () => {
  const client = new Uint8Array(await readFile('tests/fixtures/load-images/load-images-host.exe'));
  const bmp = new Uint8Array(await readFile('tests/fixtures/load-images/rgb24.bmp'));
  const r = new Runtime(iced, {
    files: new Map([
      ['app/client.exe', client],
      ['app/rgb24.bmp', bmp],
    ]),
    exe: 'app/client.exe',
    args: ['--search-path-only'],
  });
  const result = await r.run();
  assert.equal(result.exitCode, 0);
  assert.ok(result.compiledBlocks > 0);
  for (const name of [
    'SearchPathA',
    'SearchPathW',
    'SetSearchPathMode',
    'SetCurrentDirectoryA',
    'GetFullPathNameA',
    'GetFullPathNameW',
  ])
    assert.ok(result.apiNames.includes('kernel32.dll!' + name), name);
  assert.equal(r.virtualDirectories.has('app/search-a/'), false);
  assert.equal(r.virtualDirectories.has('app/search-b/'), false);
});
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['app/client.exe', exe]]), exe: 'app/client.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const call = (name, ...args) =>
    r.apiProvider.get('kernel32.dll!' + name)(r, (i) => args[i] >>> 0);
  const buffer = r.allocate(2048),
    part = r.allocate(4);
  const search = (
    name,
    { path = null, extension = null, wide = false, capacity = 1024, out = buffer } = {},
  ) =>
    call(
      'SearchPath' + (wide ? 'W' : 'A'),
      path === null ? 0 : r.allocString(path, wide),
      name === null ? 0 : r.allocString(name, wide),
      extension === null ? 0 : r.allocString(extension, wide),
      capacity,
      out,
      part,
    );
  const file = (path) => r.files.set(path, new Uint8Array([7]));
  return { r, call, buffer, part, search, file };
}

test('SearchPath SDK buffer indices, lengths, file-part pointers and untouched guards for A/W', (t) => {
  const { r, buffer, part, search, file } = setup(t);
  file('app/pixel.bmp');
  const expected = 'C:\\winebrowser\\app\\pixel.bmp';
  for (const wide of [false, true]) {
    const stride = wide ? 2 : 1;
    for (const capacity of [0, 1, expected.length, expected.length + 1]) {
      r.data.fill(0xcc, buffer, buffer + 2048);
      r.write32(part, 0x12345678);
      const result = search('pixel', { extension: '.bmp', wide, capacity });
      assert.equal(result.argc, 6);
      if (capacity <= expected.length) {
        assert.equal(result.result, expected.length + 1);
        assert.ok(r.data.subarray(buffer, buffer + 2048).every((byte) => byte === 0xcc));
        assert.equal(r.read32(part) >>> 0, wide ? 0 : 0x12345678);
      } else {
        assert.equal(result.result, expected.length);
        assert.equal(wide ? r.wideString(buffer) : r.string(buffer), expected);
        assert.equal(r.read32(part), buffer + (expected.length - 9) * stride);
        assert.equal(wide ? r.wideString(r.read32(part)) : r.string(r.read32(part)), 'pixel.bmp');
        assert.ok(
          r.data
            .subarray(buffer + (expected.length + 1) * stride, buffer + 2048)
            .every((byte) => byte === 0xcc),
        );
      }
    }
    assert.equal(search('pixel.bmp', { wide, out: 0 }).result, expected.length + 1);
  }
});

test('explicit lists keep their order and do not fall back to the application or current directory', (t) => {
  const { r, buffer, search, file } = setup(t);
  for (const path of ['app/choice.bin', 'first/choice.bin', 'second/choice.bin']) file(path);
  r.cwd = '';
  assert.ok(search('choice', { path: 'D:\\missing;second;first', extension: '.bin' }).result);
  assert.equal(r.string(buffer), 'C:\\winebrowser\\second\\choice.bin');
  assert.ok(search('choice.bin', { path: 'first;second' }).result);
  assert.equal(r.string(buffer), 'C:\\winebrowser\\first\\choice.bin');
  assert.equal(search('choice.bin', { path: 'missing' }).result, 0);
  assert.equal(r.lastError, 2);
  file('choice.bin');
  assert.ok(search('choice.bin', { path: ';first' }).result);
  assert.equal(r.string(buffer), 'C:\\winebrowser\\choice.bin');
  assert.equal(search('choice.bin', { path: 'missing;' }).result, 0);
});

test('qualified paths bypass lists; relative subpaths still participate in them', (t) => {
  const { r, buffer, search, file } = setup(t);
  file('app/local.bmp');
  file('first/assets/pixel.bmp');
  file('app/dotted.dir/plain.bmp');
  assert.ok(search('./local', { path: 'missing', extension: '.bmp' }).result);
  assert.equal(r.string(buffer), 'C:\\winebrowser\\app\\local.bmp');
  assert.ok(search('C:\\winebrowser\\app\\local.bmp', { path: 'missing' }).result);
  assert.ok(search('assets/pixel', { path: 'C:\\winebrowser\\first', extension: '.bmp' }).result);
  assert.equal(r.string(buffer), 'C:\\winebrowser\\first\\assets\\pixel.bmp');
  assert.ok(search('./dotted.dir/plain', { path: 'missing', extension: '.bmp' }).result);
  assert.equal(search('dotted.dir/plain', { path: '.', extension: '.bmp' }).result, 0);
  assert.ok(search('dotted.dir/plain', { extension: '.bmp' }).result);
  assert.equal(search('C:\\outside\\local.bmp').result, 0);
});

test('extensions only append where eligible, and qualified names try their original spelling first', (t) => {
  const { r, buffer, search, file } = setup(t);
  file('app/plain');
  file('app/plain.bmp');
  file('app/already.bmp.extra');
  assert.ok(search('plain', { extension: '.bmp' }).result);
  assert.equal(r.string(buffer), 'C:\\winebrowser\\app\\plain.bmp');
  assert.ok(search('./plain', { extension: '.bmp' }).result);
  assert.equal(r.string(buffer), 'C:\\winebrowser\\app\\plain');
  assert.equal(search('already.bmp', { extension: '.extra' }).result, 0);
  assert.ok(search('already.bmp.extra', { extension: '.ignored' }).result);
});

test('default search retains application priority after cwd changes and safe mode moves cwd after system directories', (t) => {
  const { r, call, buffer, search, file } = setup(t);
  r.cwd = 'work/';
  const paths = [
    'app/choice.bin',
    'work/choice.bin',
    'windows/system32/choice.bin',
    'windows/system/choice.bin',
    'windows/choice.bin',
    'path/choice.bin',
  ];
  for (const path of paths) file(path);
  call('SetEnvironmentVariableA', r.allocString('PATH'), r.allocString('C:\\winebrowser\\path'));
  assert.ok(search('choice.bin').result);
  assert.equal(r.string(buffer), 'C:\\winebrowser\\app\\choice.bin');
  r.files.delete(paths[0]);
  assert.ok(search('choice.bin').result);
  assert.equal(r.string(buffer), 'C:\\winebrowser\\work\\choice.bin');
  assert.equal(call('SetSearchPathMode', 1).result, 1);
  for (const [index, expected] of [
    'C:\\Windows\\system32\\choice.bin',
    'C:\\Windows\\system\\choice.bin',
    'C:\\Windows\\choice.bin',
    'C:\\winebrowser\\work\\choice.bin',
    'C:\\winebrowser\\path\\choice.bin',
  ].entries()) {
    assert.ok(search('choice.bin', { wide: true }).result);
    assert.equal(r.wideString(buffer), expected);
    r.files.delete(index < 3 ? paths[index + 2] : index === 3 ? paths[1] : paths[5]);
  }
  assert.equal(search('choice.bin').result, 0);
});

test('safe-search flags validate and permanent enablement cannot be reversed', (t) => {
  const { r, call } = setup(t);
  for (const flags of [0, 0x80, 0x8000, 0x10001, 0x18000, 0xffffffff]) {
    assert.equal(call('SetSearchPathMode', flags).result, 0);
    assert.equal(r.lastError, 87);
  }
  assert.equal(call('SetSearchPathMode', 1).result, 1);
  assert.equal(call('SetSearchPathMode', 0x10000).result, 1);
  assert.equal(r.searchPathSafeMode, false);
  assert.equal(call('SetSearchPathMode', 0x8001).result, 1);
  for (const flags of [1, 0x10000]) {
    assert.equal(call('SetSearchPathMode', flags).result, 0);
    assert.equal(r.lastError, 5);
  }
  assert.equal(call('SetSearchPathMode', 0x8001).result, 1);
});

test('PATH changes and deletion share one environment across A/W callers', (t) => {
  const { r, call, buffer, search, file } = setup(t);
  file('path/café.bmp');
  assert.equal(
    call('SetEnvironmentVariableA', r.allocString('Path'), r.allocString('C:\\winebrowser\\path'))
      .result,
    1,
  );
  assert.ok(search('café.bmp', { wide: true }).result);
  assert.equal(r.wideString(buffer), 'C:\\winebrowser\\path\\café.bmp');
  assert.ok(search('café.bmp').result);
  assert.equal(r.string(buffer), 'C:\\winebrowser\\path\\café.bmp');
  assert.equal(call('SetEnvironmentVariableW', r.allocString('PATH', true), 0).result, 1);
  assert.equal(call('GetEnvironmentVariableA', r.allocString('PATH'), buffer, 1024).result, 0);
  assert.equal(search('café.bmp').result, 0);
});

test('invalid and missing names preserve output while W handles Unicode and long paths', (t) => {
  const { r, buffer, part, search, file } = setup(t);
  for (const [name, error] of [
    [null, 87],
    ['', 87],
    ['   ', 87],
    ['\t', 2],
    ['missing.bmp', 2],
  ]) {
    r.data.fill(0xcc, buffer, buffer + 2048);
    r.write32(part, 0x12345678);
    assert.equal(search(name, { wide: true }).result, 0);
    assert.equal(r.lastError, error);
    assert.equal(r.read32(part), 0x12345678);
    assert.ok(r.data.subarray(buffer, buffer + 2048).every((byte) => byte === 0xcc));
  }
  const name = '🚀.bmp';
  file('app/' + name);
  assert.equal(search(name, { wide: true }).result, 'C:\\winebrowser\\app\\'.length + name.length);
  assert.equal(r.wideString(r.read32(part)), name);
  const long = 'deep/'.repeat(60) + 'pixel.bmp';
  file('app/' + long);
  assert.ok(search(long, { wide: true }).result > 260);
  assert.equal(search(long).result, 0);
  assert.equal(r.lastError, 206);
});
