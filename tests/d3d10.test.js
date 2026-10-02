import test from 'node:test';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { d3d10Apis } from '../src/d3d10.js';
import { createWin32ApiProvider, importKey } from '../src/win32.js';
import { planStageBindings } from '../src/d3d10-bindings.js';
import { DESCRIPTOR_CBV, DESCRIPTOR_SAMPLER, DESCRIPTOR_SRV } from '../src/d3d12-bindings.js';

const IID = {
  device: '9b7e4c0f-342c-4106-a19f-4f2704f689f0',
  buffer: '9b7e4c02-342c-4106-a19f-4f2704f689f0',
  texture2d: '9b7e4c04-342c-4106-a19f-4f2704f689f0',
  renderTargetView: '9b7e4c08-342c-4106-a19f-4f2704f689f0',
  depthStencilView: '9b7e4c09-342c-4106-a19f-4f2704f689f0',
  vertexShader: '9b7e4c0a-342c-4106-a19f-4f2704f689f0',
  inputLayout: '9b7e4c0b-342c-4106-a19f-4f2704f689f0',
  samplerState: '9b7e4c0c-342c-4106-a19f-4f2704f689f0',
  pixelShader: '4968b601-9d00-4cde-8346-8e7f675819b6',
  blendState: 'edad8d19-8a35-4d6d-8566-2ea276cde161',
  depthStencilState: '2b4b1cc8-a4ad-41f8-8322-ca86fc3ec675',
  rasterizerState: 'a2a07292-89af-4345-be2e-c53d9fbb6e9f',
  shaderResourceView: '9b7e4c07-342c-4106-a19f-4f2704f689f0',
  swapchain: '310d36a0-d2e7-4c0a-aa04-6a9d23b8886a',
};

function fixture() {
  const buffer = new ArrayBuffer(4 * 1024 * 1024);
  const data = new Uint8Array(buffer),
    view = new DataView(buffer);
  let next = 0x1000;
  const events = [],
    freed = [];
  const runtime = {
    data,
    view,
    thunks: new Map(),
    windows: { windows: new Map([[0x20000, { width: 640, height: 480 }]]) },
    check(p, n) {
      if (!p || n < 1 || p + n > data.length) throw Error('Guest memory violation');
      return p;
    },
    allocate(n) {
      const p = next;
      next = (next + n + 3) & ~3;
      this.check(p, n);
      return p;
    },
    free(p) {
      freed.push(p);
      return true;
    },
    read32(p) {
      return view.getUint32(this.check(p, 4), true);
    },
    write32(p, v) {
      view.setUint32(this.check(p, 4), v >>> 0, true);
    },
    string(p) {
      let value = '';
      while (this.check(p, 1) && data[p]) value += String.fromCharCode(data[p++]);
      return value;
    },
    graphics12: {
      async createSwapChain(args) {
        events.push({ type: 'swapchain', ...args });
      },
      async destroySwapChain(args) {
        events.push({ type: 'destroySwapChain', ...args });
      },
      async createResource(args) {
        events.push({ type: 'resource', ...args });
      },
      async uploadTexture(args) {
        events.push({ type: 'uploadTexture', ...args });
      },
      async destroyResource(args) {
        events.push({ type: 'destroyResource', ...args });
      },
      async planD3D10Bindings(vertex, pixel) {
        events.push({ type: 'plan', vertex: [...vertex], pixel: [...pixel] });
        return { bindings: [], vertex: [], pixel: [], layout: null, groupLayouts: null };
      },
      async createPipeline(args) {
        events.push({ type: 'pipeline', ...args });
        return { bindings: [] };
      },
      destroyPipeline(args) {
        events.push({ type: 'destroyPipeline', ...args });
      },
      async execute(args) {
        events.push({ type: 'execute', ...args });
      },
      async present(args) {
        events.push({ type: 'present', ...args });
      },
    },
  };
  const alloc = (n = 4) => runtime.allocate(n);
  const guid = (text) => {
    const hex = text.replaceAll('-', '');
    const raw = Uint8Array.from(hex.match(/../g), (s) => parseInt(s, 16));
    const p = alloc(16);
    data.set([raw[3], raw[2], raw[1], raw[0], raw[5], raw[4], raw[7], raw[6], ...raw.slice(8)], p);
    return p;
  };
  const call = async (ptr, slot, ...args) => {
    const entry = runtime.thunks.get(runtime.read32(runtime.read32(ptr) + slot * 4));
    assert.equal(entry?.kind, 'com');
    return entry.invoke(runtime, (i) => [ptr, ...args][i]);
  };
  const api = async (name, ...args) => d3d10Apis['d3d10.dll!' + name](runtime, (i) => args[i]);
  return { runtime, events, freed, alloc, guid, call, api };
}

// A 60-byte DXGI_SWAP_CHAIN_DESC with the D3D10 discard effect.
function swapDesc(r, { format = 28, count = 2, effect = 0 } = {}) {
  const p = r.allocate(60);
  r.write32(p, 640);
  r.write32(p + 4, 480);
  r.write32(p + 16, format);
  r.write32(p + 28, 1);
  r.write32(p + 36, 0x20);
  r.write32(p + 40, count);
  r.write32(p + 44, 0x20000);
  r.write32(p + 48, 1);
  r.write32(p + 52, effect);
  return p;
}

function bufferDesc(r, size, bindFlags, usage = 0, cpuAccess = 0) {
  const p = r.allocate(20);
  r.write32(p, size);
  r.write32(p + 4, usage);
  r.write32(p + 8, bindFlags);
  r.write32(p + 12, cpuAccess);
  return p;
}

function create(r, call, guid, dev, slot, args, iidName, out) {
  const target = out ?? r.allocate(4);
  return call(dev, slot, ...args, guid(IID[iidName]), target).then((response) => ({
    response,
    pointer: r.read32(target),
  }));
}

test('D3D10CreateDeviceAndSwapChain binds a device, its back buffers and an ordered draw', async () => {
  const f = fixture(),
    { runtime: r, events, call, api, guid, alloc } = f;
  const swapOut = alloc(4),
    devOut = alloc(4);
  const response = await api(
    'D3D10CreateDeviceAndSwapChain',
    0,
    1,
    0,
    0x20,
    29,
    swapDesc(r),
    swapOut,
    devOut,
  );
  assert.equal(response.result, 0);
  const device = r.read32(devOut),
    chain = r.read32(swapOut);
  assert.ok(device && chain, 'both objects were created');
  const created = events.find((event) => event.type === 'swapchain');
  assert.equal(created.width, 640);
  assert.equal(created.height, 480);
  assert.equal(created.format, 'rgba8unorm');
  // Two back buffers are registered under their own object pointers, so the
  // render target the application draws into is the image presented.
  assert.equal(created.bufferIds.length, 2);

  const backBufferOut = alloc(4);
  assert.equal((await call(chain, 9, 0, guid(IID.texture2d), backBufferOut)).result, 0);
  const backBuffer = r.read32(backBufferOut);
  // CreateRenderTargetView(this, pResource, pDesc, ppRTView) has only four
  // slots, so the interface identity is the sz *view* one the object carries.
  const rtvOut = alloc(4);
  assert.equal((await call(device, 76, backBuffer, 0, rtvOut)).result, 0);
  const rtv = r.read32(rtvOut);

  // The depth texture is a real backend resource bound as a D16_UNORM target.
  const depthDesc = alloc(44);
  r.write32(depthDesc, 640);
  r.write32(depthDesc + 4, 480);
  r.write32(depthDesc + 8, 1);
  r.write32(depthDesc + 12, 1);
  r.write32(depthDesc + 16, 55);
  r.write32(depthDesc + 20, 1);
  r.write32(depthDesc + 32, 0x40);
  const depthOut = alloc(4);
  assert.equal((await call(device, 73, depthDesc, 0, depthOut)).result, 0);
  const depth = r.read32(depthOut);
  assert.deepEqual(
    events.find((event) => event.type === 'resource'),
    {
      type: 'resource',
      id: depth,
      kind: 'depth',
      width: 640,
      height: 480,
      format: 'depth16unorm',
    },
  );
  const dsvOut = alloc(4);
  assert.equal((await call(device, 77, depth, 0, dsvOut)).result, 0);
  const dsv = r.read32(dsvOut);

  // Geometry: an immutable 32-byte-stride vertex buffer and a 16-bit index
  // buffer with initial data, both copied straight into guest storage.
  // Four vertices at a 32-byte stride, so the 0..3 index range is in bounds.
  const vertexBytes = new Uint8Array(128);
  const vertexSource = alloc(128);
  r.data.set(vertexBytes, vertexSource);
  const vertexOut = alloc(4);
  assert.equal(
    (
      await call(
        device,
        71,
        bufferDesc(r, 128, 0x1, 1),
        (() => {
          const p = alloc(12);
          r.write32(p, vertexSource);
          return p;
        })(),
        vertexOut,
      )
    ).result,
    0,
  );
  const vertices = r.read32(vertexOut);
  const indexSource = alloc(12);
  // Six R16_UINT indices, little-endian: triangles (0,1,2) and (0,2,3).
  r.data.set([0, 0, 1, 0, 2, 0, 0, 0, 2, 0, 3, 0], indexSource);
  const indexOut = alloc(4);
  assert.equal(
    (
      await call(
        device,
        71,
        bufferDesc(r, 12, 0x2, 1),
        (() => {
          const p = alloc(12);
          r.write32(p, indexSource);
          return p;
        })(),
        indexOut,
      )
    ).result,
    0,
  );
  const indices = r.read32(indexOut);

  // A dynamic constant buffer the application maps and rewrites each frame.
  const matrixOut = alloc(4);
  assert.equal(
    (await call(device, 71, bufferDesc(r, 64, 0x4, 2, 0x10000), 0, matrixOut)).result,
    0,
  );
  const matrix = r.read32(matrixOut);
  const mapped = alloc(4);
  assert.equal((await call(matrix, 10, 4, 0, mapped)).result, 0);
  const storage = r.read32(mapped);
  r.write32(storage, 0x3f800000);
  assert.equal((await call(matrix, 11)).result, undefined);

  // Shaders and input layout.
  const vsSource = alloc(64),
    psSource = alloc(64);
  r.data.fill(1, vsSource, vsSource + 64);
  r.data.fill(2, psSource, psSource + 64);
  const vsOut = alloc(4),
    psOut = alloc(4);
  assert.equal((await call(device, 79, vsSource, 64, vsOut)).result, 0);
  assert.equal((await call(device, 82, psSource, 64, psOut)).result, 0);
  const vs = r.read32(vsOut),
    ps = r.read32(psOut);
  const elements = alloc(56);
  const names = ['POSITION', 'COLOR'];
  for (const [i, name] of names.entries()) {
    const text = alloc(name.length + 1);
    for (let c = 0; c < name.length; c++) r.data[text + c] = name.charCodeAt(c);
    r.write32(elements + i * 28, text);
    r.write32(elements + i * 28 + 8, 2); // DXGI_FORMAT_R32G32B32A32_FLOAT
    r.write32(elements + i * 28 + 16, i * 16);
  }
  const layoutOut = alloc(4);
  assert.equal((await call(device, 78, elements, 2, vsSource, 64, layoutOut)).result, 0);
  const layout = r.read32(layoutOut);

  const rasterOut = alloc(4),
    depthStateOut = alloc(4),
    blendOut = alloc(4);
  const rasterDesc = alloc(40);
  r.write32(rasterDesc, 3);
  r.write32(rasterDesc + 4, 1);
  r.write32(rasterDesc + 24, 1);
  assert.equal((await call(device, 85, rasterDesc, rasterOut)).result, 0);
  const depthDescState = alloc(52);
  r.write32(depthDescState, 1);
  r.write32(depthDescState + 4, 1);
  r.write32(depthDescState + 8, 4); // D3D10_COMPARISON_LESS_EQUAL
  assert.equal((await call(device, 84, depthDescState, depthStateOut)).result, 0);
  // D3D10 rejects a null state description, and an all-zero one with the full
  // write mask is the no-blend default.
  assert.equal((await call(device, 83, 0, blendOut)).result, 0x80070057);
  const blendDesc = alloc(68);
  for (let i = 0; i < 8; i++) r.data[blendDesc + 60 + i] = 0xf;
  assert.equal((await call(device, 83, blendDesc, blendOut)).result, 0);
  const raster = r.read32(rasterOut),
    depthState = r.read32(depthStateOut),
    blend = r.read32(blendOut);

  // Bind and draw. D3D10 records nothing: the draw reaches the backend as soon
  // as it is issued, in the order the setters established.
  const viewport = alloc(24);
  r.write32(viewport + 8, 640);
  r.write32(viewport + 12, 480);
  r.view.setFloat32(viewport + 16, 0, true);
  r.view.setFloat32(viewport + 20, 1, true);
  const scissor = alloc(16);
  r.write32(scissor + 8, 640);
  r.write32(scissor + 12, 480);
  const colorPointer = alloc(16);
  r.view.setFloat32(colorPointer, 0.05, true);

  assert.equal((await call(device, 35, rtv, colorPointer)).argc, 3);
  assert.equal((await call(device, 36, dsv, 1, alloc(4), 0)).argc, 5);
  assert.equal((await call(device, 24, 1, rtvPtr(r, alloc(4), rtv), dsv)).argc, 4);
  assert.equal((await call(device, 30, 1, viewport)).argc, 3);
  assert.equal((await call(device, 31, 1, scissor)).argc, 3);
  assert.equal((await call(device, 11, layout)).argc, 2);
  const strides = alloc(8);
  r.write32(strides, 32);
  const offsets = alloc(8);
  const bufferList = alloc(8);
  r.write32(bufferList, vertices);
  assert.equal((await call(device, 12, 0, 1, bufferList, strides, offsets)).argc, 6);
  assert.equal((await call(device, 13, indices, 57, 0)).argc, 4);
  assert.equal((await call(device, 18, 4)).argc, 2);
  assert.equal((await call(device, 7, vs)).argc, 2);
  const cbList = alloc(8);
  r.write32(cbList, matrix);
  assert.equal((await call(device, 3, 0, 1, cbList)).argc, 4);
  assert.equal((await call(device, 5, ps)).argc, 2);
  assert.equal((await call(device, 29, raster)).argc, 2);
  assert.equal((await call(device, 26, depthState, 0)).argc, 3);
  assert.equal((await call(device, 25, blend, 0, 0xffffffff)).argc, 4);
  assert.equal((await call(device, 8, 6, 0, 0)).argc, 4);

  const plan = events.find((event) => event.type === 'plan');
  assert.deepEqual(plan.vertex, new Array(64).fill(1));
  assert.deepEqual(plan.pixel, new Array(64).fill(2));
  const pipeline = events.find((event) => event.type === 'pipeline');
  assert.equal(pipeline.vertexStride, 32);
  assert.equal(pipeline.cullMode, 'none');
  assert.equal(pipeline.frontFace, 'cw');
  assert.deepEqual(pipeline.depth, {
    format: 'depth16unorm',
    testEnabled: true,
    writeEnabled: true,
    compare: 'less-equal',
  });
  assert.equal(pipeline.targetFormat, 'rgba8unorm');

  const commands = events.filter((event) => event.type === 'execute').map((e) => e.commands[0]);
  assert.deepEqual(
    commands.map((command) => command.type),
    ['clear', 'clear-depth', 'draw'],
    'the clear, the depth clear and the draw reach the backend in issue order',
  );
  const draw = commands.at(-1);
  assert.equal(draw.target, backBuffer);
  assert.equal(draw.depthTarget, depth);
  assert.equal(draw.indexCount, 6);
  assert.equal(draw.firstIndex, 0);
  assert.equal(draw.baseVertex, 0);
  assert.equal(draw.indexFormat, 'uint16');
  assert.equal(draw.vertexStride, 32);
  assert.equal(draw.vertices.length, 128);
  assert.equal(draw.indices.length, 12);
  assert.deepEqual(draw.viewport, {
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    minDepth: 0,
    maxDepth: 1,
  });
  assert.deepEqual(draw.scissor, { left: 0, top: 0, right: 640, bottom: 480 });

  assert.equal((await call(chain, 8, 0, 0)).result, 0);
  assert.deepEqual(
    events.filter((event) => event.type === 'present').at(-1),
    // The frontend names the graphics family so the desktop can label the
    // surface; the discard effect keeps presenting the buffer it drew into.
    { type: 'present', id: chain, index: 0, graphicsApi: 'd3d10' },
    'the discard effect keeps presenting the back buffer it was drawn into',
  );
});

function rtvPtr(r, slot, value) {
  r.write32(slot, value);
  return slot;
}

test('D3D10 registers reject out-of-range binding and unsupported state', async () => {
  const f = fixture(),
    { runtime: r, call, api, guid, alloc } = f;
  const swapOut = alloc(4),
    devOut = alloc(4);
  const response = await api(
    'D3D10CreateDeviceAndSwapChain',
    0,
    1,
    0,
    0,
    29,
    swapDesc(r),
    swapOut,
    devOut,
  );
  assert.equal(response.result, 0);
  const device = r.read32(devOut);
  const bufferOut = alloc(4);
  const initial = alloc(12);
  r.write32(initial, alloc(32));
  assert.equal((await call(device, 71, bufferDesc(r, 32, 0x1, 1), initial, bufferOut)).result, 0);
  const vertexBuffer = r.read32(bufferOut);
  const list = alloc(8);
  r.write32(list, vertexBuffer);
  const strides = alloc(8);
  r.write32(strides, 32);
  const offsets = alloc(8);
  await assert.rejects(
    call(device, 12, 1, 1, list, strides, offsets),
    /slots beyond 0 are unsupported/,
  );
  // A vertex buffer may not be bound where the stage expects a constant buffer.
  const cbList = alloc(8);
  r.write32(cbList, vertexBuffer);
  await assert.rejects(call(device, 3, 0, 1, cbList), /not a constant buffer/);
  await assert.rejects(call(device, 18, 5), /Unsupported D3D10 primitive topology/);
  // An immutable buffer cannot be mapped.
  const immutable = alloc(4);
  await call(
    device,
    71,
    bufferDesc(r, 32, 0x1, 1),
    (() => {
      const p = alloc(12);
      const source = alloc(32);
      r.write32(p, source);
      return p;
    })(),
    immutable,
  );
  const data = alloc(4);
  assert.equal((await call(r.read32(immutable), 10, 4, 0, data)).result, 0x80070057);
  assert.equal(
    (await call(device, 81, alloc(8), alloc(8), alloc(8), 0, 0, alloc(4))).result,
    0x80070057,
  );
  assert.equal((await call(device, 90, 28, alloc(4))).result, 0);
  assert.equal((await call(device, 94)).result, 0);
});

test('the D3D10 binding planner keeps one register file per stage', () => {
  const vs = [
    { type: DESCRIPTOR_CBV, space: 0, register: 0, resourceType: 1 },
    { type: DESCRIPTOR_SRV, space: 0, register: 0, resourceType: 3, dataType: 5 },
  ];
  const ps = [
    { type: DESCRIPTOR_CBV, space: 0, register: 0, resourceType: 1 },
    { type: DESCRIPTOR_SAMPLER, space: 0, register: 0, resourceType: 0 },
  ];
  const plan = planStageBindings(vs, ps);
  assert.equal(plan.bindings.length, 4);
  // The two constant buffers sit in group 0 as distinct bindings, and the
  // vertex shader's cb0 is not the pixel shader's cb0.
  const cbvs = plan.bindings.filter((b) => b.type === DESCRIPTOR_CBV);
  assert.equal(cbvs.length, 2);
  assert.deepEqual(
    cbvs.map((b) => [b.stage, b.group, b.binding]),
    [
      [0, 0, 0],
      [1, 0, 1],
    ],
  );
  assert.deepEqual(
    plan.vertex.map((p) => [p.register, p.group, p.binding]),
    [
      [0, 0, 0],
      [0, 1, 0],
    ],
  );
  assert.deepEqual(
    plan.pixel.map((p) => [p.register, p.group, p.binding]),
    [
      [0, 0, 1],
      [0, 2, 0],
    ],
  );
  assert.equal(plan.lookup.get(`0:${DESCRIPTOR_CBV}:0:0`).binding, 0);
  assert.equal(plan.lookup.get(`1:${DESCRIPTOR_CBV}:0:0`).binding, 1);
});

test('D3D10GetInputSignatureBlob returns the container an input layout consumes', async () => {
  const f = fixture(),
    { runtime: r, api, alloc } = f;
  // A minimal but well-formed container: DXBC header, one ISGN chunk whose
  // header is 8 bytes and whose body is empty.
  const shader = new Uint8Array(52);
  const shaderView = new DataView(shader.buffer);
  shader.set(new TextEncoder().encode('DXBC'), 0);
  shaderView.setUint32(24, 52, true);
  shaderView.setUint32(28, 1, true);
  shaderView.setUint32(32, 36, true);
  shader.set(new TextEncoder().encode('ISGN'), 36);
  shaderView.setUint32(40, 8, true);
  void shaderView;
  const source = alloc(shader.length);
  r.data.set(shader, source);
  const out = alloc(4);
  assert.equal((await api('D3D10GetInputSignatureBlob', source, shader.length, out)).result, 0);
  const blob = r.read32(out);
  const entry = r.thunks.get(r.read32(r.read32(blob) + 3 * 4));
  const pointer = (await entry.invoke(r, (i) => (i === 0 ? blob : 0))).result;
  const size = (
    await r.thunks.get(r.read32(r.read32(blob) + 4 * 4)).invoke(r, (i) => (i === 0 ? blob : 0))
  ).result;
  const bytes = r.data.slice(pointer, pointer + size);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'DXBC');
  assert.equal(String.fromCharCode(...bytes.slice(36, 40)), 'ISGN');
  // An input with no ISGN chunk is refused rather than reported as an empty blob.
  const bad = alloc(8);
  r.data.set(new TextEncoder().encode('nonsense'), bad);
  assert.equal((await api('D3D10GetInputSignatureBlob', bad, 8, out)).result, 0x80070057);
});

test('D3D10CreateDevice accepts every documented creation flag and answers IDXGIDevice', async () => {
  const f = fixture(),
    { runtime: r, call, api, guid, alloc } = f;
  const out = alloc(4);
  // Every flag the header defines is a hint that does not change what the
  // bounded device models. Rejecting one refuses an application over a flag
  // with no semantic weight here; D3D10_CREATE_DEVICE_SINGLETHREADED is what a
  // real framework passes first.
  for (const flags of [0, 0x1, 0x2, 0x20, 0x1 | 0x2 | 0x20, 0x400]) {
    assert.equal((await api('D3D10CreateDevice', 0, 0, 0, flags, 29, out)).result, 0);
  }
  // An undefined flag is still refused.
  assert.equal((await api('D3D10CreateDevice', 0, 0, 0, 0x1000, 29, out)).result, 0x80070057);
  assert.equal((await api('D3D10CreateDevice', 0, 0, 0, 0, 30, out)).result, 0x80070057);

  assert.equal((await api('D3D10CreateDevice', 0, 0, 0, 0x1, 29, out)).result, 0);
  const device = r.read32(out);
  // A framework obtains its swap chain by handing the factory the device's
  // IDXGIDevice, so the device has to answer that identity with a real object
  // whose vtable is the DXGI one — not with its own ID3D10Device pointer.
  const dxgiOut = alloc(4);
  assert.equal(
    (await call(device, 0, guid('54ec77fa-1377-44e6-8c32-88fd5f44c84c'), dxgiOut)).result,
    0,
  );
  const dxgiDevice = r.read32(dxgiOut);
  assert.ok(dxgiDevice && dxgiDevice !== device, 'IDXGIDevice is its own object');
  assert.equal(r.comObjects.objects.get(dxgiDevice).name, 'IDXGIDevice');
  // Asking twice returns the same identity, as a real QI does.
  const again = alloc(4);
  await call(device, 0, guid('54ec77fa-1377-44e6-8c32-88fd5f44c84c'), again);
  assert.equal(r.read32(again), dxgiDevice);
  // GetAdapter reports the adapter the device renders through.
  const adapterOut = alloc(4);
  assert.equal(
    (await call(dxgiDevice, 7, guid('29038f61-3839-4626-91fd-086879011a05'), adapterOut)).result,
    0,
  );
  assert.equal(r.comObjects.objects.get(r.read32(adapterOut)).name, 'IDXGIAdapter1');
});

test('GetMonitorInfo writes both RECTs at the offsets the header declares', async () => {
  // MONITORINFO is cbSize (0), rcMonitor (4), rcWork (20), dwFlags (36). Writing
  // the two rectangles four bytes apart puts every field in the wrong slot, so a
  // caller reads a rectangle with a zero height — which is what made a real
  // application compute a negative window height and fail its own CreateWindow.
  const provider = createWin32ApiProvider();
  const buffer = new Uint8Array(0x10000);
  const view = new DataView(buffer.buffer);
  let next = 0x1000;
  const runtime = {
    data: buffer,
    view,
    check: (p, n) => p,
    read32: (p) => view.getUint32(p, true),
    write32: (p, v) => view.setUint32(p, v >>> 0, true),
    allocate: (n) => {
      const p = next;
      next = (next + n + 3) & ~3;
      return p;
    },
    free: () => true,
    windows: { display: { width: 1024, height: 768 } },
  };
  const info = runtime.allocate(40);
  runtime.write32(info, 40);
  const handler = provider.get(importKey('user32.dll', 'GetMonitorInfoA'));
  assert.equal((await handler(runtime, (i) => [1, info][i])).result, 1);
  const word = (offset) => view.getInt32(info + offset, true);
  assert.equal(word(0), 40, 'cbSize');
  assert.deepEqual(
    [word(4), word(8), word(12), word(16)],
    [0, 0, 1024, 768],
    'rcMonitor is an RECT at offset 4',
  );
  assert.deepEqual(
    [word(20), word(24), word(28), word(32)],
    [0, 0, 1024, 768],
    'rcWork is an RECT at offset 20',
  );
  assert.equal(word(36), 1, 'MONITORINFOF_PRIMARY');
});

test('ID3D10Resource.GetType writes through its out-parameter', async () => {
  // `void GetType(D3D10_RESOURCE_DIMENSION *rType)` is an out-parameter call,
  // not a value-returning getter. Answering in EAX left the caller's variable
  // uninitialized, so a framework's own resource dispatch reported "Unsupported
  // type" for a texture it had just created.
  const f = fixture(),
    { runtime: r, call, api, guid, alloc } = f;
  const swapOut = alloc(4),
    devOut = alloc(4);
  assert.equal(
    (await api('D3D10CreateDeviceAndSwapChain', 0, 0, 0, 0, 29, swapDesc(r), swapOut, devOut))
      .result,
    0,
  );
  const device = r.read32(devOut);
  const kindOut = alloc(4);
  // A buffer answers D3D10_RESOURCE_DIMENSION_BUFFER (1).
  const bufferOut = alloc(4);
  const initial = alloc(12);
  r.write32(initial, alloc(64));
  await call(device, 71, bufferDesc(r, 64, 0x1, 1), initial, bufferOut);
  const buffer = r.read32(bufferOut);
  r.write32(kindOut, 0xdeadbeef);
  assert.equal((await call(buffer, 7, kindOut)).result, undefined);
  assert.equal(r.read32(kindOut), 1, 'a buffer reports dimension 1');

  // A sampled texture answers D3D10_RESOURCE_DIMENSION_TEXTURE2D (3). The
  // backend role a texture serves is not its D3D dimension, so the mapping has
  // to cover the roles rather than only the literal kind names.
  const textureOut = alloc(4);
  const textureDesc = alloc(44);
  r.write32(textureDesc, 32);
  r.write32(textureDesc + 4, 32);
  r.write32(textureDesc + 8, 1);
  r.write32(textureDesc + 12, 1);
  r.write32(textureDesc + 16, 28);
  r.write32(textureDesc + 20, 1);
  r.write32(textureDesc + 32, 0x8);
  assert.equal((await call(device, 73, textureDesc, 0, textureOut)).result, 0);
  const texture = r.read32(textureOut);
  r.write32(kindOut, 0xdeadbeef);
  assert.equal((await call(texture, 7, kindOut)).result, undefined);
  assert.equal(r.read32(kindOut), 3, 'a sampled texture reports dimension 3');
  // A null out-parameter is a caller error, not a silent success.
  await assert.rejects(call(texture, 7, 0), /output pointer/);
});

test('a block-compressed texture accepts an initial upload', async () => {
  // BC1/BC2/BC3 are what a game's assets are stored in. The texture's storage
  // and the upload both follow the 4x4 block footprint rather than the pixel
  // count, and the descriptor must be accepted for a shader-resource bind.
  const f = fixture(),
    { runtime: r, events, call, api, alloc } = f;
  const swapOut = alloc(4),
    devOut = alloc(4);
  await api('D3D10CreateDeviceAndSwapChain', 0, 0, 0, 0, 29, swapDesc(r), swapOut, devOut);
  const device = r.read32(devOut);
  // A 256x256 BC2 texture is 64x64 blocks of 16 bytes.
  const source = alloc(64 * 64 * 16);
  for (let i = 0; i < 64 * 64 * 16; i++) r.data[source + i] = i & 0xff;
  const initial = alloc(12);
  r.write32(initial, source);
  const desc = alloc(44);
  r.write32(desc, 256);
  r.write32(desc + 4, 256);
  r.write32(desc + 8, 1);
  r.write32(desc + 12, 1);
  r.write32(desc + 16, 74); // DXGI_FORMAT_BC2_UNORM
  r.write32(desc + 20, 1);
  r.write32(desc + 32, 0x8);
  const out = alloc(4);
  assert.equal((await call(device, 73, desc, initial, out)).result, 0);
  const created = events.filter((event) => event.type === 'resource').at(-1);
  assert.equal(created.format, 'bc2-rgba-unorm');
  const upload = events.filter((event) => event.type === 'uploadTexture').at(-1);
  assert.equal(upload.bytesPerRow, 64 * 16, 'a block row is 64 blocks of 16 bytes');
  assert.equal(upload.rows.length, 64 * 16 * 64, 'and there are 64 block rows');
  assert.equal(upload.rows[0], 0);
});

test('reflection children use the non-IUnknown ABI and share root lifetime', async () => {
  const { runtime: r, call, api, alloc, guid } = fixture();
  const out = alloc(4);
  const shader = new Uint8Array(await readFile('demos/d3d10-cube/shaders/cube.vs.dxbc'));
  const source = alloc(shader.length);
  r.data.set(shader, source);
  assert.equal((await api('D3D10ReflectShader', source, shader.length, out)).result, 0);
  const reflection = r.read32(out);
  const iidOut = alloc(4);
  assert.equal(
    (await call(reflection, 0, guid('d40e20b6-f8f7-42ad-ab20-4baf8f15dfaa'), iidOut)).result,
    0,
  );
  assert.equal(r.read32(iidOut), reflection);
  await call(reflection, 2); // balance QueryInterface
  const buffer = (await call(reflection, 4, 0)).result;
  const desc = alloc(32);
  r.data.fill(0xa5, desc, desc + 32);
  const response = await call(buffer, 0, desc); // GetDesc, not QueryInterface
  assert.equal(response.argc, 2);
  assert.equal(response.result ?? 0, 0);
  assert.equal(r.string(r.read32(desc)), 'Transform');
  assert.equal(r.read32(desc + 8), 4);
  assert.equal(r.read32(desc + 12), 64);
  assert.equal(r.read32(desc + 20), 0xa5a5a5a5);
  const variable = (await call(buffer, 1, 0)).result;
  assert.equal((await call(variable, 0, desc)).argc, 2);
  assert.equal(r.string(r.read32(desc)), 'row0');
  assert.equal(r.read32(desc + 8), 16);
  const type = (await call(variable, 1)).result;
  assert.equal((await call(type, 0, desc)).argc, 2);
  assert.deepEqual(
    Array.from({ length: 7 }, (_, index) => r.read32(desc + index * 4)),
    [1, 3, 1, 4, 0, 0, 0],
  ); // vector, float, one row, four columns
  assert.equal((await call(type, 1, 0)).result, 0);
  assert.equal((await call(buffer, 1, 0)).result, variable);
  await call(reflection, 2);
  await assert.rejects(call(buffer, 0, desc), /Released shader reflection/);
  await assert.rejects(call(variable, 0, desc), /Released shader reflection/);
  await assert.rejects(call(type, 0, desc), /Released shader reflection/);
});

test('D3D10 sampled volume copies padded rows and slices and reports its native descriptor', async () => {
  const { runtime: r, api, alloc, call, events } = fixture();
  const out = alloc(4);
  await api('D3D10CreateDevice', 0, 0, 0, 0, 29, out);
  const device = r.read32(out);
  const desc = alloc(36);
  [2, 2, 2, 1, 28, 1, 8, 0, 0].forEach((value, i) => r.write32(desc + i * 4, value));
  const source = alloc(56),
    initial = alloc(12);
  r.data.fill(0xee, source, source + 56);
  const expected = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  for (let z = 0; z < 2; z++)
    for (let y = 0; y < 2; y++)
      r.data.set(expected.subarray((z * 2 + y) * 8, (z * 2 + y + 1) * 8), source + z * 32 + y * 12);
  [source, 12, 32].forEach((value, i) => r.write32(initial + i * 4, value));
  assert.equal((await call(device, 74, desc, initial, out)).result, 0);
  const volume = r.read32(out);
  const created = events.find((event) => event.type === 'resource');
  assert.equal(created.dimension, '3d');
  assert.equal(created.depth, 2);
  const upload = events.find((event) => event.type === 'uploadTexture');
  assert.deepEqual(upload.rows, expected);
  assert.equal(upload.depth, 2);
  assert.equal(upload.bytesPerRow, 8);
  assert.equal(upload.rowsPerImage, 2);
  const returned = alloc(40);
  r.write32(returned + 36, 0xa5a5a5a5);
  await call(volume, 12, returned);
  assert.deepEqual(
    Array.from({ length: 9 }, (_, i) => r.read32(returned + i * 4)),
    [2, 2, 2, 1, 28, 1, 8, 0, 0],
  );
  assert.equal(r.read32(returned + 36), 0xa5a5a5a5);
  await call(volume, 7, returned);
  assert.equal(r.read32(returned), 4, 'GetType reports TEXTURE3D');
  assert.equal((await call(device, 75, volume, 0, out)).result, 0);
  const view = r.read32(out);
  await call(view, 8, returned);
  assert.equal(r.read32(returned + 4), 8, 'default SRV dimension is TEXTURE3D');
  r.write32(initial + 8, 8); // overlapping slices
  assert.equal((await call(device, 74, desc, initial, out)).result, 0x80070057);
  assert.equal(r.read32(out), 0);
  await call(volume, 2);
  assert.equal(
    events.some((event) => event.type === 'destroyResource' && event.id === volume),
    false,
    'the shader resource view retains the volume',
  );
  await call(view, 2);
  assert.ok(events.some((event) => event.type === 'destroyResource' && event.id === volume));
});

test('D3D10 BC4 and BC5 preserve their 8- and 16-byte block footprints', async () => {
  const { runtime: r, api, alloc, call, events } = fixture();
  const out = alloc(4);
  await api('D3D10CreateDevice', 0, 0, 0, 0, 29, out);
  const device = r.read32(out);
  for (const [format, bytes, gpuFormat] of [
    [80, 8, 'bc4-r-unorm'],
    [81, 8, 'bc4-r-snorm'],
    [83, 16, 'bc5-rg-unorm'],
    [84, 16, 'bc5-rg-snorm'],
  ]) {
    const desc = alloc(44);
    [4, 4, 1, 1, format, 1, 0, 1, 8, 0, 0].forEach((value, i) => r.write32(desc + i * 4, value));
    const source = alloc(bytes),
      initial = alloc(12);
    r.data.fill(0x77, source, source + bytes);
    [source, bytes, bytes].forEach((value, i) => r.write32(initial + i * 4, value));
    assert.equal((await call(device, 73, desc, initial, out)).result, 0);
    assert.equal(events.filter((event) => event.type === 'resource').at(-1).format, gpuFormat);
    const upload = events.filter((event) => event.type === 'uploadTexture').at(-1);
    assert.equal(upload.bytesPerRow, bytes);
    assert.equal(upload.rows.length, bytes);
    await call(r.read32(out), 2);
  }
});
