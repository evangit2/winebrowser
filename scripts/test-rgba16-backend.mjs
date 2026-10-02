import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { webgpuBrowserOptions } from './lib/webgpu-browser.mjs';
let server, browser;
try {
  server = await createServer({
    base: '/',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  browser = await chromium.launch(
    process.env.WINEBROWSER_NORMAL_CHROMIUM === '1' ? { headless: false } : webgpuBrowserOptions,
  );
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/desktop-controls.html`,
  );
  const forceReadback = process.argv.includes('--force-readback');
  const disabledFeature = process.argv.includes('--without-tier1')
    ? 'texture-formats-tier1'
    : process.argv.includes('--without-float32-filterable')
      ? 'float32-filterable'
      : null;
  const report = await page.evaluate(
    async ({ forceReadback, disabledFeature }) => {
      const { WebGPURenderer } = await import('/src/webgpu-renderer.js');
      const { defaultSampler, defaultStage } = await import('/src/d3d-texture-state.js');
      const gpu = disabledFeature
        ? {
            async requestAdapter() {
              const adapter = await navigator.gpu.requestAdapter();
              return {
                info: adapter.info,
                features: new Set(
                  [...adapter.features].filter((feature) => feature !== disabledFeature),
                ),
                requestDevice: (descriptor) => adapter.requestDevice(descriptor),
              };
            },
            getPreferredCanvasFormat: () => navigator.gpu.getPreferredCanvasFormat(),
          }
        : navigator.gpu;
      const renderer = new WebGPURenderer({ forceReadback, gpu }),
        gpuErrors = [],
        cases = [];
      try {
        await renderer.createDevice({ id: 1, windowId: 1, width: 32, height: 32, depth: false });
        renderer.device.addEventListener('uncapturederror', (e) => gpuErrors.push(e.error.message));
        const target = { id: 2, width: 5, height: 3, colorFormat: 36 };
        const supported = renderer.supportsRGBA16Unorm;
        // Exercise rejection even on a capable GPU. Unsupported devices must
        // fail before GPU allocation, rather than silently lose precision.
        renderer.supportsRGBA16Unorm = false;
        const rejectionErrors = [];
        for (const attempt of [
          () => renderer.targetSurface(renderer.surfaces.get(1), target),
          () => renderer.textures.validateFormat({ format: 'rgba16unorm' }),
        ]) {
          try {
            attempt();
          } catch (error) {
            rejectionErrors.push(error.message);
          }
        }
        renderer.supportsRGBA16Unorm = supported;
        const rejection = {
          rejectionErrors,
          targetCount: renderer.surfaces.get(1).targets.size,
          targetBytes: renderer.surfaces.get(1).targetBytes ?? 0,
        };
        if (!supported)
          return {
            supported: false,
            deviceFeatures: [...renderer.device.features],
            rejection,
            gpuErrors,
          };
        const clear = {
          type: 'clear',
          clearColor: true,
          clearDepth: false,
          clearStencil: false,
          color: 0xff010203,
          depth: 1,
          stencil: 0,
        };
        const values = (bytes) => [
          ...new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2),
        ];
        const pixels = await renderer.render({
          id: 1,
          target,
          depth: null,
          readback: true,
          commands: [clear],
        });
        cases.push({
          name: 'clear-and-padded-row-readback',
          values: values(pixels),
          expected: [257, 514, 771, 65535],
        });
        const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
        const texels = new Uint16Array([
          0x1234, 0x2345, 0x3456, 0x4567, 0x3234, 0x4345, 0x5456, 0x6567,
        ]);
        const texture = {
          id: 3,
          revision: 0,
          format: 'rgba16unorm',
          levels: [{ width: 2, height: 1, rgba: new Uint8Array(texels.buffer) }],
        };
        const vertices = new Uint8Array(72),
          v = new DataView(vertices.buffer);
        const positions = [
          [-1, -1],
          [3, -1],
          [-1, 3],
        ];
        positions.forEach(([x, y], i) => {
          v.setFloat32(i * 24, x, true);
          v.setFloat32(i * 24 + 4, y, true);
          v.setFloat32(i * 24 + 8, 0.5, true);
          v.setUint32(i * 24 + 12, 0xffffffff, true);
          v.setFloat32(i * 24 + 16, 0.5, true);
          v.setFloat32(i * 24 + 20, 0.5, true);
        });
        const sampler = { ...defaultSampler(), 5: 2, 6: 2 },
          expected = [0x2234, 0x3345, 0x4456, 0x5567];
        const fixed = {
          type: 'draw',
          vertices,
          vertexCount: 3,
          stride: 24,
          fvf: 0x142,
          world: identity,
          view: identity,
          projection: identity,
          depthTest: false,
          depthWrite: false,
          cullMode: 'none',
          texturing: { texture, sampler, stage: defaultStage(), lod: 0 },
        };
        cases.push({
          name: 'fixed-function-linear-sampling',
          expected,
          values: values(
            await renderer.render({
              id: 1,
              target,
              depth: null,
              readback: true,
              commands: [fixed],
            }),
          ),
        });
        const programmableVertices = new Float32Array(24);
        positions.forEach(([x, y], i) =>
          programmableVertices.set([x, y, 0.5, 1, 0.5, 0.5, 0, 1], i * 8),
        );
        const tokens = (words) => new Uint8Array(new Uint32Array(words).buffer);
        const programmable = {
          type: 'draw-programmable',
          vertices: new Uint8Array(programmableVertices.buffer),
          vertexCount: 3,
          stride: 32,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x4' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' },
          ],
          vertexShader: tokens([
            0xfffe0101, 0x0000001f, 0x80000000, 0x900f0000, 0x0000001f, 0x80000005, 0x900f0001, 1,
            0xc00f0000, 0x90e40000, 1, 0xe00f0000, 0x90e40001, 0xffff,
          ]),
          pixelShader: tokens([
            0xffff0200, 0x0200001f, 0x80000000, 0xb00f0000, 0x0200001f, 0x90000000, 0xa00f0800,
            0x03000042, 0x800f0000, 0xb0e40000, 0xa0e40800, 0x02000001, 0x800f0800, 0x80e40000,
            0xffff,
          ]),
          vertexShaderId: 4,
          pixelShaderId: 5,
          vertexConstants: new Float32Array(1024),
          pixelConstants: new Float32Array(896),
          depthTest: false,
          depthWrite: false,
          cullMode: 'none',
          textures: new Map([[0, { snapshot: texture, sampler }]]),
        };
        cases.push({
          name: 'browser-compiled-legacy-shader-linear-sampling',
          expected,
          values: values(
            await renderer.render({
              id: 1,
              target,
              depth: null,
              readback: true,
              commands: [programmable],
            }),
          ),
        });
        await renderer.render({ id: 1, target, depth: null, readback: false, commands: [] });
        const bytesBeforeRelease = renderer.surfaces.get(1).targetBytes;
        renderer.destroyTarget({ id: 1, targetId: 2 });
        return {
          supported: true,
          rejection,
          cases,
          gpuErrors,
          bytesBeforeRelease,
          bytesAfterRelease: renderer.surfaces.get(1).targetBytes,
          featureEnabled: renderer.device.features.has('texture-formats-tier1'),
        };
      } finally {
        renderer.dispose();
      }
    },
    { forceReadback, disabledFeature },
  );
  assert.deepEqual(report.rejection.rejectionErrors, [
    'Invalid D3D offscreen target',
    'RGBA16 UNORM textures require WebGPU texture-formats-tier1 and float32-filterable',
  ]);
  assert.equal(report.rejection.targetCount, 0);
  assert.equal(report.rejection.targetBytes, 0);
  assert.deepEqual(report.gpuErrors, []);
  assert.deepEqual(errors, []);
  if (!report.supported) {
    const result = {
      status: 'unsupported-adapter',
      scope:
        'Rejection and allocation safety passed; RGBA16 rendering/precision checks did not run.',
      browser: browser.version(),
      date: new Date().toISOString(),
      disabledFeature,
      ...report,
    };
    await writeFile(
      'evidence/rgba16-backend-unsupported-results.json',
      JSON.stringify(result, null, 2) + '\n',
    );
    console.log(JSON.stringify(result, null, 2));
    assert.equal(
      process.env.WINEBROWSER_ALLOW_UNSUPPORTED_RGBA16,
      '1',
      'Precision acceptance requires texture-formats-tier1 and float32-filterable; only capability-only CI may permit this result',
    );
  } else {
    for (const { name, values, expected } of report.cases) {
      assert.equal(values.length, 5 * 3 * 4, name);
      for (const [i, value] of values.entries())
        assert.ok(
          Math.abs(value - expected[i % 4]) <= 1,
          `${name}, channel ${i}: ${value} expected ${expected[i % 4]}`,
        );
    }
    assert.equal(report.featureEnabled, true);
    assert.equal(report.bytesBeforeRelease, 5 * 3 * 8);
    assert.equal(report.bytesAfterRelease, 0);
    assert.deepEqual(report.gpuErrors, []);
    assert.deepEqual(errors, []);
    const result = {
      date: new Date().toISOString(),
      browser: browser.version(),
      normalChromium: process.env.WINEBROWSER_NORMAL_CHROMIUM === '1',
      forceReadback,
      ...report,
      errors,
    };
    await writeFile('evidence/rgba16-backend-results.json', JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  await browser?.close();
  await server?.close();
}
