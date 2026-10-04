import test from 'node:test';
import assert from 'node:assert/strict';
import { textUnicodeApis } from '../src/win32-text-unicode.js';
import { API_NAMES } from '../src/win32.js';
test('Wine Unicode heuristic respects requested flags, byte order, signed lengths and guarded outputs', () => {
  const data = new Uint8Array(2048),
    view = new DataView(data.buffer),
    r = {
      data,
      view,
      check(p, n) {
        assert.ok(p >= 16 && p + n <= data.length);
      },
      read32(p) {
        return view.getUint32(p, true);
      },
      write32(p, v) {
        view.setUint32(p, v, true);
      },
    };
  const check = (bytes, mask, expected, flags) => {
    data.fill(0xa5);
    data.set(bytes, 32);
    r.write32(16, mask);
    for (const name of ['advapi32.dll!IsTextUnicode', 'ntdll.dll!RtlIsTextUnicode']) {
      r.write32(16, mask);
      assert.deepEqual(
        textUnicodeApis[name](r, (i) => [32, bytes.length, 16][i]),
        { result: expected, argc: 3 },
      );
      assert.equal(r.read32(16), flags);
      assert.equal(data[20], 0xa5);
    }
  };
  check([255, 254, 65, 0, 66, 0], 0xffffffff, 1, 0x1008);
  check([254, 255, 0, 65, 0, 66], 0xffffffff, 0, 0x1080);
  check([65, 0, 66, 0, 10, 0, 0, 0], 0xffffffff, 1, 0x1006);
  check([65, 66, 67, 68, 69, 70], 0xffffffff, 0, 0);
  check([65, 0, 66], 0xffffffff, 0, 0x1202);
  check([65, 0, 66], 2, 1, 2);
  check([255, 254], 8, 1, 8);
  check([255, 254], 0, 0, 0);
  check([65], 0xffffffff, 0, 0);
  check([], 0xffffffff, 0, 0);
  assert.equal(
    textUnicodeApis['advapi32.dll!IsTextUnicode'](r, (i) => [0, 0xffffffff, 16][i]).result,
    0,
  );
  data.set([255, 254], 32);
  assert.equal(textUnicodeApis['advapi32.dll!IsTextUnicode'](r, (i) => [32, 2, 0][i]).result, 1);
  const long = new Uint8Array(600).fill(65);
  long.set([255, 254]);
  long[514] = 0;
  check(long, 0xffffffff, 1, 8); // Only the first 256 WCHARs are inspected.
  assert.ok(API_NAMES['advapi32.dll'].includes('IsTextUnicode'));
});
