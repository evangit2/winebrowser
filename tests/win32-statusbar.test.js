import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { statusbarMessage, describeStatusbar } from '../src/win32-statusbar.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
function setup() {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' }),
    w = {
      id: 0x20001,
      parentId: 0x20000,
      controlId: 51,
      controlType: 'statusbar',
      cls: { wide: false },
      title: 'Initial',
      width: 200,
      height: 24,
      style: 0x40000804,
    };
  r.windows.windows.set(w.id, w);
  r.windows.windows.set(w.parentId, { id: w.parentId, width: 300, height: 200 });
  const call = (msg, wp = 0, lp = 0) => statusbarMessage(r, w, msg, wp, lp, () => 0, false);
  return { r, w, call };
}
test('status parts reject unsupported text/layouts without mutation and discard removed part data', async () => {
  const { r, w, call } = setup(),
    p = r.allocate(12);
  r.write32(p, 80);
  r.write32(p + 4, -1);
  assert.equal(await call(0x404, 2, p), 1);
  assert.equal(await call(0x401, 1 | 0x200, r.allocString('Second')), 1);
  const before = describeStatusbar(w);
  await assert.rejects(call(0x401, 1 | 0x1000, 0xdeadbeef), /Unsupported status bar text style/);
  await assert.rejects(call(0x40f, 1, 0x1234), /icons are not implemented/);
  assert.deepEqual(describeStatusbar(w), before);
  r.write32(p, 100);
  r.write32(p + 4, 20);
  assert.equal(await call(0x404, 2, p), 0);
  assert.deepEqual(describeStatusbar(w), before);
  assert.equal(await call(0x404, 0, p), 0);
  assert.equal(await call(0x404, 257, p), 0);
  r.write32(p, -1);
  assert.equal(await call(0x404, 1, p), 1);
  r.write32(p, 80);
  r.write32(p + 4, -1);
  assert.equal(await call(0x404, 2, p), 1);
  assert.equal(describeStatusbar(w).parts[1].text, '');
  r.data.fill(0xcc, p, p + 12);
  assert.equal(await call(0x406, 1, p), 2);
  assert.equal(r.read32(p), 80);
  assert.equal(r.read32(p + 4), 0xcccccccc);
});
test('status simple transitions notify native parent once and preserve both sets of text', async () => {
  const { r, w, call } = setup(),
    events = [];
  r.windows.send = async (hwnd, msg, wp, lp) => {
    events.push([hwnd, msg, wp, r.read32(lp), r.read32(lp + 4), r.read32(lp + 8)]);
    return 0;
  };
  await call(0x401, 255 | 0x100, r.allocString('Progress'));
  await call(0x409, 1);
  await call(0x409, 1);
  assert.deepEqual(events, [[w.parentId, 0x4e, 0, w.id, w.controlId, -880 >>> 0]]);
  assert.equal(await call(0x403), 0x01000008);
  assert.equal(await call(0x40e), 1);
  await call(0x409, 0);
  assert.equal(await call(0x403), 7);
  assert.equal(events.length, 2);
  assert.equal(describeStatusbar(w).parts[0].text, 'Initial');
});
test('fixed status bars retain geometry; docked bars use parent client and minimum height', async () => {
  const { r, w, call } = setup();
  await call(0x408, 32);
  await call(5);
  assert.deepEqual([w.width, w.height], [200, 24]);
  w.style &= ~4;
  await call(5);
  assert.deepEqual([w.x, w.y, w.width, w.height], [0, 166, 300, 34]);
  const rect = r.allocate(16);
  assert.equal(await call(0x40a, 0, rect), 1);
  assert.deepEqual(
    [0, 4, 8, 12].map((i) => r.read32(rect + i)),
    [0, 2, 300, 34],
  );
  r.data.fill(0xcc, rect, rect + 16);
  assert.equal(await call(0x40a, 1, rect), 0);
  assert.equal(r.read32(rect), 0xcccccccc);
});
