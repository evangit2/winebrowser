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
  browser = await chromium.launch(webgpuBrowserOptions);
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/desktop-controls.html`,
  );
  const report = await page.evaluate(async (forceReadback) => {
    const { WebGPURenderer } = await import('/src/webgpu-renderer.js');
    const canvas = new OffscreenCanvas(32, 32),
      context = canvas.getContext('2d'),
      cases = [];
    const renderer = new WebGPURenderer({
      forceReadback,
      emit(m) {
        if (m.type === 'frame') {
          context.drawImage(m.bitmap, 0, 0);
          m.bitmap.close();
        }
      },
    });
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const source = [179, 67, 113, 99],
      background = [53, 139, 197, 151],
      constant = [83, 171, 47, 119];
    const argb = (c) => ((c[3] << 24) | (c[0] << 16) | (c[1] << 8) | c[2]) >>> 0;
    const clear = {
      type: 'clear',
      clearColor: true,
      clearDepth: true,
      clearStencil: false,
      depth: 1,
      stencil: 0,
      color: argb(background),
    };
    const make = (blend = {}, colors = [source], extra = {}) => {
      const vertices = new Uint8Array(colors.length * 48),
        data = new DataView(vertices.buffer);
      colors.forEach((color, t) =>
        [
          [-1, -1, 0.5],
          [3, -1, 0.5],
          [-1, 3, 0.5],
        ].forEach((p, i) => {
          p.forEach((n, j) => data.setFloat32(t * 48 + i * 16 + j * 4, n, true));
          data.setUint32(t * 48 + i * 16 + 12, argb(color), true);
        }),
      );
      return {
        type: 'draw',
        vertices,
        vertexCount: colors.length * 3,
        stride: 16,
        fvf: 0x42,
        world: identity,
        view: identity,
        projection: identity,
        cullMode: 'none',
        depthTest: false,
        depthWrite: false,
        blend,
        ...extra,
      };
    };
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    const clamp = (n) => Math.max(0, Math.min(1, n));
    const store = (c, format, dither = false, x = 0, y = 0) =>
      c.map((v, i) => {
        if (format !== 23) return Math.round(clamp(v) * 255) / 255;
        if (i === 3) return 1;
        const levels = i === 1 ? 63 : 31,
          threshold = dither ? (bayer[(y % 4) * 4 + (x % 4)] + 0.5) / 16 : 0.5;
        return Math.floor(clamp(v) * levels + threshold) / levels;
      });
    // Independent CPU equations: destination remains in its logical attachment
    // precision between triangles, rather than feeding an 8-bit approximation.
    const reference = (source, destination, blend, format, dither = false, x = 0, y = 0) => {
      const s = source.map((n) => n / 255),
        d = destination.slice();
      if (format !== 21) d[3] = 1;
      let sf = blend[19] ?? 2,
        df = blend[20] ?? 1,
        op = blend[171] ?? 1;
      if (sf === 12) {
        sf = 5;
        df = 6;
      } else if (sf === 13) {
        sf = 6;
        df = 5;
      }
      const color = blend[193] ?? 0xffffffff,
        k = [(color >>> 16) & 255, (color >>> 8) & 255, color & 255, color >>> 24].map(
          (n) => n / 255,
        );
      const factor = (f, i) =>
        f === 1
          ? 0
          : f === 2
            ? 1
            : f === 3
              ? s[i]
              : f === 4
                ? 1 - s[i]
                : f === 5
                  ? s[3]
                  : f === 6
                    ? 1 - s[3]
                    : f === 7
                      ? d[3]
                      : f === 8
                        ? 1 - d[3]
                        : f === 9
                          ? d[i]
                          : f === 10
                            ? 1 - d[i]
                            : f === 11
                              ? i === 3
                                ? 1
                                : Math.min(s[3], 1 - d[3])
                              : f === 14
                                ? k[i]
                                : 1 - k[i];
      const result = s.map((v, i) => {
        if (!blend[27]) return v;
        const a = i === 3 && blend[206] ? (blend[207] ?? 2) : sf,
          b = i === 3 && blend[206] ? (blend[208] ?? 1) : df,
          o = i === 3 && blend[206] ? (blend[209] ?? 1) : op;
        if (o === 4) return Math.min(v, d[i]);
        if (o === 5) return Math.max(v, d[i]);
        const first = v * factor(a, i),
          second = d[i] * factor(b, i);
        return o === 1 ? first + second : o === 2 ? first - second : second - first;
      });
      const converted = store(result, format, dither, x, y),
        mask = blend[168] ?? 15;
      return converted.map((v, i) => (mask & (1 << i) ? v : destination[i]));
    };
    let format;
    const recreate = async (f, swapEffect = 1) => {
      renderer.destroyDevice({ id: 1 });
      format = f;
      await renderer.createDevice({
        id: 1,
        windowId: 1,
        width: 32,
        height: 32,
        depth: true,
        depthFormat: 'depth16unorm',
        colorFormat: f,
        swapEffect,
      });
    };
    const verify = async (name, expected) => {
      const texture =
        renderer.surfaces.get(1).colors[
          renderer.surfaces.get(1).swapEffect === 2 ? 1 - renderer.surfaces.get(1).colorIndex : 0
        ];
      const buffer = renderer.device.createBuffer({
        size: 8192,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      });
      const encoder = renderer.device.createCommandEncoder();
      encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: 256 }, [32, 32]);
      renderer.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const raw = new Uint8Array(buffer.getMappedRange()),
        display = context.getImageData(0, 0, 32, 32).data;
      let maxError = 0;
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) {
          const c = expected(x, y);
          for (let i = 0; i < (format === 21 ? 4 : 3); i++) {
            const rawIndex = renderer.format === 'bgra8unorm' && i < 3 ? 2 - i : i,
              want = Math.round(c[i] * 255),
              got = raw[y * 256 + x * 4 + rawIndex],
              delta = Math.abs(got - want);
            maxError = Math.max(maxError, delta);
            if (delta > (format === 23 ? 0 : 2))
              throw Error(
                `${name} format${format} (${x},${y}) channel${i}: raw${got} expected${want}`,
              );
            if (i < 3 && Math.abs(display[(y * 32 + x) * 4 + i] - want) > (format === 23 ? 0 : 2))
              throw Error(`${name}: presentation differs`);
          }
        }
      buffer.unmap();
      buffer.destroy();
      cases.push({ name, format, pixels: 1024, maxError });
    };
    const run = async (name, blend, colors = [source], extra = {}) => {
      try {
        await renderer.present({ id: 1, commands: [clear, make(blend, colors, extra)] });
      } catch (e) {
        throw Error(`${name} format${format}: ${e.message}`);
      }
      await verify(name, (x, y) =>
        colors.reduce(
          (d, s) => reference(s, d, blend, format, extra.dither, x, y),
          store(
            background.map((n) => n / 255),
            format,
          ),
        ),
      );
    };
    try {
      for (const f of [21, 22, 23]) {
        await recreate(f);
        await run('blend disabled retains unblended writes', { 19: 5, 20: 6 });
        for (const factor of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 14, 15]) {
          await run(`source factor ${factor}`, { 27: 1, 19: factor, 20: 6, 193: argb(constant) });
          await run(`destination factor ${factor}`, {
            27: 1,
            19: 5,
            20: factor,
            193: argb(constant),
          });
        }
        for (const factor of [12, 13])
          await run(`obsolete source override ${factor}`, { 27: 1, 19: factor, 20: 1 });
        for (let op = 1; op <= 5; op++)
          await run(`operation ${op}`, { 27: 1, 19: 5, 20: 6, 171: op });
        for (let mask = 0; mask < 16; mask++)
          await run(`write mask ${mask}`, { 27: 1, 19: 5, 20: 6, 168: mask });
        for (let op = 1; op <= 5; op++)
          await run(`separate alpha operation ${op}`, {
            27: 1,
            19: 5,
            20: 6,
            206: 1,
            207: 14,
            208: 10,
            209: op,
            193: argb(constant),
          });
        await run('two overlapping primitives in one draw', { 27: 1, 19: 5, 20: 6 }, [
          source,
          [37, 213, 71, 123],
        ]);
        await run(
          'three overlapping dithered primitives',
          { 27: 1, 19: 5, 20: 6 },
          [source, [37, 213, 71, 123], source],
          { dither: true },
        );
        const blend = { 27: 1, 19: 14, 20: 15, 193: argb(constant) },
          other = { ...blend, 193: 0x571d5bab };
        const left = make(blend, [source], {
            viewport: { x: 0, y: 0, width: 16, height: 32, minZ: 0, maxZ: 1 },
          }),
          right = make(other, [source], {
            viewport: { x: 16, y: 0, width: 16, height: 32, minZ: 0, maxZ: 1 },
          });
        await renderer.present({ id: 1, commands: [clear, left, right] });
        await verify('per-draw blend constants and viewports', (x, y) =>
          reference(
            source,
            store(
              background.map((n) => n / 255),
              f,
            ),
            x < 16 ? blend : other,
            f,
            false,
            x,
            y,
          ),
        );
        const depthDraw = (z, color) =>
          make({ 27: 1, 19: 5, 20: 6 }, [color], {
            depthTest: true,
            depthWrite: true,
            world: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z - 0.5, 1],
          });
        await renderer.present({
          id: 1,
          commands: [
            clear,
            depthDraw(0.25, source),
            depthDraw(0.75, [255, 0, 0, 255]),
            depthDraw(0.1, [37, 213, 71, 123]),
          ],
        });
        await verify('rejected depth fragments leave blend destination intact', () =>
          [source, [37, 213, 71, 123]].reduce(
            (d, s) => reference(s, d, { 27: 1, 19: 5, 20: 6 }, f),
            store(
              background.map((n) => n / 255),
              f,
            ),
          ),
        );
        const { defaultSampler, defaultStage } = await import('/src/d3d-texture-state.js');
        const textured = make({ 27: 1, 19: 5, 20: 6 }, [[255, 255, 255, 255]]);
        const packed = new Uint8Array(72);
        for (let i = 0; i < 3; i++)
          packed.set(textured.vertices.subarray(i * 16, i * 16 + 16), i * 24);
        textured.vertices = packed;
        textured.stride = 24;
        textured.fvf = 0x142;
        textured.texturing = {
          texture: {
            id: 17,
            revision: 0,
            levels: [{ width: 1, height: 1, rgba: new Uint8Array(source) }],
          },
          sampler: defaultSampler(),
          stage: defaultStage(),
          lod: 0,
        };
        await renderer.present({ id: 1, commands: [clear, textured] });
        await verify('sampled texture alpha reaches framebuffer blending', () =>
          reference(
            source,
            store(
              background.map((n) => n / 255),
              f,
            ),
            textured.blend,
            f,
          ),
        );
        const empty = make({ 27: 1, 19: 5, 20: 6 }, [source], {
          viewport: { x: 7, y: 4, width: 0, height: 9, minZ: 0, maxZ: 1 },
        });
        await renderer.present({ id: 1, commands: [clear, empty] });
        await verify('empty viewport makes no blend writes', () =>
          store(
            background.map((n) => n / 255),
            f,
          ),
        );
        const gradient = make({ 27: 1, 19: 5, 20: 6 }),
          gradientData = new DataView(gradient.vertices.buffer);
        const alphas = [31, 127, 239];
        for (let i = 0; i < 3; i++)
          gradientData.setUint32(i * 16 + 12, argb([...source.slice(0, 3), alphas[i]]), true);
        await renderer.present({ id: 1, commands: [clear, gradient] });
        await verify('interpolated per-pixel source alpha', (x, y) => {
          const b = (x + 0.5) / 64,
            c = (31.5 - y) / 64,
            alpha = (1 - b - c) * alphas[0] + b * alphas[1] + c * alphas[2];
          return reference(
            [...source.slice(0, 3), alpha],
            store(
              background.map((n) => n / 255),
              f,
            ),
            gradient.blend,
            f,
          );
        });
        // Clear ignores guest blending and write masks, including partial clears.
        await renderer.present({
          id: 1,
          commands: [
            clear,
            make({ 27: 1, 19: 5, 20: 6, 168: 0 }),
            { ...clear, color: 0xff203040, regions: [{ x: 8, y: 8, width: 16, height: 16 }] },
          ],
        });
        await verify('partial clear ignores blending and write mask', (x, y) =>
          store(
            (x >= 8 && x < 24 && y >= 8 && y < 24 ? [32, 48, 64, 255] : background).map(
              (n) => n / 255,
            ),
            f,
          ),
        );
      }
      // Exercise translated-shader output wrapping with discard and explicit
      // depth. Controlled WGSL isolates raster behavior from compiler tests.
      renderer.programmable.compiler = {
        async compileLegacyPair() {
          return {
            vertex: {
              wgsl: `@vertex fn main(@location(0) p:vec3<f32>,@location(1) bgra:vec4<f32>)->@builtin(position) vec4<f32>{return vec4(p,1.0);}`,
            },
            pixel: {
              wgsl: `struct Result{@location(0) color:vec4<f32>,@builtin(frag_depth) depth:f32,}
          @fragment fn main(@builtin(position) p:vec4<f32>)->Result{if(p.x<16.0){discard;}return Result(vec4(0.4,0.2,0.8,0.3),0.2);}`,
            },
          };
        },
      };
      await recreate(23);
      for (const constantFactor of [false, true]) {
        const blend = { 27: 1, 19: constantFactor ? 14 : 5, 20: 6, 193: argb(constant) };
        const programmable = {
          ...make(blend),
          type: 'draw-programmable',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'unorm8x4' },
          ],
          vertexShaderId: 1,
          pixelShaderId: 2,
          vertexShader: new Uint8Array(4),
          pixelShader: new Uint8Array(4),
          vertexConstants: new Float32Array(1024),
          pixelConstants: new Float32Array(896),
          depthTest: true,
          depthWrite: true,
        };
        const behind = make({ 27: 1, 19: 5, 20: 6 }, [source], {
          depthTest: true,
          depthWrite: true,
        });
        await renderer.present({ id: 1, commands: [clear, programmable, behind] });
        await verify(
          `programmable discard/depth with ${constantFactor ? 'constant' : 'alpha'} blending`,
          (x) =>
            reference(
              x < 16 ? source : [102, 51, 204, 76.5],
              store(
                background.map((n) => n / 255),
                23,
              ),
              x < 16 ? behind.blend : blend,
              23,
            ),
        );
      }
      await recreate(23, 2);
      await renderer.present({ id: 1, commands: [clear, make({ 27: 1, 19: 5, 20: 6 })] });
      const old = reference(
        source,
        store(
          background.map((n) => n / 255),
          23,
        ),
        { 27: 1, 19: 5, 20: 6 },
        23,
      );
      await renderer.present({ id: 1, commands: [{ ...clear, color: 0xff000000 }] });
      await renderer.present({ id: 1, commands: [make({ 27: 1, 19: 5, 20: 6 })] });
      await verify('flip preserves correct previous buffer', () =>
        reference(source, old, { 27: 1, 19: 5, 20: 6 }, 23),
      );
      return {
        passed: true,
        presentation: renderer.presentationMode,
        cases,
        pixels: cases.length * 1024,
        frames: renderer.frames,
      };
    } finally {
      renderer.dispose();
    }
  }, forceReadback);
  assert.deepEqual(errors, []);
  await writeFile(
    `evidence/d3d-blending-backend${forceReadback ? '-readback' : ''}.json`,
    JSON.stringify(
      { ...report, browser: browser.version(), date: new Date().toISOString() },
      null,
      2,
    ) + '\n',
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
