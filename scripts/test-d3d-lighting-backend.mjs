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
    const { LIGHT_STATE_DEFAULTS } = await import('/src/d3d-lighting.js');
    const { fvfLayout } = await import('/src/d3d-fvf.js');
    const canvas = new OffscreenCanvas(64, 64),
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
    const material = (
      diffuse = [1, 1, 1, 1],
      ambient = [0, 0, 0, 0],
      specular = [0, 0, 0, 0],
      emissive = [0, 0, 0, 0],
      power = 0,
    ) => new Float32Array([...diffuse, ...ambient, ...specular, ...emissive, power]);
    const light = (
      type = 3,
      {
        diffuse = [0.5, 0.25, 0.125, 0],
        ambient = [0, 0, 0, 0],
        specular = [0, 0, 0, 0],
        position = [0, 0, -2],
        direction = [0, 0, 1],
        range = 10,
        falloff = 1,
        attenuation = [1, 0, 0],
        theta = 0.5,
        phi = 2.2,
      } = {},
    ) => {
      const value = new Float32Array([
        0,
        ...diffuse,
        ...specular,
        ...ambient,
        ...position,
        ...direction,
        range,
        falloff,
        ...attenuation,
        theta,
        phi,
      ]);
      new Uint32Array(value.buffer)[0] = type;
      return value;
    };
    const points = [
      [-1, -1, 0.5],
      [3, -1, 0.5],
      [-1, 3, 0.5],
    ];
    const make = (options = {}) => {
      const fvf = options.fvf ?? 0xd2,
        layout = fvfLayout(fvf),
        vertices = new Uint8Array(layout.size * 3),
        v = new DataView(vertices.buffer);
      for (let i = 0; i < 3; i++) {
        points[i].forEach((n, j) => v.setFloat32(i * layout.size + j * 4, n, true));
        if (layout.normal !== null)
          (options.normals?.[i] ?? [0, 0, -1]).forEach((n, j) =>
            v.setFloat32(i * layout.size + layout.normal + j * 4, n, true),
          );
        if (layout.diffuse !== null)
          v.setUint32(i * layout.size + layout.diffuse, options.color1 ?? 0xff4080c0, true);
        if (layout.specular !== null)
          v.setUint32(i * layout.size + layout.specular, options.color2 ?? 0xffc04080, true);
        if (layout.uv !== null) {
          v.setFloat32(i * layout.size + layout.uv, 0.5, true);
          v.setFloat32(i * layout.size + layout.uv + 4, 0.5, true);
        }
      }
      const states = { ...LIGHT_STATE_DEFAULTS, 145: 0, ...options.states };
      return {
        type: 'draw',
        vertices,
        vertexCount: 3,
        stride: layout.size,
        fvf,
        world: options.world ?? identity,
        view: options.view ?? identity,
        projection: options.projection ?? identity,
        depthTest: false,
        depthWrite: false,
        cullMode: 'none',
        specularEnable: !!states[29],
        lighting: options.unlit
          ? null
          : {
              states,
              material: options.material ?? material(),
              lights: options.lights ?? [light()],
            },
        ...options.command,
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
    const verify = (name, expected, format = 22) => {
      const data = context.getImageData(0, 0, 64, 64).data;
      let maxError = 0;
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++) {
          const color = expected(x, y);
          for (let c = 0; c < 3; c++) {
            const levels = c === 1 ? 63 : 31;
            const want =
              format === 23
                ? Math.round(
                    (Math.round(Math.min(1, Math.max(0, color[c])) * levels) * 255) / levels,
                  )
                : Math.round(Math.min(1, Math.max(0, color[c])) * 255);
            const delta = Math.abs(data[(y * 64 + x) * 4 + c] - want);
            maxError = Math.max(maxError, delta);
            if (delta > (format === 23 ? 0 : 2))
              throw Error(
                `${name}: (${x},${y}) channel${c} got${data[(y * 64 + x) * 4 + c]} expected${want}`,
              );
          }
        }
      cases.push({ name, pixels: 4096, maxError });
    };
    const run = async (name, command, expected, format = 22) => {
      try {
        await renderer.present({ id: 1, commands: [clear, command] });
      } catch (e) {
        throw Error(name + ': ' + e.message);
      }
      verify(name, expected, format);
    };
    // Independent CPU oracle evaluates each vertex's lighting equations, then
    // raster barycentrics. Directional cases also have hand-computed expectations.
    const norm = (v) => {
        const n = Math.hypot(...v);
        return n ? v.map((x) => x / n) : [0, 0, 0];
      },
      dot = (a, b) => a.reduce((n, x, i) => n + x * b[i], 0),
      sub = (a, b) => a.map((n, i) => n - b[i]);
    const reference = (l, m, states) => {
      const values = points.map((p) => {
        let diffuse = [0, 0, 0],
          ambient = [
            ((states[139] >>> 16) & 255) / 255,
            ((states[139] >>> 8) & 255) / 255,
            (states[139] & 255) / 255,
          ],
          specular = [0, 0, 0];
        for (const v of l) {
          const type = new Uint32Array(v.buffer)[0],
            n = [0, 0, -1];
          let toLight = norm([...v.slice(16, 19)].map((n) => -n)),
            factor = 1;
          if (type !== 3) {
            const delta = sub([...v.slice(13, 16)], p),
              d = Math.hypot(...delta);
            if (d > v[19]) continue;
            toLight = norm(delta);
            factor = 1 / (v[21] + v[22] * d + v[23] * d * d);
            if (type === 2) {
              const cosine = dot(toLight, norm([...v.slice(16, 19)].map((n) => -n))),
                inner = Math.cos(v[24] / 2),
                outer = Math.cos(v[25] / 2);
              factor *=
                cosine <= outer
                  ? 0
                  : cosine >= inner
                    ? 1
                    : ((cosine - outer) / (inner - outer)) ** v[20];
            }
          }
          const ndotl = dot(n, toLight),
            viewer = states[142] ? norm(p.map((n) => -n)) : [0, 0, -1],
            h = dot(n, norm(toLight.map((n, i) => n + viewer[i])));
          for (let c = 0; c < 3; c++) {
            ambient[c] += v[9 + c] * factor;
            diffuse[c] += v[1 + c] * Math.max(0, Math.min(1, ndotl)) * factor;
            if (states[29] && ndotl > 0 && h > 0) specular[c] += v[5 + c] * h ** m[16] * factor;
          }
        }
        return {
          diffuse: diffuse.map((n, c) =>
            Math.min(1, Math.max(0, m[12 + c] + m[4 + c] * ambient[c] + m[c] * n)),
          ),
          specular: specular.map((n, c) => Math.min(1, Math.max(0, m[8 + c] * n))),
        };
      });
      return (x, y) => {
        const b = [1 - (x + 0.5) / 128 - (63.5 - y) / 128, (x + 0.5) / 128, (63.5 - y) / 128];
        return [0, 1, 2].map((c) =>
          values.reduce((n, v, i) => n + (v.diffuse[c] + v.specular[c]) * b[i], 0),
        );
      };
    };
    try {
      await renderer.createDevice({
        id: 1,
        windowId: 1,
        width: 64,
        height: 64,
        depth: false,
        colorFormat: 22,
      });
      await run('directional diffuse', make(), () => [0.5, 0.25, 0.125]);
      await run('reversed normal', make({ normals: Array(3).fill([0, 0, 1]) }), () => [0, 0, 0]);
      await run(
        'ambient and emission without normals',
        make({
          fvf: 2,
          lights: [],
          states: { 139: 0xff804020 },
          material: material([0, 0, 0, 1], [0.5, 0.25, 1, 0], [0, 0, 0, 0], [0.1, 0.2, 0.3, 0]),
        }),
        () => [(128 / 255) * 0.5 + 0.1, (64 / 255) * 0.25 + 0.2, 32 / 255 + 0.3],
      );
      for (const source of [0, 1, 2]) {
        await run(`diffuse material source${source}`, make({ states: { 145: source } }), () =>
          source === 0
            ? [0.5, 0.25, 0.125]
            : source === 1
              ? [(64 / 255) * 0.5, (128 / 255) * 0.25, (192 / 255) * 0.125]
              : [(192 / 255) * 0.5, (64 / 255) * 0.25, (128 / 255) * 0.125],
        );
      }
      await run(
        'missing color source falls back to material',
        make({ fvf: 0x12, states: { 145: 2 } }),
        () => [0.5, 0.25, 0.125],
      );
      await run('COLORVERTEX disables vertex sources', make({ states: { 145: 2, 141: 0 } }), () => [
        0.5, 0.25, 0.125,
      ]);
      const scaled = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1],
        inverse = [0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1];
      await run(
        'inverse transpose normals without normalization',
        make({ world: scaled, projection: inverse }),
        () => [0.25, 0.125, 0.0625],
      );
      await run(
        'NORMALIZENORMALS restores unit normals',
        make({ world: scaled, projection: inverse, states: { 143: 1 } }),
        () => [0.5, 0.25, 0.125],
      );
      await run(
        'nonunit normals preserved when disabled',
        make({ normals: Array(3).fill([0, 0, -0.25]) }),
        () => [0.125, 0.0625, 0.03125],
      );
      for (const [name, lights] of [
        ['point attenuation', [light(1, { attenuation: [1, 0.2, 0.1] })]],
        ['point range', [light(1, { range: 3 })]],
        ['spot cone', [light(2)]],
        ['spot falloff', [light(2, { falloff: 3 })]],
        [
          'eight mixed lights',
          Array.from({ length: 8 }, (_, i) =>
            light((i % 3) + 1, {
              diffuse: [0.03, 0.02, 0.01, 0],
              ambient: [0.01, 0.02, 0.03, 0],
              attenuation: [1, 0.1, 0.2],
            }),
          ),
        ],
      ]) {
        const c = make({ lights, material: material([0.5, 0.6, 0.7, 1], [0.5, 0.25, 0.125, 0]) });
        await run(name, c, reference(lights, c.lighting.material, c.lighting.states));
      }
      for (const local of [0, 1]) {
        const c = make({
          states: { 29: 1, 142: local, 146: 0 },
          lights: [light(3, { diffuse: [0, 0, 0, 0], specular: [1, 0.5, 0.25, 0] })],
          material: material([0, 0, 0, 1], [0, 0, 0, 0], [0.5, 0.5, 0.5, 0], [0, 0, 0, 0], 8),
        });
        await run(
          `specular viewer${local}`,
          c,
          reference(c.lighting.lights, c.lighting.material, c.lighting.states),
        );
      }
      for (const source of [1, 2]) {
        const c = make({
          states: { 29: 1, 142: 0, 146: source },
          lights: [light(3, { diffuse: [0, 0, 0, 0], specular: [1, 1, 1, 0] })],
        });
        await run(`specular material source${source}`, c, () =>
          source === 1 ? [64 / 255, 128 / 255, 192 / 255] : [192 / 255, 64 / 255, 128 / 255],
        );
      }
      await run(
        'ambient vertex material source',
        make({ fvf: 0xc2, lights: [], states: { 139: 0xff808080, 147: 1 } }),
        () => [64, 128, 192].map((n) => ((n / 255) * 128) / 255),
      );
      await run(
        'emissive vertex material source',
        make({ fvf: 0xc2, lights: [], states: { 148: 2 } }),
        () => [192 / 255, 64 / 255, 128 / 255],
      );
      await run(
        'unlit vertex specular adds after diffuse',
        make({ unlit: true, states: { 29: 1 }, color1: 0xff202020, color2: 0xff4080c0 }),
        () => [96 / 255, 160 / 255, 224 / 255],
      );
      const { defaultSampler, defaultStage } = await import('/src/d3d-texture-state.js');
      const textured = make({
        fvf: 0x1d2,
        states: { 29: 1, 142: 0, 146: 0 },
        material: material(
          [1, 1, 1, 0.25],
          [0, 0, 0, 0],
          [0.25, 0.125, 0.0625, 0],
          [0, 0, 0, 0],
          8,
        ),
        lights: [light(3, { diffuse: [1, 1, 1, 0], specular: [1, 1, 1, 0] })],
      });
      textured.texturing = {
        texture: {
          id: 1,
          revision: 0,
          levels: [{ width: 1, height: 1, rgba: new Uint8Array([0, 0, 0, 255]) }],
        },
        sampler: defaultSampler(),
        stage: defaultStage(),
        lod: 0,
      };
      textured.texturing.stage[5] = 0; // Diffuse alpha comes from the lit material.
      await run('specular added after texture modulation', textured, () => [0.25, 0.125, 0.0625]);
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
      for (let i = 3; i < data.length; i += 4)
        if (data[i] !== 64) throw Error('Lit diffuse alpha must come from the material');
      read.unmap();
      read.destroy();
      await run(
        'camera rotation preserves directional lighting',
        make({
          view: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1],
          projection: [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1],
        }),
        () => [0.5, 0.25, 0.125],
      );
      const a = make(),
        b = make({ lights: [light(3, { diffuse: [0, 0.5, 0, 0] })] });
      a.viewport = { x: 0, y: 0, width: 32, height: 64, minZ: 0, maxZ: 1 };
      b.viewport = { ...a.viewport, x: 32 };
      await renderer.present({ id: 1, commands: [clear, a, b] });
      verify('queued lighting state stays per draw', (x) =>
        x < 32 ? [0.5, 0.25, 0.125] : [0, 0.5, 0],
      );
      renderer.destroyDevice({ id: 1 });
      await renderer.createDevice({
        id: 1,
        windowId: 1,
        width: 64,
        height: 64,
        depth: false,
        colorFormat: 23,
      });
      await run('RGB565 lit output', make(), () => [0.5, 0.25, 0.125], 23);
      return {
        passed: true,
        presentation: renderer.presentationMode,
        cases,
        pixels: cases.length * 4096,
        frames: renderer.frames,
      };
    } finally {
      renderer.dispose();
    }
  }, forceReadback);
  assert.deepEqual(errors, []);
  await writeFile(
    `evidence/d3d-lighting-backend${forceReadback ? '-readback' : ''}.json`,
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
