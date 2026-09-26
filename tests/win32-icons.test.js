import test from 'node:test';
import assert from 'node:assert/strict';
import { iconApis, decodeIconDib, parseGroupIcon } from '../src/win32-icons.js';
import { listPEResources, readPEResource } from '../src/pe-resources.js';
import { WindowManager } from '../src/win32-windows.js';

function put16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function put32(view, offset, value) {
  view.setUint32(offset, value >>> 0, true);
}

function iconDib() {
  const bytes = new Uint8Array(120);
  const view = new DataView(bytes.buffer);
  put32(view, 0, 40);
  put32(view, 4, 2);
  put32(view, 8, 4); // XOR and AND bitmaps each have two rows.
  put16(view, 12, 1);
  put16(view, 14, 4);
  bytes.set([0, 0, 255, 0], 40 + 4); // Palette 1: red.
  bytes.set([0, 255, 0, 0], 40 + 8); // Palette 2: green.
  bytes[104] = 0x12; // Bottom row, left-to-right: red, green.
  bytes[108] = 0x21; // Top row: green, red.
  bytes[116] = 0x80; // Top-left is transparent in the AND mask.
  return bytes;
}

function groupIcon() {
  const bytes = new Uint8Array(20);
  const view = new DataView(bytes.buffer);
  put16(view, 2, 1);
  put16(view, 4, 1);
  bytes[6] = 2;
  bytes[7] = 2;
  put16(view, 10, 1);
  put16(view, 12, 4);
  put32(view, 14, 120);
  put16(view, 18, 1);
  return bytes;
}

function resourcePE() {
  const bytes = new Uint8Array(0x1200);
  const view = new DataView(bytes.buffer);
  put16(view, 0, 0x5a4d);
  put32(view, 0x3c, 0x80);
  put32(view, 0x80, 0x4550);
  put16(view, 0x84, 0x14c);
  put16(view, 0x86, 1);
  put16(view, 0x94, 224);
  put16(view, 0x96, 0x102);
  const optional = 0x98;
  put16(view, optional, 0x10b);
  put32(view, optional + 16, 0x1000);
  put32(view, optional + 28, 0x400000);
  put32(view, optional + 32, 0x1000);
  put32(view, optional + 36, 0x200);
  put32(view, optional + 56, 0x3000);
  put32(view, optional + 60, 0x200);
  put16(view, optional + 68, 3);
  put32(view, optional + 92, 16);
  put32(view, optional + 96 + 2 * 8, 0x1100);
  put32(view, optional + 100 + 2 * 8, 0x100);
  const section = optional + 224;
  bytes.set(new TextEncoder().encode('.rsrc'), section);
  put32(view, section + 8, 0x1000);
  put32(view, section + 12, 0x1000);
  put32(view, section + 16, 0x1000);
  put32(view, section + 20, 0x200);
  put32(view, section + 36, 0x60000020);

  const root = 0x300; // File offset for resource RVA 0x1100.
  const directory = (relative, entries) => {
    put16(view, root + relative + 14, entries.length);
    entries.forEach(([name, target], index) => {
      put32(view, root + relative + 16 + index * 8, name);
      put32(view, root + relative + 20 + index * 8, target);
    });
  };
  directory(0, [
    [3, 0x80000020],
    [14, 0x80000060],
  ]);
  directory(0x20, [[1, 0x80000038]]);
  directory(0x38, [[0x409, 0x50]]);
  put32(view, root + 0x50, 0x1200);
  put32(view, root + 0x54, 120);
  directory(0x60, [[101, 0x80000078]]);
  directory(0x78, [[0x409, 0x90]]);
  put32(view, root + 0x90, 0x1300);
  put32(view, root + 0x94, 20);
  bytes.set(iconDib(), 0x400); // RVA 0x1200.
  bytes.set(groupIcon(), 0x500); // RVA 0x1300.
  return bytes;
}

test('PE resource reader finds group/icon leaves and decodes legacy 4-bit DIB transparency', () => {
  const pe = resourcePE();
  assert.deepEqual(listPEResources(pe, 14), [101]);
  const group = parseGroupIcon(readPEResource(pe, 14, 101));
  assert.deepEqual(group, [{ width: 2, height: 2, planes: 1, bitCount: 4, bytes: 120, id: 1 }]);
  const icon = decodeIconDib(readPEResource(pe, 3, 1), group[0]);
  assert.deepEqual([icon.width, icon.height], [2, 2]);
  assert.deepEqual(
    [...icon.pixels],
    [0, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255],
  );
});

test('LoadIconA/W caches a shared immutable icon handle and window events carry pixels', () => {
  const events = [];
  const runtime = {
    graph: { modules: new Map([['app.exe', { base: 0x400000, bytes: resourcePE() }]]) },
    emit: (event) => events.push(event),
  };
  const loadA = iconApis['user32.dll!LoadIconA'];
  const loadW = iconApis['user32.dll!LoadIconW'];
  const args = [0x400000, 101];
  const first = loadA(runtime, (index) => args[index]);
  const second = loadW(runtime, (index) => args[index]);
  assert.notEqual(first.result, 0);
  assert.equal(second.result, first.result);

  const manager = new WindowManager(runtime);
  manager.emit(
    {
      id: 1,
      title: 'Icon test',
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      visible: true,
      cls: { icon: first.result },
    },
    'create',
  );
  const emitted = events.at(-1).window.icon;
  assert.deepEqual([emitted.width, emitted.height], [2, 2]);
  emitted.pixels.fill(0);
  manager.emit({ id: 1, width: 1, height: 1, cls: { icon: first.result } });
  assert.notDeepEqual([...events.at(-1).window.icon.pixels], [...emitted.pixels]);

  const missing = loadA(runtime, (index) => [0x400000, 999][index]);
  assert.equal(missing.result, 0);
  assert.equal(runtime.lastError, 1814);
  const invalidModule = loadA(runtime, (index) => [0x12340000, 101][index]);
  assert.equal(invalidModule.result, 0);
  assert.equal(runtime.lastError, 6);
});

test('unsupported icon payload encodings fail explicitly', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, ...new Array(36).fill(0)]);
  assert.throws(() => decodeIconDib(png), /PNG icon resources are unsupported/);
  const palette = iconDib();
  put32(new DataView(palette.buffer), 32, 17);
  assert.throws(() => decodeIconDib(palette), /palette size/);
});

test('32-bit icon alpha takes precedence over its legacy AND mask', () => {
  const bytes = new Uint8Array(48);
  const view = new DataView(bytes.buffer);
  put32(view, 0, 40);
  put32(view, 4, 1);
  put32(view, 8, 2);
  put16(view, 12, 1);
  put16(view, 14, 32);
  bytes.set([30, 20, 10, 128], 40);
  bytes[44] = 0x80;
  assert.deepEqual([...decodeIconDib(bytes).pixels], [10, 20, 30, 128]);
});

test('24-bit icon DIBs decode BGR rows with padding, bottom-up order and a separate 1-bit mask', () => {
  const bytes = new Uint8Array(72),
    v = new DataView(bytes.buffer);
  put32(v, 0, 40);
  put32(v, 4, 3);
  put32(v, 8, 4);
  put16(v, 12, 1);
  put16(v, 14, 24);
  bytes.set([3, 2, 1, 6, 5, 4, 9, 8, 7, 0xff, 0xff, 0xff], 40);
  bytes.set([30, 20, 10, 60, 50, 40, 90, 80, 70, 0xaa, 0xaa, 0xaa], 52);
  bytes[64] = 0x20; // Bottom-right transparent.
  bytes[68] = 0x40; // Top-middle transparent.
  assert.deepEqual(
    [...decodeIconDib(bytes, { width: 3, height: 2, bitCount: 24 }).pixels],
    [10, 20, 30, 255, 40, 50, 60, 0, 70, 80, 90, 255, 1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 0],
  );
  assert.throws(() => decodeIconDib(bytes.subarray(0, 71)), /Truncated icon DIB/);
  assert.throws(() => decodeIconDib(bytes, { bitCount: 32 }), /depth does not match/);
  put32(v, 32, 1);
  assert.throws(() => decodeIconDib(bytes), /palette size/);
});

test('24-bit icon masks span byte and row padding boundaries without reading RGB as alpha', () => {
  const bytes = new Uint8Array(40 + 28 + 4),
    v = new DataView(bytes.buffer);
  put32(v, 0, 40);
  put32(v, 4, 9);
  put32(v, 8, 2);
  put16(v, 12, 1);
  put16(v, 14, 24);
  bytes.fill(0xfe, 40, 68);
  bytes[68] = 0x81;
  bytes[69] = 0x80;
  const icon = decodeIconDib(bytes);
  assert.deepEqual(
    Array.from({ length: 9 }, (_, i) => icon.pixels[i * 4 + 3]),
    [0, 255, 255, 255, 255, 255, 255, 0, 0],
  );
  assert.deepEqual([...icon.pixels.slice(4, 8)], [254, 254, 254, 255]);
});
