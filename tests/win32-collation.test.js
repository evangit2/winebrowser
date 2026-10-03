import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const setup = () =>
  new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });

for (const wide of [false, true]) {
  const name = `kernel32.dll!CompareString${wide ? 'W' : 'A'}`;
  test(`${name} reads the Win32 locale/flags/string/count argument order`, () => {
    const r = setup();
    const call = (...args) => r.apiProvider.get(name)(r, (i) => args[i]);
    const left = r.allocString('Ab-tail', wide);
    const right = r.allocString('aB-other', wide);
    // The old static MSVC CRT probes CompareStringW with locale 0 and one
    // character before choosing its collation path (as in Humus RollerCoaster).
    assert.deepEqual(call(0, 0, left, 1, left, 1), { result: 2, argc: 6 });
    // A real LCID must not become flags; explicit counts exclude the suffixes.
    assert.equal(call(0x409, 1, left, 2, right, 2).result, 2);
    assert.equal(call(0x409, 0, left, 2, right, 2).result, 1);
    assert.equal(call(0x409, 0, right, 2, left, 2).result, 3);
    assert.equal(call(0x409, 1, left, -1, right, -1).result, 3);
    assert.equal(call(0x409, 0x80000000, left, 2, right, 2).result, 0);
    assert.equal(r.lastError, 87);
  });
}

test('counted ANSI and Unicode collation reads enforce guest memory bounds', () => {
  const r = setup();
  const text = r.allocString('x', true);
  for (const suffix of ['A', 'W']) {
    const api = r.apiProvider.get(`kernel32.dll!CompareString${suffix}`);
    const args = [0, 0, 1, 1, text, 1];
    assert.throws(() => api(r, (i) => args[i]), /Guest read violation/);
  }
});
