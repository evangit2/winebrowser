import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { DEFAULT_ENVIRONMENT } from '../src/guest-environment.js';

const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const native = JSON.parse(
  await readFile('tests/fixtures/gdi-pixel-colors/wine-oracle.json', 'utf8'),
);

function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = (name, ...args) => r.apiProvider.get('gdi32.dll!' + name)(r, (i) => args[i] >>> 0);
  const call = (name, ...args) => api(name, ...args).result;
  const info = r.allocate(1064),
    out = r.allocate(4);
  const create = (type, width = 1, height = -1) => {
    r.data.fill(0, info, info + 1064);
    r.write32(info, 40);
    r.write32(info + 4, width);
    r.write32(info + 8, height);
    r.view.setUint16(info + 12, 1, true);
    r.view.setUint16(info + 14, [16, 16, 24, 32, 8, 1, 4, 16, 16, 32][type], true);
    if (type === 1 || type >= 7) {
      r.write32(info + 16, 3);
      const masks =
        type === 7
          ? [0xf00, 0xf0, 0xf]
          : type === 8
            ? [0xe0, 0x1c, 3]
            : type === 9
              ? [0x3ff00000, 0xffc00, 0x3ff]
              : [0xf800, 0x7e0, 0x1f];
      masks.forEach((value, i) => r.write32(info + 40 + i * 4, value));
    }
    if (type === 4 || type === 6) {
      r.write32(info + 32, 4);
      [0, 0xff0000, 0xff00, 0xffffff].forEach((value, i) => r.write32(info + 40 + i * 4, value));
    }
    if (type === 5) r.write32(info + 44, 0xffffff);
    const dc = call('CreateCompatibleDC', 0);
    const bitmap = call('CreateDIBSection', dc, info, 0, out, 0, 0);
    assert.ok(bitmap);
    call('SelectObject', dc, bitmap);
    return { dc, bits: r.read32(out) };
  };
  return { r, api, call, create };
}

test('SetPixel matches native results, LastError, readback and all raw bytes for 217 RGB, palette and DIB-index writes', (t) => {
  const { r, api, call, create } = setup(t);
  const surfaces = Array.from({ length: 7 }, (_, type) => create(type));
  assert.equal(native.cases.length, 217);
  for (const c of native.cases) {
    const { dc, bits } = surfaces[c.type];
    r.write32(bits, native.initial);
    r.lastError = 777;
    const label = `${c.type}/${c.color.toString(16)}`;
    assert.deepEqual(api('SetPixel', dc, 0, 0, c.color), { result: c.result, argc: 4 }, label);
    assert.equal(r.lastError, c.error, label + '/LastError');
    assert.equal(call('GetPixel', dc, 0, 0), c.pixel, label + '/GetPixel');
    assert.equal(r.read32(bits), c.raw, label + '/raw');
  }
});

test('93 independent native bitfield writes cover 444, 332 and 10-bit channel storage and decoding', async (t) => {
  const { r, api, call, create } = setup(t);
  const surfaces = new Map([7, 8, 9].map((type) => [type, create(type)]));
  const captured = JSON.parse(
    await readFile('tests/fixtures/gdi-pixel-colors/bitfields-wine-oracle.json', 'utf8'),
  );
  assert.equal(captured.cases.length, 93);
  for (const c of captured.cases) {
    const { dc, bits } = surfaces.get(c.type);
    r.write32(bits, native.initial);
    r.lastError = 777;
    const label = `${c.type}/${c.color.toString(16)}`;
    assert.deepEqual(api('SetPixel', dc, 0, 0, c.color), { result: c.result, argc: 4 }, label);
    assert.equal(r.lastError, c.error, label + '/LastError');
    assert.equal(call('GetPixel', dc, 0, 0), c.pixel, label + '/GetPixel');
    assert.equal(r.read32(bits), c.raw, label + '/raw');
  }
});

test('packed DIB index writes preserve the other pixel and row padding in both scan orders', (t) => {
  const { r, call, create } = setup(t);
  for (const type of [4, 5, 6])
    for (const height of [-2, 2]) {
      const { dc, bits } = create(type, 2, height);
      const row = bits + (height > 0 ? 4 : 0);
      r.write32(bits, 0x70605080);
      r.write32(bits + 4, 0x70605080);
      const index = type === 5 ? 1 : type === 4 ? 255 : 15;
      assert.equal(call('SetPixel', dc, 1, 0, 0x10ff0000 | index), type === 5 ? 0xffffff : 0);
      const expected = type === 4 ? 0x7060ff80 : type === 5 ? 0x706050c0 : 0x7060508f;
      assert.equal(r.read32(row), expected);
      assert.equal(r.read32(bits + (row === bits ? 4 : 0)), 0x70605080);
      const clip = call('CreateRectRgn', 0, 1, 2, 2);
      assert.equal(call('SelectClipRgn', dc, clip), 2);
      assert.equal(call('SetPixel', dc, 1, 0, 0xffffff), 0xffffffff);
      assert.equal(r.read32(row), expected, 'clipped writes leave actual storage intact');
    }
});

test('unchanged SDK color client checks native results and bytes through actual Wine base DLLs and x86-to-Wasm execution', async () => {
  const executable = new Uint8Array(
    await readFile('tests/fixtures/gdi-pixel-colors/gdi-pixel-colors.exe'),
  );
  const manifest = JSON.parse(await readFile('runtime/wine-base/manifest.json', 'utf8'));
  const builtinFiles = new Map(),
    nlsFiles = new Map(),
    events = [];
  for (const row of manifest.dlls)
    builtinFiles.set(
      row.name,
      new Uint8Array(await readFile('public/runtime/wine-base/' + row.path)),
    );
  for (const row of manifest.nls)
    nlsFiles.set(row.name, new Uint8Array(await readFile('public/runtime/wine-base/' + row.path)));
  const entries = [...DEFAULT_ENVIRONMENT, 'WINEBROWSER_COLORS_CHECK=1'];
  const r = new Runtime(iced, {
    files: new Map([['gdi-pixel-colors.exe', executable]]),
    exe: 'gdi-pixel-colors.exe',
    builtinFiles,
    nlsFiles,
    environment: { ansi: [...entries], wide: [...entries] },
    emit: (event) => events.push(event),
  });
  const result = await r.run();
  assert.equal(result.exitCode, 0);
  assert.ok(result.totalCompiledBlocks > 0);
  for (const name of ['SetPixel', 'GetPixel', 'CreateDIBSection'])
    assert.ok(result.apiNames.includes('gdi32.dll!' + name));
  assert.equal(
    events
      .filter((e) => e.type === 'stdout')
      .map((e) => e.text)
      .join(''),
    'NATIVE BITMAP COLORS ABI PASS\n',
  );
  for (const name of ['kernel32.dll', 'kernelbase.dll', 'ntdll.dll'])
    assert.ok(result.modules.some((m) => m.name === name && !m.host));
});
