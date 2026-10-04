import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { readPEResource } from '../src/pe-resources.js';
import { readDialogTemplate, buildDialog } from '../src/win32-dialogs.js';
import { describeGdiFont } from '../src/win32-gdi.js';
import { measureDialogUnits, dialogX, dialogY } from '../src/dialog-units.js';
const fixture = new URL('./fixtures/dialog-fonts/dialog-fonts.exe', import.meta.url);

test('classic and extended resource FONT fields retain logical font attributes', async () => {
  const bytes = new Uint8Array(await readFile(fixture));
  assert.deepEqual(readDialogTemplate(readPEResource(bytes, 5, 101)).font, {
    value: 'Arial',
    size: 12,
    weight: 400,
    italic: 0,
    charset: 1,
  });
  assert.deepEqual(readDialogTemplate(readPEResource(bytes, 5, 102)).font, {
    value: 'Arial',
    size: 11,
    weight: 700,
    italic: 1,
    charset: 1,
  });
  assert.equal(readDialogTemplate(readPEResource(bytes, 5, 103)).font, null);
});

test('dialog units use alphabet and line metrics with bounded fallback and signed rounding', () => {
  const font = { css: '700 15px Arial', height: 15 };
  let measured;
  class Canvas {
    getContext() {
      return {
        set font(v) {
          assert.equal(v, font.css);
        },
        measureText(text) {
          measured = text;
          return { width: 364, fontBoundingBoxAscent: 14, fontBoundingBoxDescent: 3 };
        },
      };
    }
  }
  assert.deepEqual(measureDialogUnits(font, Canvas), { x: 7, y: 17 });
  assert.equal(measured, 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz');
  assert.deepEqual(measureDialogUnits(font, null), { x: 8, y: 15 });
  assert.deepEqual(measureDialogUnits(null, null), { x: 8, y: 16 });
  class NoMetrics {
    getContext() {
      return {
        measureText() {
          return { width: NaN };
        },
      };
    }
  }
  assert.deepEqual(measureDialogUnits(font, NoMetrics), { x: 8, y: 15 });
  assert.equal(dialogX({ x: 6 }, -1), -2);
  assert.equal(dialogY({ y: 12 }, -1), -2);
  assert.equal(dialogX(undefined, 4), 8);
});

async function runtime(t) {
  const bytes = new Uint8Array(await readFile(fixture));
  const consoleBytes = new Uint8Array(
    await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
  );
  const r = new Runtime(iced, {
    files: new Map([['console.exe', consoleBytes]]),
    exe: 'console.exe',
  });
  t.after(() => r.windows.dispose());
  r.callGuest = async (p, args) => {
    if (args[1] === 0x81) return 1;
    return 0;
  };
  return { r, template: readDialogTemplate(readPEResource(bytes, 5, 102)) };
}

test('resource fonts survive WM_SETFONT replacement and are released on runtime disposal', async (t) => {
  const { r, template } = await runtime(t);
  const built = await buildDialog(r, template, 0, 0x12345678, r.pe.imageBase, true);
  assert.ok(built.dialog);
  const w = r.windows.windows.get(built.dialog.id),
    font = w.dialogResourceFont;
  assert.ok(describeGdiFont(r, font));
  await r.windows.send(w.id, 0x30, 0, 0);
  assert.equal(await r.windows.send(w.id, 0x31), 0);
  assert.equal(w.dialogResourceFont, font);
  r.windows.dispose();
  assert.equal(describeGdiFont(r, font), null);
});

test('control creation failure destroys the partially built dialog and resource font', async (t) => {
  const { r, template } = await runtime(t);
  template.items[1].className = 'UnregisteredDialogControl';
  let font;
  const destroy = r.windows.destroy.bind(r.windows);
  r.windows.destroy = async (hwnd) => {
    font ??= r.windows.windows.get(hwnd)?.dialogResourceFont;
    return destroy(hwnd);
  };
  const built = await buildDialog(r, template, 0, 0x12345678, r.pe.imageBase, true);
  assert.equal(built.error, 1407);
  assert.equal(r.windows.windows.size, 0);
  assert.ok(font);
  assert.equal(describeGdiFont(r, font), null);
});
