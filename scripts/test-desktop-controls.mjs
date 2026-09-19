import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.js',
  server: { host: '127.0.0.1', port: 0, strictPort: false },
});
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });

try {
  await server.listen();
  const baseUrl = server.resolvedUrls.local[0];
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(new URL('tests/fixtures/desktop-controls.html', baseUrl).href);
  await page.evaluate(async () => {
    const { VirtualDesktop } = await import('/src/desktop.js');
    window.desktopEvents = [];
    window.virtualDesktop = new VirtualDesktop(document.querySelector('#desktop'), (event) =>
      window.desktopEvents.push(event),
    );
    const desktop = window.virtualDesktop;
    desktop.update({
      operation: 'create',
      window: {
        id: 1,
        title: 'Parent',
        x: 0,
        y: 0,
        width: 400,
        height: 260,
        visible: true,
        icon: { width: 2, height: 1, pixels: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]) },
      },
    });
    desktop.update({
      operation: 'create',
      window: {
        id: 2,
        parentId: 1,
        controlType: 'static',
        title: 'E&xit && Save',
        noPrefix: false,
        x: 8,
        y: 8,
        width: 100,
        height: 24,
        visible: true,
        enabled: true,
      },
    });
    desktop.update({
      operation: 'create',
      window: {
        id: 5,
        parentId: 1,
        controlType: 'static',
        title: 'E&xit && Save',
        noPrefix: true,
        x: 116,
        y: 8,
        width: 140,
        height: 24,
        visible: true,
        enabled: true,
      },
    });
    desktop.update({
      operation: 'create',
      window: {
        id: 3,
        parentId: 1,
        controlType: 'button',
        title: '&Run && Go',
        noPrefix: false,
        x: 8,
        y: 36,
        width: 100,
        height: 24,
        visible: true,
        enabled: true,
      },
    });
    desktop.update({
      operation: 'create',
      window: {
        id: 4,
        parentId: 1,
        controlType: 'edit',
        title: 'initial',
        readOnly: true,
        textAlign: 'center',
        x: 8,
        y: 64,
        width: 180,
        height: 26,
        visible: true,
        enabled: true,
      },
    });
  });

  const icon = page.locator('[data-window-id="1"] .virtual-desktop-window-icon');
  assert.equal(await icon.isVisible(), true);
  assert.deepEqual(
    await icon.evaluate((canvas) => [...canvas.getContext('2d').getImageData(0, 0, 2, 1).data]),
    [255, 0, 0, 255, 0, 255, 0, 255],
    'the desktop renders the guest icon pixels',
  );
  await page.evaluate(() =>
    window.virtualDesktop.update({
      operation: 'update',
      window: { id: 1, title: 'Renamed' },
    }),
  );
  assert.equal(await icon.isVisible(), true, 'ordinary window updates preserve the class icon');
  await page.evaluate(() =>
    window.virtualDesktop.update({
      operation: 'update',
      window: { id: 1, icon: null },
    }),
  );
  assert.equal(await icon.isVisible(), false);

  const staticControl = page.locator('[data-window-id="2"]');
  const button = page.locator('[data-window-id="3"]');
  const noPrefixStatic = page.locator('[data-window-id="5"]');
  const edit = page.locator('[data-window-id="4"]');
  assert.equal(await staticControl.textContent(), 'Exit & Save');
  assert.equal(await button.textContent(), 'Run & Go');
  assert.equal(await noPrefixStatic.textContent(), 'E&xit && Save');
  assert.equal(await edit.inputValue(), 'initial');
  assert.equal(await edit.evaluate((element) => element.readOnly), true);
  assert.equal(await edit.evaluate((element) => getComputedStyle(element).textAlign), 'center');

  await page.evaluate(() => {
    window.virtualDesktop.update({
      operation: 'update',
      window: {
        id: 4,
        parentId: 1,
        controlType: 'edit',
        title: 'initial',
        readOnly: false,
        textAlign: 'right',
      },
    });
  });
  await edit.fill('typed value');
  await edit.evaluate((element) => element.setSelectionRange(2, 2));
  await page.evaluate(() => {
    window.virtualDesktop.update({
      operation: 'update',
      window: {
        id: 4,
        parentId: 1,
        controlType: 'edit',
        title: 'typed value',
        readOnly: false,
        textAlign: 'right',
      },
    });
    window.virtualDesktop.update({
      operation: 'update',
      window: {
        id: 5,
        parentId: 1,
        controlType: 'static',
        noPrefix: false,
      },
    });
  });
  assert.equal(await edit.evaluate((element) => element.readOnly), false);
  assert.equal(await edit.evaluate((element) => getComputedStyle(element).textAlign), 'right');
  assert.equal(await edit.evaluate((element) => element.selectionStart), 2);
  assert.equal(await noPrefixStatic.textContent(), 'Exit & Save');
  assert.ok(
    (await page.evaluate(() => window.desktopEvents)).some(
      (event) => event.type === 'text' && event.windowId === 4 && event.text === 'typed value',
    ),
    'edit input is reported to the guest bridge',
  );
  assert.deepEqual(pageErrors, []);
  await page.evaluate(() =>
    window.virtualDesktop.update({
      operation: 'update',
      window: {
        id: 5,
        parentId: 1,
        controlType: 'static',
        controlBorder: 1,
      },
    }),
  );
  assert.equal(
    await noPrefixStatic.evaluate((element) => getComputedStyle(element).borderLeftWidth),
    '1px',
  );
  await page.evaluate(() =>
    window.virtualDesktop.update({
      operation: 'update',
      window: {
        id: 5,
        parentId: 1,
        controlType: 'static',
        controlBorder: 0,
      },
    }),
  );
  assert.equal(
    await noPrefixStatic.evaluate((element) => getComputedStyle(element).borderLeftWidth),
    '0px',
  );
  console.log(
    JSON.stringify(
      {
        browser: browser.version(),
        mnemonicCaptions: true,
        readOnlyAndAlignment: true,
        editValueAndCaretPreserved: true,
        titlebarIconPixels: true,
        pageErrors,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  await server.close();
}
