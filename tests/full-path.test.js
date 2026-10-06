import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup(t) {
  const r = new Runtime(iced, {
    files: new Map([['app/client.exe', exe]]),
    exe: 'app/client.exe',
  });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const buffer = r.allocate(2048),
    part = r.allocate(4);
  const call = (name, { wide = false, capacity = 1024, out = buffer } = {}) => {
    const input = name === null ? 0 : r.allocString(name, wide);
    return r.apiProvider.get('kernel32.dll!GetFullPathName' + (wide ? 'W' : 'A'))(
      r,
      (i) => [input, capacity, out, part][i],
    );
  };
  return { r, buffer, part, call };
}

test('GetFullPathName uses the SDK four-argument ABI and guarded capacity contracts without requiring a file', (t) => {
  const { r, buffer, part, call } = setup(t);
  const expected = 'C:\\winebrowser\\app\\absent.bmp';
  for (const wide of [false, true])
    for (const capacity of [0, 1, expected.length, expected.length + 1]) {
      r.data.fill(0xcc, buffer, buffer + 2048);
      r.write32(part, 0x12345678);
      r.lastError = 77;
      const result = call('absent.bmp', { wide, capacity });
      assert.equal(result.argc, 4);
      assert.equal(r.lastError, 77);
      if (capacity <= expected.length) {
        assert.equal(result.result, expected.length + 1);
        assert.ok(r.data.subarray(buffer, buffer + 2048).every((v) => v === 0xcc));
        assert.equal(r.read32(part), wide ? 0 : 0x12345678);
      } else {
        assert.equal(result.result, expected.length);
        assert.equal(wide ? r.wideString(buffer) : r.string(buffer), expected);
        const offset = expected.lastIndexOf('\\') + 1;
        assert.equal(r.read32(part), buffer + offset * (wide ? 2 : 1));
        assert.equal(wide ? r.wideString(r.read32(part)) : r.string(r.read32(part)), 'absent.bmp');
        assert.ok(
          r.data
            .subarray(buffer + (expected.length + 1) * (wide ? 2 : 1), buffer + 2048)
            .every((v) => v === 0xcc),
        );
      }
    }
  assert.equal(call('absent.bmp', { out: 0 }).result, expected.length + 1);
  assert.equal(r.files.size, 1);
});

test('DOS path expansion resolves current-drive, rooted, other-drive and UNC names lexically', (t) => {
  const { r, buffer, part, call } = setup(t);
  const cases = [
    ['.\\sub/../missing.bmp', 'C:\\winebrowser\\app\\missing.bmp'],
    ['C:missing.bmp', 'C:\\winebrowser\\app\\missing.bmp'],
    ['\\missing.bmp', 'C:\\missing.bmp'],
    ['C:\\a\\..\\..\\missing.bmp', 'C:\\missing.bmp'],
    ['D:missing.bmp', 'D:\\missing.bmp'],
    ['D:\\missing.bmp', 'D:\\missing.bmp'],
    ['\\\\server\\share\\a\\..\\..\\missing.bmp', '\\\\server\\share\\missing.bmp'],
    ['\\\\server\\share', '\\\\server\\share'],
    ['sub\\', 'C:\\winebrowser\\app\\sub\\'],
    ['C:\\', 'C:\\'],
    ['missing.bmp.  ', 'C:\\winebrowser\\app\\missing.bmp'],
    ['NUL.txt', '\\\\.\\NUL'],
  ];
  for (const wide of [false, true])
    for (const [input, expected] of cases) {
      assert.equal(call(input, { wide }).result, expected.length, input);
      assert.equal(wide ? r.wideString(buffer) : r.string(buffer), expected, input);
      if (expected.endsWith('\\') || input === 'NUL.txt') assert.equal(r.read32(part), 0);
    }
  r.environment = { ansi: [], wide: ['=D:=D:\\saved'] };
  assert.equal(call('D:child.txt').result, 'D:\\saved\\child.txt'.length);
  assert.equal(r.string(buffer), 'D:\\saved\\child.txt');
});

test('Unicode UTF-16 lengths and in-place A/W expansion preserve actual file-part pointers', (t) => {
  const { r, buffer, part, call } = setup(t);
  for (const wide of [false, true]) {
    const input = '.\\caf\u00e9.bmp',
      expected = 'C:\\winebrowser\\app\\caf\u00e9.bmp';
    const pointer = r.allocString(input, wide);
    const result = r.apiProvider.get('kernel32.dll!GetFullPathName' + (wide ? 'W' : 'A'))(
      r,
      (i) => [pointer, 1024, buffer, part][i],
    );
    assert.equal(result.result, expected.length);
    assert.equal(wide ? r.wideString(buffer) : r.string(buffer), expected);
    assert.equal(wide ? r.wideString(r.read32(part)) : r.string(r.read32(part)), 'caf\u00e9.bmp');
    const bytes = r.data.slice(pointer, pointer + (input.length + 1) * (wide ? 2 : 1));
    r.data.set(bytes, buffer);
    assert.equal(
      r.apiProvider.get('kernel32.dll!GetFullPathName' + (wide ? 'W' : 'A'))(
        r,
        (i) => [buffer, 1024, buffer, part][i],
      ).result,
      expected.length,
    );
    assert.equal(wide ? r.wideString(buffer) : r.string(buffer), expected);
  }
  const unicode = 'C:\\winebrowser\\app\\\u03bb\ud83d\ude00.bmp';
  assert.equal(call('\u03bb\ud83d\ude00.bmp', { wide: true }).result, unicode.length);
  assert.equal(r.wideString(buffer), unicode);
  assert.equal(r.wideString(r.read32(part)), '\u03bb\ud83d\ude00.bmp');
});

test('invalid output regions do not partially write and ANSI MAX_PATH differs from Unicode', (t) => {
  const { r, buffer, part, call } = setup(t);
  for (const wide of [false, true]) {
    r.data.fill(0xcc, buffer, buffer + 2048);
    const result = call('absent.bmp', { wide, out: 0xfffffff0 });
    assert.equal(result.argc, 4);
    assert.equal(result.result, 0);
    assert.equal(r.lastError, 998);
    assert.ok(r.data.subarray(buffer, buffer + 2048).every((v) => v === 0xcc));
    r.write32(part, 0x12345678);
    assert.equal(call('', { wide }).result, 0);
    assert.equal(r.read32(part), 0x12345678);
    assert.equal(call(null, { wide }).result, 0);
    assert.equal(r.read32(part), 0x12345678);
    assert.equal(call('   ', { wide }).result, 0);
    assert.equal(r.read32(part), wide ? 0 : 0x12345678);
  }
  assert.equal(call('a'.repeat(270)).result, 0);
  assert.equal(r.lastError, 206);
  assert.ok(call('a'.repeat(270), { wide: true }).result > 260);
});
