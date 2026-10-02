import test from 'node:test';
import assert from 'node:assert/strict';
import { fileSpecEnd, pathApis } from '../src/win32-paths.js';
import { dpiApis } from '../src/win32-dpi.js';

test('PathRemoveFileSpec preserves DOS roots and edits only the terminator', () => {
  for (const [path, expected] of [
    ['', ''],
    ['file.exe', ''],
    ['C:', 'C:'],
    ['C:\\', 'C:\\'],
    ['C:\\file.exe', 'C:\\'],
    ['C:relative.exe', 'C:'],
    ['C:\\dir\\file.exe', 'C:\\dir'],
    ['C:\\dir\\', 'C:\\dir'],
    ['\\file.exe', '\\'],
    ['\\\\server\\share\\file.exe', '\\\\server\\share'],
    ['\\\\?\\C:\\dir\\file.exe', '\\\\?\\C:\\dir'],
  ]) {
    const end = fileSpecEnd(path);
    assert.equal(end === null ? path : path.slice(0, end), expected, path);
  }
  const data = new Uint8Array(256).fill(0xcc),
    view = new DataView(data.buffer);
  const path = 'C:\\winebrowser\\日本語.exe',
    pointer = 16;
  for (let i = 0; i <= path.length; i++)
    view.setUint16(pointer + i * 2, path.charCodeAt(i) || 0, true);
  const original = data.slice();
  const runtime = {
    data,
    view,
    wideString: () => path,
    check: (p, n) => {
      assert.ok(p >= pointer && p + n <= pointer + (path.length + 1) * 2);
    },
  };
  assert.deepEqual(
    pathApis['shlwapi.dll!PathRemoveFileSpecW'](runtime, () => pointer),
    { result: 1, argc: 1 },
  );
  const end = pointer + 'C:\\winebrowser'.length * 2;
  original[end] = original[end + 1] = 0;
  assert.deepEqual(data, original);
});

test('DPI awareness contexts save and restore independently for each guest thread', () => {
  const first = {},
    second = {},
    r = { threads: { current: first } };
  const set = (v) => dpiApis['user32.dll!SetThreadDpiAwarenessContext'](r, () => v);
  const get = () => dpiApis['user32.dll!GetThreadDpiAwarenessContext'](r).result;
  assert.deepEqual(set(0xfffffffc), { result: 0xffffffff, argc: 1 });
  assert.equal(get(), 0xfffffffc);
  assert.equal(set(123).result, 0);
  assert.equal(r.lastError, 87);
  assert.equal(get(), 0xfffffffc);
  r.threads.current = second;
  assert.equal(get(), 0xffffffff);
  set(0xfffffffe);
  r.threads.current = first;
  assert.equal(get(), 0xfffffffc);
  assert.equal(set(0xffffffff).result, 0xfffffffc);
});
