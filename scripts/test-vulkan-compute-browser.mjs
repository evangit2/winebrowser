import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';
const url = process.env.WINEBROWSER_TEST_URL || 'http://127.0.0.1:4193/winebrowser/';
const browser = await chromium.launch(
  process.env.WINEBROWSER_NORMAL_CHROMIUM === '1'
    ? { channel: process.env.BROWSER_CHANNEL || 'chrome', headless: false }
    : webgpuBrowserOptions,
);
try {
  const page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction(
    () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
  );
  await page.locator('#file').setInputFiles({
    name: 'compute.exe',
    mimeType: 'application/octet-stream',
    buffer: await readFile('tests/fixtures/vulkan-compute/compute.exe'),
  });
  await page.waitForFunction(
    () =>
      document.querySelector('#state')?.textContent === 'LOADED' &&
      !document.querySelector('#run').disabled,
  );
  await page.locator('#run').click();
  await page.waitForFunction(
    () => {
      if (document.querySelector('#state')?.textContent === 'ERROR')
        throw Error(
          document.querySelector('#output').textContent +
            document.querySelector('#logs').textContent,
        );
      return window.__lastRun !== null;
    },
    null,
    { timeout: 60000 },
  );
  const report = await page.evaluate(() => ({
    result: window.__lastRun,
    output: document.querySelector('#output').textContent,
  }));
  assert.equal(report.result.exitCode, 0, JSON.stringify(report));
  assert.match(report.output, /vulkan-compute-ok/);
  for (const name of [
    'vkCreateComputePipelines',
    'vkCmdDispatch',
    'vkCmdPushConstants',
    'vkQueueSubmit',
    'vkCmdCopyBuffer',
    'vkCmdPipelineBarrier',
  ])
    assert.ok(report.result.apiNames.includes('vulkan-1.dll!' + name));
  await mkdir('evidence', { recursive: true });
  await writeFile(
    'evidence/vulkan-compute-results.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        url,
        browser: browser.version(),
        ordinaryBrowser: process.env.WINEBROWSER_NORMAL_CHROMIUM === '1',
        ...report,
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Native Vulkan storage-buffer compute and repeated coherent GPU readback passed.');
} finally {
  await browser.close();
}
