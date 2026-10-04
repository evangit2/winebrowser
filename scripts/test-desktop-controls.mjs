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
  await page.evaluate(() => {
    const desktop = window.virtualDesktop;
    for (const window of [
      {
        id: 6,
        parentId: 1,
        controlType: 'static',
        title: 'Container',
        x: 200,
        y: 100,
        width: 180,
        height: 140,
        controlBorder: 2,
      },
      {
        id: 7,
        parentId: 6,
        controlType: 'edit',
        title: 'Input parent',
        x: 5,
        y: 7,
        width: 120,
        height: 80,
        controlBorder: 1,
      },
      {
        id: 8,
        parentId: 7,
        controlType: 'button',
        title: 'Nested',
        x: 8,
        y: 9,
        width: 70,
        height: 40,
      },
      {
        id: 9,
        parentId: 8,
        controlType: 'static',
        title: 'Label',
        x: 2,
        y: 2,
        width: 30,
        height: 10,
      },
    ])
      desktop.update({ operation: 'create', window: { ...window, visible: true, enabled: true } });
    desktop.update({
      operation: 'update',
      window: { id: 6, parentId: 1, controlType: 'static', title: 'Renamed container' },
    });
    desktop.update({
      operation: 'update',
      window: { id: 7, parentId: 6, controlType: 'edit', title: 'Changed input' },
    });
  });
  const nestedButton = page.locator('[data-window-id="8"]');
  assert.equal(
    await page.locator('[data-window-id="9"]').textContent(),
    'Label',
    'changing ancestor text preserves descendants',
  );
  const nestedGeometry = await page.evaluate(() => {
    const rect = (id) => document.querySelector(`[data-window-id="${id}"]`).getBoundingClientRect();
    const parent = rect(6),
      input = rect(7),
      button = rect(8);
    return [input.x - parent.x, input.y - parent.y, button.x - input.x, button.y - input.y];
  });
  assert.deepEqual(
    nestedGeometry,
    [7, 9, 9, 10],
    'child origins include native client borders at each level',
  );
  await nestedButton.click({ position: { x: 50, y: 30 } });
  assert.equal(await page.evaluate(() => window.virtualDesktop.activeWindowId), 8);
  assert.equal(
    await page.locator('.virtual-desktop-window.is-focused').getAttribute('data-window-id'),
    '1',
  );
  assert.ok(
    (await page.evaluate(() => window.desktopEvents)).some(
      (e) => e.type === 'command' && e.windowId === 8,
    ),
  );
  await page.evaluate(() =>
    window.virtualDesktop.update({
      operation: 'update',
      window: { id: 6, parentId: 1, controlType: 'static', enabled: false },
    }),
  );
  assert.equal(
    await page.evaluate(() => window.virtualDesktop.focus(8)),
    false,
    'disabled ancestors prevent native focus',
  );
  assert.equal(await nestedButton.evaluate((el) => !!el.closest('[inert]')), true);
  await page.evaluate(() =>
    window.virtualDesktop.update({
      operation: 'update',
      window: { id: 6, parentId: 1, controlType: 'static', enabled: true, visible: false },
    }),
  );
  assert.equal(await nestedButton.isVisible(), false);
  assert.equal(await page.evaluate(() => window.virtualDesktop.focus(8)), false);
  assert.equal(await page.evaluate(() => window.virtualDesktop.activeWindowId), 1);
  await page.evaluate(() =>
    window.virtualDesktop.update({
      operation: 'update',
      window: { id: 6, parentId: 1, controlType: 'static', visible: true },
    }),
  );
  assert.equal(await nestedButton.isVisible(), true);
  await page.evaluate(() =>
    window.virtualDesktop.update({ operation: 'destroy', window: { id: 6 } }),
  );
  assert.equal(await nestedButton.count(), 0);
  assert.equal(
    await page.evaluate(() => [6, 7, 8, 9].some((id) => window.virtualDesktop.windows.has(id))),
    false,
  );
  assert.equal(await page.locator('.virtual-desktop-control-container').count(), 4);
  const brushPixels = await page.evaluate(async () => {
    window.virtualDesktop.update({
      operation: 'update',
      window: {
        id: 4,
        controlColors: {
          text: 0xa05014,
          background: 0xfff0e8,
          transparent: false,
          hatch: 4,
          hatchBackground: 0x554433,
          backgroundMode: 2,
        },
      },
    });
    const element = document.querySelector('[data-window-id="4"]');
    const url = element.style.backgroundImage.slice(5, -2);
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return {
      color: getComputedStyle(element).color,
      pixels: [...context.getImageData(0, 0, 8, 8).data],
    };
  });
  assert.equal(brushPixels.color, 'rgb(20, 80, 160)');
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++)
      assert.deepEqual(
        brushPixels.pixels.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4),
        x === 0 || y === 0 ? [232, 240, 255, 255] : [51, 68, 85, 255],
      );
  await page.evaluate(() =>
    window.virtualDesktop.update({
      operation: 'update',
      window: { id: 4, controlColors: { text: 0, background: 0xffffff, transparent: true } },
    }),
  );
  assert.equal(
    await page.locator('[data-window-id="4"]').evaluate((e) => getComputedStyle(e).backgroundColor),
    'rgba(0, 0, 0, 0)',
  );
  await page.evaluate(() => {
    const desktop = window.virtualDesktop;
    desktop.update({
      operation: 'create',
      window: {
        id: 10,
        parentId: 1,
        controlType: 'button',
        title: '&Options && More',
        controlStyle: { buttonType: 'group-box' },
        x: 200,
        y: 100,
        width: 180,
        height: 100,
        visible: true,
        enabled: true,
      },
    });
    desktop.update({
      operation: 'create',
      window: {
        id: 11,
        parentId: 10,
        controlType: 'static',
        title: 'Inside group',
        x: 8,
        y: 28,
        width: 100,
        height: 20,
        visible: true,
        enabled: true,
      },
    });
  });
  const group = page.locator('fieldset[data-window-id="10"]');
  assert.equal(await group.locator('legend').textContent(), 'Options & More');
  const commandsBefore = await page.evaluate(
    () => window.desktopEvents.filter((e) => e.type === 'command').length,
  );
  const captionBounds = await group.locator('legend').boundingBox();
  await page.mouse.click(
    captionBounds.x + captionBounds.width / 2,
    captionBounds.y + captionBounds.height / 2,
  );
  assert.equal(
    await page.evaluate(() => window.desktopEvents.filter((e) => e.type === 'command').length),
    commandsBefore,
    'group-box captions are not push buttons',
  );
  await page.evaluate(() =>
    window.virtualDesktop.update({ operation: 'update', window: { id: 10, title: '&Renamed' } }),
  );
  assert.equal(await group.locator('legend').textContent(), 'Renamed');
  assert.equal(await page.locator('[data-window-id="11"]').textContent(), 'Inside group');
  await page.evaluate(() => {
    window.virtualDesktop.update({ operation: 'update', window: { id: 10, zOrder: 100 } });
    window.virtualDesktop.update({
      operation: 'create',
      window: {
        id: 13,
        parentId: 1,
        controlType: 'button',
        title: 'Inside sibling group',
        controlStyle: { buttonType: 'push' },
        x: 220,
        y: 145,
        width: 135,
        height: 24,
        visible: true,
        enabled: true,
        zOrder: 0,
      },
    });
  });
  await page.getByRole('button', { name: 'Inside sibling group', exact: true }).click();
  assert.ok(
    await page.evaluate(() =>
      window.desktopEvents.some((e) => e.windowId === 13 && e.type === 'command'),
    ),
    'a native group frame above sibling controls must allow their mouse input',
  );
  await page.evaluate(() =>
    window.virtualDesktop.update({ operation: 'destroy', window: { id: 13 } }),
  );
  await page.evaluate(() =>
    window.virtualDesktop.update({ operation: 'destroy', window: { id: 10 } }),
  );
  assert.equal(await page.locator('[data-window-id="11"]').count(), 0);
  await page.evaluate(() => {
    const desktop = window.virtualDesktop;
    desktop.update({ operation: 'update', window: { id: 1, isDialog: true } });
    desktop.update({
      operation: 'create',
      window: {
        id: 12,
        parentId: 1,
        controlType: 'edit',
        title: 'First',
        controlStyle: { multiline: true, password: false, wantReturn: true },
        x: 200,
        y: 100,
        width: 180,
        height: 100,
        visible: true,
        enabled: true,
      },
    });
  });
  const multiline = page.locator('textarea[data-window-id="12"]');
  await multiline.focus();
  await multiline.press('End');
  await multiline.press('Enter');
  await multiline.pressSequentially('Second');
  assert.equal(
    await multiline.inputValue(),
    'First\nSecond',
    'ES_WANTRETURN accepts a newline inside a dialog',
  );
  assert.ok(
    (await page.evaluate(() => window.desktopEvents)).some(
      (e) => e.type === 'text' && e.windowId === 12 && e.text === 'First\nSecond',
    ),
  );
  await page.evaluate(() =>
    window.virtualDesktop.update({
      operation: 'update',
      window: { id: 12, controlStyle: { multiline: true, password: false, readOnly: true } },
    }),
  );
  assert.equal(await multiline.evaluate((el) => el.readOnly), true);
  assert.equal(await multiline.inputValue(), 'First\nSecond');
  await page.evaluate(() =>
    window.virtualDesktop.update({ operation: 'destroy', window: { id: 12 } }),
  );
  assert.deepEqual(pageErrors, []);
  console.log(
    JSON.stringify(
      {
        browser: browser.version(),
        mnemonicCaptions: true,
        readOnlyAndAlignment: true,
        editValueAndCaretPreserved: true,
        titlebarIconPixels: true,
        nestedControlGeometryFocusAndLifecycle: true,
        groupBoxCaptionsAndLifecycle: true,
        multilineDialogNewlineAndReadOnly: true,
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
