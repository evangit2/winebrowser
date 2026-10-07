import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderScrollbar } from '../src/gdi-scrollbars.js';
const rows = JSON.parse(
  await readFile('tests/fixtures/scroll-controls/geometry-wine-oracle.json'),
).cases;
test('standalone classic scrollbar pixels match native desktop captures', () => {
  for (const c of rows) {
    const [min, max, page, pos] = c.state;
    const width = c.vertical ? c.thickness : c.length,
      height = c.vertical ? c.length : c.thickness;
    const pixels = renderScrollbar(width, height, {
      vertical: !!c.vertical,
      min,
      max,
      page,
      pos,
      disabled: c.stage >= 8 && c.stage <= 10 ? c.stage - 7 : 0,
      pressed: -1,
    });
    for (const [x, y, n, color] of c.runs)
      for (let i = x; i < x + n; i++) {
        const index = (y * width + i) * 4;
        const actual = pixels[index] | (pixels[index + 1] << 8) | (pixels[index + 2] << 16);
        assert.equal(
          actual,
          color,
          JSON.stringify({ v: c.vertical, l: c.length, t: c.thickness, s: c.stage, x: i, y }),
        );
        assert.equal(pixels[index + 3], 255);
      }
  }
});
