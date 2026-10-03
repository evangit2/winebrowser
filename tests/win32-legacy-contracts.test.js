import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { windowApis } from '../src/win32-windows.js';
import { audioApis } from '../src/win32-audio.js';
const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
const fixture = () =>
  new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
const call = (r, name, ...args) => (windowApis[name] ?? audioApis[name])(r, (i) => args[i] ?? 0);

test('class A/W queries preserve registered fields and names and refuse removal with live windows', () => {
  for (const wide of [false, true]) {
    const r = fixture(),
      suffix = wide ? 'W' : 'A',
      p = r.allocate(40, true),
      name = r.allocString('LegacyContract', wide),
      menu = r.allocString('MenuName', wide);
    [1, 0x401000, 8, 12, 0x400000, 123, 456, 789, menu, name].forEach((v, i) =>
      r.write32(p + i * 4, v),
    );
    const atom = call(r, `user32.dll!RegisterClass${suffix}`, p).result;
    assert.ok(atom);
    const out = r.allocate(44, true);
    r.write32(out + 40, 0xabcdef01);
    assert.equal(call(r, `user32.dll!GetClassInfo${suffix}`, 0x400000, atom, out).result, 1);
    assert.deepEqual(
      Array.from({ length: 8 }, (_, i) => r.read32(out + i * 4)),
      [1, 0x401000, 8, 12, 0x400000, 123, 456, 789],
    );
    assert.equal((wide ? r.wideString.bind(r) : r.string.bind(r))(r.read32(out + 32)), 'MenuName');
    assert.equal(
      (wide ? r.wideString.bind(r) : r.string.bind(r))(r.read32(out + 36)),
      'LegacyContract',
    );
    assert.equal(r.read32(out + 40), 0xabcdef01);
    assert.equal(call(r, `user32.dll!GetClassInfo${suffix}`, 0, atom, out).result, 0);
    assert.equal(r.lastError, 1411);
    const cls = r.windows.atoms.get(atom);
    r.windows.windows.set(123, { cls });
    assert.equal(call(r, `user32.dll!UnregisterClass${suffix}`, atom, 0x400000).result, 0);
    assert.equal(r.lastError, 1412);
    r.windows.windows.clear();
    assert.equal(call(r, `user32.dll!UnregisterClass${suffix}`, atom, 0x400000).result, 1);
    assert.equal(r.windows.atoms.has(atom), false);
    assert.equal(r.windows.classes.has(cls.name), false);
  }
});

test('WinMM reports absent joysticks and validates JOYINFOEX without fabricating input', () => {
  const r = fixture(),
    p = r.allocate(56, true);
  r.write32(p, 52);
  r.data.fill(0xaa, p + 4, p + 56);
  assert.equal(call(r, 'winmm.dll!joyGetNumDevs').result, 0);
  assert.equal(call(r, 'winmm.dll!joyGetDevCapsA', 0, p, 52).result, 2);
  assert.equal(call(r, 'winmm.dll!joyGetPosEx', 0, p).result, 167);
  assert.ok(r.data.slice(p + 4, p + 56).every((v) => v === 0xaa));
  r.write32(p, 48);
  assert.equal(call(r, 'winmm.dll!joyGetPosEx', 0, p).result, 165);
  assert.equal(call(r, 'winmm.dll!joyGetPosEx', 0, 0).result, 165);
});
