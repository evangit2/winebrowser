import test from 'node:test';
import assert from 'node:assert/strict';
import { describeTabs, tabMessage } from '../src/win32-tabs.js';
import { controlStyle } from '../src/win32-controls.js';
import { stripCaptionMnemonics } from '../src/caption-text.js';

function setup() {
  const data = new Uint8Array(512),
    view = new DataView(data.buffer);
  const r = {
    check() {},
    read32: (p) => view.getUint32(p, true),
    write32: (p, v) => view.setUint32(p, v >>> 0, true),
    view,
    data,
    windows: { emit() {} },
  };
  const w = {
    id: 1,
    controlType: 'tabcontrol',
    style: 0,
    cls: { wide: true },
    width: 500,
    height: 100,
  };
  describeTabs(w);
  w.tabs.items = [{ id: 1, text: '&Buffers && Language', param: 0, state: 0 }];
  w.tabs.selected = 0;
  return { r, w };
}

test('native tab queries retain ampersands while presentation honors TCS_NOPREFIX', async () => {
  const { r, w } = setup();
  assert.doesNotThrow(() => controlStyle('tabcontrol', 0x50012000, 0));
  assert.equal(describeTabs(w).items[0].displayText, 'Buffers & Language');
  const normalWidth = describeTabs(w).items[0].rect[2];
  w.style = 0x2000;
  assert.equal(describeTabs(w).items[0].displayText, '&Buffers && Language');
  assert.ok(describeTabs(w).items[0].rect[2] > normalWidth);
  r.write32(32, 1);
  r.write32(44, 128);
  r.write32(48, 40);
  assert.equal(await tabMessage(r, w, 0x133c, 0, 32, () => 0), 1);
  assert.equal(
    new TextDecoder('utf-16le').decode(r.data.slice(128, 128 + w.tabs.items[0].text.length * 2)),
    w.tabs.items[0].text,
  );
  assert.equal(stripCaptionMnemonics('Save && E&xit &'), 'Save & Exit &');
});

test('font-based tabs share native rectangles, hit testing and page margins; explicit dimensions win', async () => {
  const { r, w } = setup();
  w.font = { css: '400 30px Arial', height: 30 };
  const first = describeTabs(w),
    rect = first.items[0].rect;
  assert.equal(first.height, 38);
  assert.equal(await tabMessage(r, w, 0x130a, 0, 32, () => 0), 1);
  assert.deepEqual(
    [0, 4, 8, 12].map((i) => r.read32(32 + i)),
    rect,
  );
  r.write32(64, 3);
  r.write32(68, 37);
  assert.equal(await tabMessage(r, w, 0x130d, 0, 64, () => 0), 0);
  [0, 0, 500, 100].forEach((v, i) => r.write32(80 + i * 4, v));
  await tabMessage(r, w, 0x1328, 0, 80, () => 0);
  assert.equal(r.read32(84), first.height + 4);
  await tabMessage(r, w, 0x1328, 1, 80, () => 0);
  assert.deepEqual(
    [0, 4, 8, 12].map((i) => r.read32(80 + i)),
    [0, 0, 500, 100],
  );
  w.style = 0x400;
  await tabMessage(r, w, 0x1329, 0, (42 << 16) | 120, () => 0);
  await tabMessage(r, w, 0x132b, 0, (12 << 16) | 20, () => 0);
  w.font = { css: '400 12px Arial', height: 12 };
  assert.equal(describeTabs(w).height, 42);
  assert.equal(describeTabs(w).items[0].rect[2] - describeTabs(w).items[0].rect[0], 120);
});
