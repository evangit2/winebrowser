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
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(
    `http://127.0.0.1:${server.httpServer.address().port}/tests/fixtures/desktop-controls.html`,
  );
  const report = await page.evaluate(async (forceReadback) => {
    const { WebGPURenderer } = await import('/src/webgpu-renderer.js');
    const { defaultSampler, defaultStage } = await import('/src/d3d-texture-state.js');
    const canvas = new OffscreenCanvas(64, 64),
      context = canvas.getContext('2d');
    const renderer = new WebGPURenderer({
      forceReadback,
      emit(m) {
        if (m.type === 'frame') {
          context.drawImage(m.bitmap, 0, 0);
          m.bitmap.close();
        }
      },
    });
    const cases = [],
      identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const colors = [
      [255, 0, 0, 255],
      [0, 255, 0, 128],
      [0, 0, 255, 64],
      [255, 255, 255, 0],
    ];
    const texture = {
      id: 1,
      revision: 0,
      levels: [{ width: 2, height: 2, rgba: new Uint8Array(colors.flat()) }],
    };
    const makeDraw = (
      t = texture,
      sampler = {},
      stage = {},
      scale = 1,
      offset = 0,
      diffuse = 0xffffffff,
      lod = 0,
    ) => {
      const bytes = new Uint8Array(72),
        v = new DataView(bytes.buffer);
      [
        [-1, -1, 0, 1],
        [3, -1, 2, 1],
        [-1, 3, 0, -1],
      ].forEach(([x, y, u, w], i) => {
        [x, y, 0.5].forEach((n, j) => v.setFloat32(i * 24 + j * 4, n, true));
        v.setUint32(i * 24 + 12, diffuse, true);
        v.setFloat32(i * 24 + 16, u * scale + offset, true);
        v.setFloat32(i * 24 + 20, w * scale + offset, true);
      });
      return {
        type: 'draw',
        vertices: bytes,
        vertexCount: 3,
        stride: 24,
        fvf: 0x142,
        world: identity,
        view: identity,
        projection: identity,
        depthTest: false,
        depthWrite: false,
        cullMode: 'none',
        texturing: {
          texture: t,
          sampler: { ...defaultSampler(), ...sampler },
          stage: { ...defaultStage(), ...stage },
          lod,
        },
      };
    };
    const clear = {
      type: 'clear',
      clearColor: true,
      clearDepth: false,
      clearStencil: false,
      color: 0xff102030,
      depth: 1,
      stencil: 0,
    };
    const check = (name, expected, tolerance = 1) => {
      const data = context.getImageData(0, 0, 64, 64).data;
      let maxError = 0;
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++) {
          const want = expected(x, y);
          for (let c = 0; c < 3; c++) {
            const delta = Math.abs(data[(y * 64 + x) * 4 + c] - want[c]);
            maxError = Math.max(delta, maxError);
            if (delta > tolerance)
              throw Error(
                `${name} (${x},${y}) channel ${c}: got ${data[(y * 64 + x) * 4 + c]}, expected ${want[c]}`,
              );
          }
          if (data[(y * 64 + x) * 4 + 3] !== 255) throw Error('Non-opaque presented alpha');
        }
      cases.push({ name, pixels: 4096, maxError });
    };
    const address = (n, size, mode) =>
      mode === 3
        ? Math.max(0, Math.min(n, size - 1))
        : mode === 1
          ? ((n % size) + size) % size
          : ((n % (size * 2)) + size * 2) % (size * 2) < size
            ? ((n % (size * 2)) + size * 2) % (size * 2)
            : size * 2 - 1 - (((n % (size * 2)) + size * 2) % (size * 2));
    const sample = (u, v, mode, linear) => {
      const at = (x, y) => colors[address(y, 2, mode) * 2 + address(x, 2, mode)];
      if (!linear) return at(Math.floor(u * 2), Math.floor(v * 2));
      const x = u * 2 - 0.5,
        y = v * 2 - 0.5,
        ix = Math.floor(x),
        iy = Math.floor(y),
        tx = x - ix,
        ty = y - iy;
      return [0, 1, 2, 3].map(
        (c) =>
          (at(ix, iy)[c] * (1 - tx) + at(ix + 1, iy)[c] * tx) * (1 - ty) +
          (at(ix, iy + 1)[c] * (1 - tx) + at(ix + 1, iy + 1)[c] * tx) * ty,
      );
    };
    const quantize = (c, format) =>
      format === 23
        ? c.map((n, i) =>
            Math.round((Math.round((n * (i === 1 ? 63 : 31)) / 255) * 255) / (i === 1 ? 63 : 31)),
          )
        : c.map(Math.round);
    try {
      for (const format of [22, 23]) {
        await renderer.createDevice({
          id: 1,
          windowId: 1,
          width: 64,
          height: 64,
          depth: false,
          colorFormat: format,
        });
        for (const mode of [1, 2, 3])
          for (const filter of [1, 2]) {
            const command = makeDraw(texture, { 1: mode, 2: mode, 5: filter }, { 1: 2 }, 3, -1);
            await renderer.present({ id: 1, commands: [clear, command] });
            check(`format${format}/address${mode}/mag${filter}`, (x, y) =>
              quantize(
                sample(
                  ((x + 0.5) * 3) / 64 - 1,
                  ((y + 0.5) * 3) / 64 - 1,
                  mode,
                  filter === 2,
                ).slice(0, 3),
                format,
              ),
            );
          }
        for (const [op, args] of [
          [2, [2, 0]],
          [3, [2, 0]],
          [4, [2, 0]],
          [7, [2, 0]],
          [2, [0x12, 0]],
          [2, [0x22, 0]],
          [2, [0x32, 0]],
        ]) {
          const command = makeDraw(
            texture,
            {},
            { 1: op, 2: args[0], 3: args[1] },
            1,
            0,
            0xff4080c0,
          );
          await renderer.present({ id: 1, commands: [clear, command] });
          check(`format${format}/operation${op}/arg${args[0]}`, (x, y) => {
            const c = colors[(y >= 32 ? 2 : 0) + (x >= 32 ? 1 : 0)];
            let a = args[0] & 32 ? [c[3], c[3], c[3]] : c.slice(0, 3);
            if (args[0] & 16) a = a.map((n) => 255 - n);
            const diffuse = [64, 128, 192];
            const result = a.map((n, i) =>
              op === 2
                ? n
                : op === 3
                  ? diffuse[i]
                  : op === 4
                    ? (n * diffuse[i]) / 255
                    : Math.min(255, n + diffuse[i]),
            );
            return quantize(result, format);
          });
        }
        const empty = makeDraw(null, {}, { 1: 2, 2: 0x10 }, 1, 0, 0xff4080c0);
        await renderer.present({ id: 1, commands: [clear, empty] });
        check(`format${format}/unbound-diffuse-complement`, () => quantize([191, 127, 63], format));
        renderer.destroyDevice({ id: 1 });
      }
      await renderer.createDevice({ id: 1, windowId: 1, width: 64, height: 64, depth: false });
      const mipColors = [
        [240, 16, 16, 255],
        [16, 240, 16, 255],
        [16, 16, 240, 255],
        [200, 200, 40, 255],
        [16, 200, 200, 255],
        [200, 16, 200, 255],
        [128, 128, 128, 255],
      ];
      const mipTexture = {
        id: 2,
        revision: 0,
        levels: mipColors.map((c, i) => ({
          width: 64 >> i,
          height: 64 >> i,
          rgba: new Uint8Array(Array.from({ length: (64 >> i) ** 2 }, () => c).flat()),
        })),
      };
      const bits = (n) => new Uint32Array(new Float32Array([n]).buffer)[0];
      for (const [name, sampler, lod, expected] of [
        ['point-base', { 7: 1 }, 0, mipColors[0]],
        ['point-bias2', { 7: 1, 8: bits(2) }, 0, mipColors[2]],
        ['point-negative-bias', { 7: 1, 8: bits(-2) }, 0, mipColors[0]],
        ['linear-half-lod', { 7: 2, 8: bits(0.5) }, 0, [128, 128, 16]],
        ['none-ignores-bias-and-maxlevel', { 7: 0, 8: bits(2), 9: 2 }, 0, mipColors[0]],
        ['point-maxlevel', { 7: 1, 9: 2 }, 0, mipColors[2]],
        ['managed-lod', { 7: 0 }, 2, mipColors[2]],
      ]) {
        await renderer.present({
          id: 1,
          commands: [clear, makeDraw(mipTexture, sampler, { 1: 2 }, 1, 0, 0xffffffff, lod)],
        });
        check(name, () => expected, 2);
      }
      const dense = {
        id: 3,
        revision: 0,
        levels: [{ width: 128, height: 128, rgba: new Uint8Array(128 * 128 * 4) }],
      };
      for (let y = 0; y < 128; y++)
        for (let x = 0; x < 128; x++)
          dense.levels[0].rgba.set(
            (x + y) % 2 ? [0, 0, 255, 255] : [255, 0, 0, 255],
            (y * 128 + x) * 4,
          );
      for (const filter of [1, 2])
        for (const mip of [0, 1, 2]) {
          await renderer.present({
            id: 1,
            commands: [clear, makeDraw(dense, { 6: filter, 7: mip }, { 1: 2 })],
          });
          check(`minification-filter${filter}/mip${mip}`, () =>
            filter === 1 ? [255, 0, 0] : [128, 0, 128],
          );
        }
      // Inspect persistent attachment alpha, which the opaque window intentionally hides.
      for (const [op, arg] of [
        [2, 2],
        [3, 2],
        [4, 2],
        [7, 2],
        [2, 0x12],
      ]) {
        await renderer.present({
          id: 1,
          commands: [clear, makeDraw(texture, {}, { 4: op, 5: arg, 6: 0 }, 1, 0, 0x80ffffff)],
        });
        const read = renderer.device.createBuffer({
          size: 16384,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });
        const encoder = renderer.device.createCommandEncoder();
        encoder.copyTextureToBuffer(
          { texture: renderer.surfaces.get(1).colors[0] },
          { buffer: read, bytesPerRow: 256 },
          [64, 64],
        );
        renderer.device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);
        const data = new Uint8Array(read.getMappedRange());
        let maxError = 0;
        for (let y = 0; y < 64; y++)
          for (let x = 0; x < 64; x++) {
            let a = colors[(y >= 32 ? 2 : 0) + (x >= 32 ? 1 : 0)][3];
            if (arg & 16) a = 255 - a;
            const expected =
              op === 2
                ? a
                : op === 3
                  ? 128
                  : op === 4
                    ? Math.round((a * 128) / 255)
                    : Math.min(255, a + 128);
            maxError = Math.max(maxError, Math.abs(data[(y * 64 + x) * 4 + 3] - expected));
          }
        read.unmap();
        read.destroy();
        if (maxError > 1) throw Error(`Alpha operation ${op}/${arg}: error ${maxError}`);
        cases.push({ name: `attachment-alpha-op${op}-arg${arg}`, pixels: 4096, maxError });
      }
      // XYZRHW carries reciprocal W. Perspective UV interpolation must use
      // RHW weights, rather than treating RHW itself as clip-space W.
      const transformed = makeDraw(texture, {}, { 1: 2 });
      transformed.fvf = 0x144;
      transformed.stride = 28;
      transformed.vertices = new Uint8Array(84);
      const screen = new DataView(transformed.vertices.buffer),
        rhws = [1, 0.5, 0.25];
      [
        [0, 64, 0, 1],
        [128, 64, 2, 1],
        [0, -64, 0, -1],
      ].forEach(([x, y, u, v], index) => {
        [x, y, 0.5, rhws[index]].forEach((value, component) =>
          screen.setFloat32(index * 28 + component * 4, value, true),
        );
        screen.setUint32(index * 28 + 16, 0xffffffff, true);
        screen.setFloat32(index * 28 + 20, u, true);
        screen.setFloat32(index * 28 + 24, v, true);
      });
      transformed.projection = [1 / 32, 0, 0, 0, 0, -1 / 32, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1];
      await renderer.present({ id: 1, commands: [clear, transformed] });
      check('XYZRHW perspective uses reciprocal W', (x, y) => {
        const b = (x + 0.5) / 128,
          c = (64 - y - 0.5) / 128,
          a = 1 - b - c;
        const denominator = a * rhws[0] + b * rhws[1] + c * rhws[2];
        return sample(
          (2 * b * rhws[1]) / denominator,
          (a * rhws[0] + b * rhws[1] - c * rhws[2]) / denominator,
          1,
          false,
        );
      });
      // Eight distinct bound textures, independent UV sets, CURRENT cascades,
      // and mixed 2D/volume/cube views exercise the advertised stage count.
      const multi = makeDraw(texture, {}, { 1: 2 });
      multi.fvf = 0x842 | (1 << 20); // TEX8, coordinate set 2 has three components.
      multi.stride = 84;
      multi.vertices = new Uint8Array(3 * multi.stride);
      const multiView = new DataView(multi.vertices.buffer);
      for (let vertex = 0; vertex < 3; vertex++) {
        multi.vertices.set(
          makeDraw().vertices.slice(vertex * 24, vertex * 24 + 16),
          vertex * multi.stride,
        );
        let offset = 16;
        for (let set = 0; set < 8; set++) {
          const u = [0, 2, 0][vertex],
            v = [1, 1, -1][vertex];
          const values = set === 2 ? [1, 0, 0] : set === 1 ? [1 - u, v] : [u, v];
          values.forEach((value) => {
            multiView.setFloat32(vertex * multi.stride + offset, value, true);
            offset += 4;
          });
        }
      }
      const stages = Array.from({ length: 8 }, (_, index) => ({
        texture:
          index < 2
            ? { ...texture, id: 100 + index }
            : {
                id: 100 + index,
                revision: 0,
                ...(index === 2 ? { dimension: 'cube' } : index === 3 ? { dimension: '3d' } : {}),
                levels: [
                  {
                    width: 1,
                    height: 1,
                    ...(index === 3 ? { depth: 1 } : {}),
                    rgba: new Uint8Array(
                      Array.from({ length: index === 2 ? 6 : 1 }, () => [
                        128, 128, 128, 255,
                      ]).flat(),
                    ),
                  },
                ],
              },
        stage: { ...defaultStage(), 11: index, 1: index === 0 ? 2 : 4, 2: 2, 3: 1 },
        sampler: defaultSampler(),
        lod: 0,
      }));
      multi.texturing = { ...stages[0], stages };
      await renderer.present({ id: 1, commands: [clear, multi] });
      check('eight mixed texture stages and independent coordinates', (x, y) => {
        const a = colors[(y >= 32 ? 2 : 0) + (x >= 32 ? 1 : 0)],
          b = colors[(y >= 32 ? 2 : 0) + (x < 32 ? 1 : 0)];
        return a.map((value, c) => ((value * b[c]) / 255) * (128 / 255) ** 6);
      });
      if (renderer.surfaces.get(1).textures.size !== 8)
        throw Error('Stage textures were not retained');
      // Use CURRENT alpha replicated and complemented in a later stage.
      const alphaStages = [
        { ...stages[0], stage: { ...stages[0].stage, 4: 2, 5: 0 } },
        { ...stages[1], stage: { ...stages[1].stage, 1: 2, 2: 0x31 } },
      ];
      const alpha = makeDraw(texture, {}, {}, 1, 0, 0x80402010);
      alpha.texturing = { ...alphaStages[0], stages: alphaStages };
      await renderer.present({ id: 1, commands: [clear, alpha] });
      check('later stage complement and alpha replicate use CURRENT', () => [127, 127, 127]);
      const revised = {
        ...texture,
        revision: 1,
        levels: [
          {
            width: 2,
            height: 2,
            rgba: new Uint8Array([
              255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 0, 255,
            ]),
          },
        ],
      };
      const left = makeDraw(texture, {}, { 1: 2 }),
        right = makeDraw(revised, {}, { 1: 2 });
      left.viewport = { x: 0, y: 0, width: 32, height: 64, minZ: 0, maxZ: 1 };
      right.viewport = { ...left.viewport, x: 32 };
      await renderer.present({ id: 1, commands: [clear, left, right] });
      check('two revisions of one texture in one frame', (x, y) =>
        x >= 32 ? [255, 255, 0] : colors[(y >= 32 ? 2 : 0) + (x >= 16 ? 1 : 0)],
      );
      if (renderer.surfaces.get(1).textures.size !== 2) throw Error('Unused mip texture retained');
      await renderer.present({ id: 1, commands: [clear] });
      if (renderer.surfaces.get(1).textures.size !== 0) throw Error('Unused GPU textures retained');
      const bad = makeDraw();
      bad.texturing.sampler[5] = 99;
      let rejected = false;
      try {
        await renderer.present({ id: 1, commands: [bad] });
      } catch (e) {
        rejected = /texture state/.test(e.message);
      }
      if (!rejected) throw Error('Malformed sampler accepted');
      return {
        passed: true,
        mode: renderer.presentationMode,
        cases,
        pixels: cases.length * 4096,
        frames: renderer.frames,
        draws: renderer.draws,
      };
    } finally {
      renderer.dispose();
    }
  }, forceReadback);
  assert.deepEqual(errors, []);
  await writeFile(
    `evidence/d3d-textures-backend${forceReadback ? '-readback' : ''}.json`,
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
