import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';

const server = await createServer({
  base: '/',
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
});
const forceReadback = process.argv.includes('--force-readback');
let browser;
try {
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch(webgpuBrowserOptions);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/tests/fixtures/desktop-controls.html');
  const report = await page.evaluate(async (forceReadback) => {
    const { WebGPURenderer } = await import('/src/webgpu-renderer.js');
    const canvas = document.createElement('canvas');
    canvas.width = 130; // Exercise padded rows in software-adapter readback.
    canvas.height = 128;
    document.body.append(canvas);
    const context = canvas.getContext('2d');
    const frames = [];
    const logs = [];
    const renderer = new WebGPURenderer({
      forceReadback,
      emit: (message) => {
        if (message.type === 'log') logs.push(message.text);
        if (message.type !== 'frame') return;
        context.drawImage(message.bitmap, 0, 0);
        message.bitmap.close();
        const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data];
        frames.push({ center: pixel(64, 64), corner: pixel(0, 0) });
      },
    });
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const vertices = (z, color) => {
      const bytes = new Uint8Array(48),
        data = new DataView(bytes.buffer);
      for (const [i, [x, y]] of [
        [-0.75, -0.75],
        [0.75, -0.75],
        [0, 0.75],
      ].entries()) {
        data.setFloat32(i * 16, x, true);
        data.setFloat32(i * 16 + 4, y, true);
        data.setFloat32(i * 16 + 8, z, true);
        data.setUint32(i * 16 + 12, color, true);
      }
      return bytes;
    };
    const draw = (z, color, depthTest = true, world = identity) => ({
      type: 'draw',
      vertices: vertices(z, color),
      vertexCount: 3,
      stride: 16,
      world,
      view: identity,
      projection: identity,
      depthTest,
      depthWrite: true,
      cullMode: 'none',
    });
    const clear = {
      type: 'clear',
      clearColor: true,
      clearDepth: true,
      color: 0x00252d41, // Guest window presentation is opaque despite clear alpha.
      depth: 1,
    };
    const legacyShader = async (path) =>
      new Uint8Array(await (await fetch('/tests/fixtures/shaders/legacy/' + path)).arrayBuffer());
    const programmable = async (pixelOnly = false) => {
      const data = new Float32Array([
        -0.75, -0.75, 0.25, 1, 1, 1, 1, 1, 0.75, -0.75, 0.25, 1, 1, 1, 1, 1, 0, 0.75, 0.25, 1, 1, 1,
        1, 1,
      ]);
      const vertexConstants = new Float32Array(256 * 4);
      if (!pixelOnly) vertexConstants.set([1, 0.5, 0.25, 1]);
      const pixelConstants = new Float32Array(224 * 4);
      if (pixelOnly) {
        pixelConstants.set([0.25, 0.25, 0.5, 0.5], 4); // c1
        pixelConstants.set([0, 0.25, 0.25, 0.5], 8); // c2
      }
      return {
        type: 'draw-programmable',
        vertices: new Uint8Array(data.buffer),
        vertexCount: 3,
        stride: 32,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x4' },
          { shaderLocation: 1, offset: 16, format: 'float32x4' },
        ],
        vertexShader: await legacyShader(
          pixelOnly ? 'wine-color.vs11.d3dbc' : 'wine-color-constant.vs11.d3dbc',
        ),
        pixelShader: await legacyShader(
          pixelOnly ? 'wine-pixel-constant.ps20.d3dbc' : 'wine-color.ps20.d3dbc',
        ),
        vertexShaderId: pixelOnly ? 3 : 1,
        pixelShaderId: pixelOnly ? 4 : 2,
        vertexConstants,
        pixelConstants,
        depthTest: true,
        depthWrite: true,
        cullMode: 'none',
      };
    };
    try {
      await renderer.createDevice({ id: 1, windowId: 1, width: 130, height: 128, depth: true });
      await renderer.present({
        id: 1,
        commands: [clear, draw(0.25, 0xffff0000), draw(0.75, 0xff0000ff)],
      });
      await renderer.present({
        id: 1,
        commands: [clear, draw(0.25, 0xffff0000), draw(0.75, 0xff0000ff, false)],
      });
      const translated = [...identity];
      translated[12] = 2;
      await renderer.present({
        id: 1,
        commands: [clear, draw(0.25, 0xffff0000, true, translated)],
      });
      await renderer.present({ id: 1, commands: [clear, await programmable()] });
      await renderer.present({ id: 1, commands: [clear, await programmable(true)] });
      const cases = [];
      for (const command of [
        { ...draw(0.5, 0xff00ff00), stride: 12 },
        { ...draw(0.5, 0xff00ff00), vertices: new Uint8Array(4) },
        { ...clear, depth: 2 },
      ]) {
        let rejected = false;
        try {
          await renderer.present({ id: 1, commands: [command] });
        } catch {
          rejected = true;
        }
        if (!rejected) throw Error('Invalid graphics command was accepted');
        cases.push('invalid command rejected');
      }
      const initialFrames = frames.splice(0);
      const submittedFrames = renderer.frames,
        draws = renderer.draws;
      renderer.destroyDevice({ id: 1 });
      const colorClear = (value) => ({ ...clear, color: value, clearDepth: false });
      await renderer.createDevice({
        id: 2,
        windowId: 1,
        width: 130,
        height: 128,
        depth: false,
        colorFormat: 23,
        swapEffect: 2,
        interval: 1,
      });
      const times = [];
      for (const commands of [[colorClear(0xff7f3f1f)], [colorClear(0xff123456)], [], []]) {
        await renderer.present({ id: 2, commands });
        times.push(performance.now());
      }
      const flipped = frames.splice(0);
      renderer.destroyDevice({ id: 2 });
      await renderer.createDevice({
        id: 3,
        windowId: 1,
        width: 130,
        height: 128,
        depth: false,
        colorFormat: 22,
        swapEffect: 3,
      });
      await renderer.present({ id: 3, commands: [colorClear(0xff123456)] });
      await renderer.present({ id: 3, commands: [] });
      const copied = frames.splice(0);
      renderer.destroyDevice({ id: 3 });
      await renderer.createDevice({
        id: 4,
        windowId: 1,
        width: 130,
        height: 128,
        depth: false,
        colorFormat: 23,
        swapEffect: 3,
      });
      await renderer.present({
        id: 4,
        commands: [colorClear(0xff000000), draw(0.5, 0xff7f3f1f, false)],
      });
      const quantizedDraw = frames.splice(0);
      renderer.destroyDevice({ id: 4 });
      await renderer.createDevice({ id: 5, windowId: 1, width: 130, height: 128, depth: true });
      const rasterCases = [];
      const shaderDraw = await programmable();
      for (const path of ['fixed', 'programmable']) {
        const triangle = (z) => {
          if (path === 'fixed') return draw(z, 0xffff0000);
          const command = { ...shaderDraw, vertices: shaderDraw.vertices.slice() };
          const data = new DataView(command.vertices.buffer);
          for (let i = 0; i < 3; i++) data.setFloat32(i * command.stride + 8, z, true);
          return command;
        };
        // Exact equality uses zero, avoiding D16 rounding ambiguity at 0.5.
        for (const [incoming, stored] of [
          [0, 0],
          [0.25, 0.75],
          [0.75, 0.25],
        ]) {
          for (const depthCompare of [
            'never',
            'less',
            'equal',
            'less-equal',
            'greater',
            'not-equal',
            'greater-equal',
            'always',
          ]) {
            await renderer.present({
              id: 5,
              commands: [
                { ...clear, depth: stored },
                { ...triangle(incoming), depthCompare },
              ],
            });
            rasterCases.push({ path, incoming, stored, depthCompare, pixel: frames.pop().center });
          }
        }
        for (const reversed of [false, true]) {
          for (const cullMode of ['none', 'cw', 'ccw']) {
            const command = { ...triangle(0.25), cullMode };
            if (reversed) {
              const bytes = command.vertices.slice(),
                stride = command.stride;
              command.vertices.set(bytes.subarray(stride, stride * 2), 0);
              command.vertices.set(bytes.subarray(0, stride), stride);
            }
            await renderer.present({ id: 5, commands: [clear, command] });
            rasterCases.push({ path, reversed, cullMode, pixel: frames.pop().center });
          }
        }
      }
      const viewportCases = [];
      const fullTriangle = (command) => {
        const copy = { ...command, vertices: command.vertices.slice() };
        const view = new DataView(copy.vertices.buffer);
        for (const [i, [x, y]] of [
          [-1, -1],
          [3, -1],
          [-1, 3],
        ].entries()) {
          view.setFloat32(i * copy.stride, x, true);
          view.setFloat32(i * copy.stride + 4, y, true);
        }
        return copy;
      };
      const inside = (x, y, r) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;
      const checkPixels = (name, expected) => {
        const pixels = context.getImageData(0, 0, 130, 128).data;
        const colors = {};
        for (let y = 0; y < 128; y++)
          for (let x = 0; x < 130; x++) {
            const index = (y * 130 + x) * 4,
              want = expected(x, y);
            if (want.some((n, i) => pixels[index + i] !== n))
              throw Error(
                `${name}: pixel ${x},${y} is ${[...pixels.slice(index, index + 4)]}, expected ${want}`,
              );
            colors[want.join(',')] = (colors[want.join(',')] ?? 0) + 1;
          }
        viewportCases.push({ name, verifiedPixels: 130 * 128, colors });
        frames.pop();
      };
      const bg = [37, 45, 65, 255],
        red = [255, 0, 0, 255],
        blue = [0, 0, 255, 255],
        green = [0, 255, 0, 255];
      const regionA = { x: 10, y: 12, width: 20, height: 16 },
        regionB = { x: 50, y: 60, width: 30, height: 25 };
      await renderer.present({
        id: 5,
        commands: [
          clear,
          { ...clear, color: 0xff0000ff, regions: [regionA] },
          { ...clear, color: 0xff00ff00, regions: [regionB] },
        ],
      });
      checkPixels('independent clear uniforms and exact rectangle edges', (x, y) =>
        inside(x, y, regionA) ? blue : inside(x, y, regionB) ? green : bg,
      );
      for (const path of ['fixed', 'programmable']) {
        const base = fullTriangle(path === 'fixed' ? draw(0.25, 0xffff0000) : shaderDraw);
        const drawn = path === 'fixed' ? red : [255, 128, 64, 255];
        for (const [name, viewport, visible] of [
          ['offset', { x: 10, y: 20, width: 40, height: 50, minZ: 0, maxZ: 1 }, true],
          ['far depth range', { x: 10, y: 20, width: 40, height: 50, minZ: 0.75, maxZ: 1 }, false],
          ['near depth range', { x: 10, y: 20, width: 40, height: 50, minZ: 0, maxZ: 0.25 }, true],
          [
            'collapsed depth range',
            { x: 10, y: 20, width: 40, height: 50, minZ: 0, maxZ: 0 },
            true,
          ],
          ['zero width', { x: 10, y: 20, width: 0, height: 50, minZ: 0, maxZ: 1 }, false],
        ]) {
          await renderer.present({
            id: 5,
            commands: [
              { ...clear, depth: 0.5 },
              { ...base, viewport },
            ],
          });
          checkPixels(`${path}: ${name}`, (x, y) =>
            visible && inside(x, y, viewport) ? drawn : bg,
          );
        }
        await renderer.present({
          id: 5,
          commands: [
            { ...clear, depth: 0 },
            { ...clear, clearColor: false, depth: 1, regions: [regionA, regionB] },
            base,
          ],
        });
        checkPixels(`${path}: depth-only clear and reset of clear scissor/viewport`, (x, y) =>
          inside(x, y, regionA) || inside(x, y, regionB) ? drawn : bg,
        );
        await renderer.present({
          id: 5,
          commands: [
            { ...clear, depth: 0 },
            { ...clear, clearDepth: false, color: 0xff00ff00, regions: [regionA] },
            base,
          ],
        });
        checkPixels(`${path}: color-only clear preserves depth`, (x, y) =>
          inside(x, y, regionA) ? green : bg,
        );
        await renderer.present({
          id: 5,
          commands: [
            clear,
            { ...base, viewport: { x: 0, y: 0, width: 20, height: 20, minZ: 0, maxZ: 1 } },
            { ...clear, regions: [], color: 0xff0000ff },
            { ...base, viewport: { x: 100, y: 100, width: 20, height: 20, minZ: 0, maxZ: 1 } },
          ],
        });
        checkPixels(`${path}: multiple draw viewports and empty clear`, (x, y) =>
          (x < 20 && y < 20) || (x >= 100 && y >= 100 && x < 120 && y < 120) ? drawn : bg,
        );
      }
      for (const command of [
        { ...clear, regions: [{ x: 129, y: 0, width: 2, height: 1 }] },
        { ...clear, regions: Array(257).fill(regionA) },
        { ...draw(0.25, 0xffff0000), viewport: { ...regionA, minZ: 1, maxZ: 0 } },
      ]) {
        let rejected = false;
        try {
          await renderer.present({ id: 5, commands: [command] });
        } catch {
          rejected = true;
        }
        if (!rejected) throw Error('Invalid viewport/rectangle command accepted');
      }
      await renderer.createDevice({ id: 6, windowId: 1, width: 130, height: 128, depth: false });
      await renderer.present({
        id: 6,
        commands: [
          { ...clear, clearDepth: false },
          { ...clear, clearDepth: false, color: 0xff0000ff, regions: [regionA] },
        ],
      });
      checkPixels('partial clear without depth attachment', (x, y) =>
        inside(x, y, regionA) ? blue : bg,
      );
      return {
        scope:
          'WebGPU backend geometry/depth/transform tests, separate from Windows executable acceptance',
        frames: initialFrames,
        submittedFrames,
        draws,
        flipped,
        copied,
        quantizedDraw,
        rasterCases,
        viewportCases,
        pacedIntervals: times.slice(1).map((time, i) => time - times[i]),
        presentationMode: renderer.presentationMode,
        fallbackAdapter: renderer.fallbackAdapter,
        logs,
        cases,
      };
    } finally {
      renderer.dispose();
    }
  }, forceReadback);
  assert.equal(
    report.presentationMode,
    forceReadback || report.fallbackAdapter ? 'readback' : 'canvas',
  );
  assert.ok(report.logs.some((line) => line.includes(`${report.presentationMode} presentation`)));
  assert.deepEqual(
    report.frames.map((f) => f.center),
    [
      [255, 0, 0, 255],
      [0, 0, 255, 255],
      [37, 45, 65, 255],
      [255, 128, 64, 255],
      [64, 128, 191, 255],
    ],
  );
  assert.ok(
    report.frames.every((f) => JSON.stringify(f.corner) === JSON.stringify([37, 45, 65, 255])),
  );
  assert.equal(report.submittedFrames, 5);
  assert.equal(report.draws, 7);
  assert.deepEqual(
    report.flipped.map((f) => f.corner),
    [
      [123, 65, 33, 255],
      [16, 53, 82, 255],
      [123, 65, 33, 255],
      [16, 53, 82, 255],
    ],
  );
  assert.deepEqual(
    report.copied.map((f) => f.corner),
    [
      [18, 52, 86, 255],
      [18, 52, 86, 255],
    ],
  );
  assert.deepEqual(report.quantizedDraw[0].center, [123, 65, 33, 255]);
  for (const c of report.rasterCases) {
    const visible = c.depthCompare
      ? {
          never: false,
          less: c.incoming < c.stored,
          equal: c.incoming === c.stored,
          'less-equal': c.incoming <= c.stored,
          greater: c.incoming > c.stored,
          'not-equal': c.incoming !== c.stored,
          'greater-equal': c.incoming >= c.stored,
          always: true,
        }[c.depthCompare]
      : // Base triangle is counterclockwise; swapping two vertices reverses it.
        c.cullMode === 'none' || c.cullMode === (c.reversed ? 'ccw' : 'cw');
    const color = c.path === 'fixed' ? [255, 0, 0, 255] : [255, 128, 64, 255];
    assert.deepEqual(c.pixel, visible ? color : [37, 45, 65, 255], JSON.stringify(c));
  }
  assert.ok(
    report.pacedIntervals.every((ms) => ms >= 14),
    'interval ONE paces the virtual display',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    forceReadback
      ? 'evidence/webgpu-backend-readback-results.json'
      : 'evidence/webgpu-backend-results.json',
    JSON.stringify(
      { ...report, date: new Date().toISOString(), browser: await browser.version(), passed: true },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
