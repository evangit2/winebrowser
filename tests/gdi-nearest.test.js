import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const load = async (name) =>
  JSON.parse(await readFile(`tests/fixtures/gdi-nearest/${name}-wine-oracle.json`, 'utf8'));
const geometry = JSON.parse(await readFile('tests/fixtures/gdi-nearest/wine-oracle.json', 'utf8'));
function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) => r.apiProvider.get('gdi32.dll!' + name)(r, (i) => args[i] >>> 0),
    call = (name, ...args) => api(name, ...args).result;
  const info = r.allocate(1064),
    bits = r.allocate(4096),
    out = r.allocate(4),
    dc = call('CreateCompatibleDC', 0);
  const header = (w, h) => {
    r.data.fill(0, info, info + 1064);
    r.write32(info, 40);
    r.write32(info + 4, w);
    r.write32(info + 8, h);
    r.view.setUint16(info + 12, 1, true);
    r.view.setUint16(info + 14, 32, true);
  };
  header(16, -16);
  const handle = call('CreateDIBSection', dc, info, 0, out, 0, 0),
    dst = r.read32(out);
  assert.ok(handle);
  call('SelectObject', dc, handle);
  return { r, api, call, dc, info, out, header };
}

test('GetNearestColor reproduces native display, stock mono, RGB/bitfield and indexed bitmap colors including palette flags', (t) => {
  const { r, api, call, info, header } = setup(t),
    display = r.apiProvider.get('user32.dll!GetDC')(r, () => 0).result;
  const dcs = [display, call('CreateCompatibleDC', 0)];
  for (let type = 2; type < 8; type++) {
    header(1, -1);
    const depth = [0, 0, 16, 16, 24, 32, 8, 1][type];
    r.view.setUint16(info + 14, depth, true);
    if (type === 3) {
      r.write32(info + 16, 3);
      [0xf800, 0x07e0, 0x001f].forEach((v, i) => r.write32(info + 40 + i * 4, v));
    }
    if (type === 6) {
      r.write32(info + 32, 4);
      [0, 0xff0000, 0x00ff00, 0xffffff].forEach((v, i) => r.write32(info + 40 + i * 4, v));
    }
    if (type === 7) {
      r.write32(info + 40, 0);
      r.write32(info + 44, 0xffffff);
    }
    const dc = call('CreateCompatibleDC', 0),
      out = r.allocate(4),
      handle = call('CreateDIBSection', dc, info, 0, out, 0, 0);
    assert.ok(handle);
    call('SelectObject', dc, handle);
    dcs.push(dc);
  }
  const pal = r.allocate(16);
  r.view.setUint16(pal, 0x300, true);
  r.view.setUint16(pal + 2, 3, true);
  r.data.set([17, 29, 41, 0, 181, 47, 39, 0, 54, 210, 19, 0], pal + 4);
  const custom = call('CreatePalette', pal);
  assert.ok(custom);
  let last = -1;
  for (const c of geometry.cases) {
    if (c.surface !== last) {
      last = c.surface;
      call('SelectPalette', dcs[c.surface], call('GetStockObject', 15), 0);
    }
    if (c.palette) call('SelectPalette', dcs[c.surface], custom, 0);

    r.lastError = 777;
    assert.deepEqual(
      api('GetNearestColor', dcs[c.surface], c.input),
      { result: c.result, argc: 2 },
      `${c.surface}/${c.input.toString(16)}`,
    );
    assert.equal(r.lastError, c.error);
  }
  assert.deepEqual(api('GetNearestColor', 0xdead, 0), { result: 0xffffffff, argc: 2 });
  assert.equal(r.lastError, 6);
});
test('unchanged native SDK client calls nearest-color imports through actual Wine base DLLs and x86-to-Wasm execution', async () => {
  const exe = new Uint8Array(await readFile('tests/fixtures/gdi-nearest/gdi-nearest.exe')),
    manifest = JSON.parse(await readFile('runtime/wine-base/manifest.json', 'utf8')),
    builtinFiles = new Map(),
    nlsFiles = new Map(),
    events = [];
  for (const row of manifest.dlls)
    builtinFiles.set(
      row.name,
      new Uint8Array(await readFile('public/runtime/wine-base/' + row.path)),
    );
  for (const row of manifest.nls)
    nlsFiles.set(row.name, new Uint8Array(await readFile('public/runtime/wine-base/' + row.path)));
  const r = new Runtime(iced, {
      files: new Map([['gdi-nearest.exe', exe]]),
      exe: 'gdi-nearest.exe',
      builtinFiles,
      nlsFiles,
      emit: (event) => events.push(event),
    }),
    result = await r.run();
  assert.equal(result.exitCode, 0);
  assert.ok(result.totalCompiledBlocks > 0);
  assert.ok(result.apiNames.includes('gdi32.dll!GetNearestColor'));
  assert.equal(
    events
      .filter((e) => e.type === 'stdout')
      .map((e) => e.text)
      .join(''),
    'NATIVE NEAREST COLOR PASS\n',
  );
  for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
    assert.ok(result.modules.some((m) => m.name === name && !m.host));
});
