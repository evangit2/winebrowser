import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

// Private input only. The game and captured frames must not enter public assets.
const archivePath = process.env.AIRXONIX_ARCHIVE;
assert.ok(archivePath, 'Set AIRXONIX_ARCHIVE to your complete AirXonix v1.36 ZIP');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const archive = await readFile(archivePath);
const archiveSha256 = hash(archive);
assert.equal(archiveSha256, 'd4f77c84a6f798bf856aca296cf2cb1948267df18241bb0bc797b93f1b710df7');
const files = unzipSync(archive);
for (const [name, pin] of [
  ['airxonix.exe', '7c2ab0abeefd3e2d3426880a023b211e9e93724523068f2c178b6fc9804d0ddb'],
  ['program.exe', 'aaecaf0b3a201eedcaad1e9602a25f7e642f050fb70dca9461b2d7a341ce7de3'],
]) {
  const file = Object.entries(files).find(([p]) => p.toLowerCase().endsWith('/' + name));
  assert.ok(file, name);
  assert.equal(hash(file[1]), pin);
}
const runs = [],
  errors = [];
let server,
  browser,
  url = process.env.WINEBROWSER_TEST_URL;
try {
  if (!url) {
    server = await createServer({
      base: '/',
      logLevel: 'error',
      server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
    });
    await server.listen();
    url = `http://127.0.0.1:${server.httpServer.address().port}/`;
  }
  browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || 'chrome',
    headless: false,
  });
  for (const executable of JSON.parse(
    process.env.AIRXONIX_EXECUTABLES || '["airxonix.exe","program.exe"]',
  )) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(
      () => document.querySelector('#platform')?.textContent === 'ISOLATED / WASM READY',
      null,
      { timeout: 60000 },
    );
    await page
      .locator('#file')
      .setInputFiles({ name: 'AirXonix.zip', mimeType: 'application/zip', buffer: archive });
    await page.waitForFunction(() => !document.querySelector('#run').disabled, null, {
      timeout: 120000,
    });
    await page.locator('#exe').selectOption('airxonix/' + executable);
    const startTime = performance.now();
    await page.locator('#run').click();
    await page.getByRole('button', { name: 'START', exact: true }).click({ timeout: 60000 });
    const canvas = page.locator('.virtual-desktop-canvas');
    async function sample() {
      return canvas.evaluate(async (c) => {
        const p = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        const colors = new Set();
        let lit = 0,
          green = 0,
          heart = 0,
          hud = 0,
          border = 0,
          shipN = 0,
          shipX = 0,
          shipY = 0;
        for (let y = 0; y < c.height; y++)
          for (let x = 0; x < c.width; x++) {
            const i = (y * c.width + x) * 4,
              r = p[i],
              g = p[i + 1],
              b = p[i + 2];
            if (Math.max(r, g, b) > 24) lit++;
            if (colors.size < 4096) colors.add((r << 16) | (g << 8) | b);
            if (y < 180 && g > 65 && g > r * 1.6 && g > b * 1.6) green++;
            if (x < 35 && y < 35 && r > 150 && r > g * 1.5 && r > b * 1.5) heart++;
            if (y > 450 && r > 180 && g > 150 && b < 80) hud++;
            if (y > 20 && y < 340 && r > 80 && r > g * 1.25 && g > b * 1.15) border++;
            // The initial-level foreground band excludes cyan water textures
            // and enemy balls while retaining the ship's body as it moves right.
            if (
              y > 282 &&
              y < 320 &&
              g > 65 &&
              g > r * 1.8 &&
              b > r * 1.8 &&
              Math.abs(g - b) < 60
            ) {
              shipN++;
              shipX += x;
              shipY += y;
            }
          }
        const digest = async (bytes) =>
          [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        const region = (x, y, w, h) => c.getContext('2d').getImageData(x, y, w, h).data;
        const timerPixels = region(574, 0, 34, 27);
        const timerMask = Uint8Array.from({ length: 34 * 27 }, (_, i) => {
          const q = i * 4;
          return timerPixels[q] > 180 && timerPixels[q + 1] > 150 && timerPixels[q + 2] < 80
            ? 1
            : 0;
        });
        return {
          width: c.width,
          height: c.height,
          frames: Number(c.dataset.graphicsFrames || 0),
          draws: Number(c.dataset.graphicsDraws || 0),
          renderer: c.dataset.renderer,
          lit,
          colors: colors.size,
          green,
          heart,
          hud,
          border,
          ship: shipN ? { pixels: shipN, x: shipX / shipN, y: shipY / shipN } : null,
          hash: await digest(p),
          timerHash: await digest(timerMask),
          boardHash: await digest(region(70, 50, 500, 190)),
        };
      });
    }
    const snapshots = [];
    async function capture(name) {
      const s = await sample();
      snapshots.push({ name, ...s });
      if (process.env.AIRXONIX_SCREENSHOTS) {
        await mkdir('.scratch/airxonix-acceptance', { recursive: true });
        await canvas.screenshot({ path: `.scratch/airxonix-acceptance/${executable}-${name}.png` });
      }
      console.log(
        JSON.stringify({ executable, name, frames: s.frames, draws: s.draws, ship: s.ship }),
      );
      return s;
    }
    async function until(label, predicate, timeout = 90000) {
      const deadline = performance.now() + timeout;
      while (performance.now() < deadline) {
        assert.equal(
          await page.locator('#state').textContent(),
          'RUNNING',
          await page.locator('#logs').textContent(),
        );
        const s = await sample();
        if (predicate(s)) return s;
        await page.waitForTimeout(500);
      }
      const diagnostic = await capture('failed-' + label.replace(/[^a-z0-9]+/gi, '-'));
      console.error(JSON.stringify(diagnostic));
      throw Error('Timed out waiting for ' + label);
    }
    await until('animated native menu', (s) => s.frames > 15 && s.green > 1000);
    await canvas.focus();
    const menu = await capture('menu');
    await page.waitForTimeout(1000);
    const animated = await sample();
    assert.ok(animated.frames > menu.frames);
    assert.notEqual(animated.hash, menu.hash);
    await page.keyboard.press('Enter');
    await until(
      'game selection menu',
      (s) =>
        s.lit > 10000 &&
        s.lit < 100000 &&
        s.green > 1300 &&
        s.green < 5000 &&
        s.frames > menu.frames + 60,
    );
    await capture('select-game');
    const levelStart = performance.now();
    await page.keyboard.down('Enter');
    await page.waitForTimeout(250);
    await page.keyboard.up('Enter');
    await until(
      'textured level, ship, lives and score',
      (s) =>
        s.heart > 100 && s.hud > 100 && s.lit > 200000 && s.colors > 1000 && s.ship?.pixels > 20,
    );
    const levelLoadMs = performance.now() - levelStart;
    const level = await capture('level');
    assert.deepEqual([level.width, level.height], [640, 480]);
    assert.equal(level.renderer, 'webgpu');
    assert.ok(level.lit > 200000 && level.colors > 1000);
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(1500);
    await page.keyboard.up('ArrowRight');
    const moved = await capture('move');
    assert.ok(moved.ship && moved.ship.x > level.ship.x + 10, 'arrow input moves the actual ship');
    assert.notEqual(moved.boardHash, level.boardHash);
    await page.keyboard.press('p');
    await page.waitForTimeout(1000);
    const paused = await capture('pause');
    await page.waitForTimeout(2000);
    const stillPaused = await capture('pause-stable');
    assert.equal(stillPaused.timerHash, paused.timerHash, 'P freezes the level timer');
    await page.keyboard.press('p');
    await page.waitForTimeout(3000);
    const resumed = await capture('resume');
    assert.notEqual(resumed.timerHash, paused.timerHash, 'P resumes the level timer');
    const perfStart = performance.now(),
      perfFrames = resumed.frames;
    await page.waitForTimeout(3000);
    const perfEnd = await capture('performance');
    const fps = ((perfEnd.frames - perfFrames) * 1000) / (performance.now() - perfStart);
    await page.keyboard.down('Control');
    await page.keyboard.down('q');
    await page.waitForTimeout(750);
    await page.keyboard.up('q');
    await page.keyboard.up('Control');
    await until('return to main menu', (s) => s.green > 1000 && s.heart < 10 && s.hud < 25);
    await capture('returned-menu');
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(150);
    }
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__lastRun !== null, null, { timeout: 60000 });
    const result = await page.evaluate(() => ({
      run: window.__lastRun,
      state: document.querySelector('#state').textContent,
      logs: document.querySelector('#logs').textContent,
      fault: window.__lastFaultDiagnostic,
    }));
    assert.equal(result.state, 'EXITED', JSON.stringify(result));
    assert.equal(result.run.exitCode, 0);
    assert.ok(!result.fault);
    const processes = result.run.processes ?? [result.run];
    assert.ok(
      processes.every((p) => p.exitCode === 0 && !p.error),
      JSON.stringify(processes),
    );
    if (executable === 'airxonix.exe')
      assert.ok(
        processes.some((p) => p.exe === 'airxonix/program.exe'),
        'real launcher child is checked',
      );
    const reached = new Set(processes.flatMap((p) => p.apiNames ?? p.apiTrace ?? []));
    for (const api of [
      'IDirectDraw7.GetDeviceIdentifier',
      'IDirect3D7.CreateVertexBuffer',
      'IDirect3DVertexBuffer7.Lock',
      'IDirect3DDevice7.DrawIndexedPrimitiveVB',
      'IDirectDrawSurface7.Flip',
    ])
      assert.ok(reached.has(api), 'native game reached ' + api);
    assert.ok(!/Unsupported|Unimplemented|WebGPU validation failed/.test(result.logs), result.logs);
    runs.push({
      executable,
      playable: true,
      gameFrameVerified: true,
      levelLoadMs,
      elapsedMs: performance.now() - startTime,
      fps,
      snapshots,
      processes: processes.map((p) => ({ exe: p.exe, exitCode: p.exitCode, apiNames: p.apiNames })),
      checks: [
        'unchanged complete private ZIP',
        'native launcher/startup dialog',
        'animated 3D menu',
        'textured first level',
        'arrow-key ship movement',
        'pause/resume timer',
        'Ctrl+Q main menu',
        'native Exit menu and every process exit zero',
      ],
    });
    await page.close();
  }
  assert.deepEqual(errors, []);
  const report = {
    date: new Date().toISOString(),
    url,
    archiveSha256,
    binariesRedistributed: false,
    runtimeExecutableSpecificBranches: false,
    gameFrameVerified: true,
    playable: true,
    runs,
    errors,
  };
  await writeFile(
    process.env.AIRXONIX_EVIDENCE || 'evidence/directdraw-airxonix-results.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        runs: runs.map((r) => ({
          executable: r.executable,
          fps: r.fps,
          levelLoadMs: r.levelLoadMs,
        })),
      },
      null,
      2,
    ),
  );
} finally {
  await browser?.close();
  await server?.close();
}
process.exit(0);
