import test from 'node:test';
import assert from 'node:assert/strict';
import { d3d9Apis } from '../src/d3d9.js';

function fixture() {
  const buffer = new ArrayBuffer(1024 * 1024);
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let next = 0x1000;
  const events = [];
  const runtime = {
    data,
    view,
    thunks: new Map(),
    windows: { windows: new Map([[0x20000, { width: 640, height: 480 }]]) },
    check(address, size) {
      if (address < 0x1000 || size < 1 || address + size > data.length)
        throw Error('Guest memory violation');
      return address;
    },
    allocate(size) {
      const address = next;
      next = (next + size + 3) & ~3;
      this.check(address, size);
      return address;
    },
    read32(address) {
      return view.getUint32(this.check(address, 4), true);
    },
    write32(address, value) {
      view.setUint32(this.check(address, 4), value >>> 0, true);
    },
    graphics: {
      async createDevice(options) {
        events.push({ type: 'create', ...options });
      },
      async present(frame) {
        events.push({ type: 'present', ...frame });
      },
      async destroyDevice(options) {
        events.push({ type: 'destroy', ...options });
      },
    },
  };
  const call = (pointer, slot, ...args) => {
    const thunk = runtime.thunks.get(runtime.read32(runtime.read32(pointer) + slot * 4));
    assert.equal(thunk.kind, 'com');
    return thunk.invoke(runtime, (index) => [pointer, ...args][index]);
  };
  const factory = d3d9Apis['d3d9.dll!Direct3DCreate9'](runtime, () => 32).result;
  const params = runtime.allocate(56);
  const output = runtime.allocate(4);
  runtime.write32(params + 24, 1); // D3DSWAPEFFECT_DISCARD.
  runtime.write32(params + 28, 0x20000);
  runtime.write32(params + 32, 1); // Windowed.
  runtime.write32(params + 36, 1); // AutoDepthStencil.
  runtime.write32(params + 40, 80); // D3DFMT_D16.
  const create = async () => {
    assert.equal((await call(factory, 16, 0, 1, 0x20000, 0x20, params, output)).result, 0);
    return runtime.read32(output);
  };
  return { runtime, events, call, factory, params, output, create };
}

test('D3D9 factory and device expose PE32 vtables with guarded IUnknown lifetimes', async () => {
  const { runtime, events, call, factory, create } = fixture();
  assert.equal((await call(factory, 4)).result, 1);
  const device = await create();
  assert.equal(events[0].windowId, 0x20000);
  assert.equal(events[0].width, 640);
  assert.equal(events[0].height, 480);
  assert.equal(events[0].depth, true);
  const iid = runtime.allocate(16);
  runtime.data.set(
    [
      0x96, 0x3b, 0x22, 0xd0, 0x7a, 0xbf, 0xfd, 0x43, 0x92, 0xbd, 0xa4, 0x3b, 0x0d, 0x82, 0xb9,
      0xeb,
    ],
    iid,
  );
  const out = runtime.allocate(4);
  assert.equal((await call(device, 0, iid, out)).result, 0);
  assert.equal(runtime.read32(out), device);
  runtime.data.set([0, 0, 0, 0, 0, 0, 0, 0, 0xc0, 0, 0, 0, 0, 0, 0, 0x46], iid);
  assert.equal((await call(device, 0, iid, out)).result, 0); // IUnknown IID.
  assert.equal(runtime.read32(out), device);
  assert.equal((await call(device, 2)).result, 2);
  assert.equal((await call(device, 2)).result, 1);
  const object = runtime.comObjects.objects.get(device);
  object.refs = 0x7fffffff;
  await assert.rejects(call(device, 0, iid, out), /reference count limit exceeded/);
  await assert.rejects(call(device, 1), /reference count limit exceeded/);
  assert.equal(object.refs, 0x7fffffff);
  object.refs = 1;
  runtime.data.fill(0xff, iid, iid + 16);
  assert.equal((await call(device, 0, iid, out)).result, 0x80004002);
  assert.equal(runtime.read32(out), 0);
  assert.equal((await call(factory, 2)).result, 1); // Device retains its factory.
  assert.equal((await call(device, 2)).result, 0);
  assert.deepEqual(events.at(-1), { type: 'destroy', id: device });
  await assert.rejects(call(device, 1), /Released COM object IDirect3DDevice9/);
  await assert.rejects(call(factory, 4), /Released COM object IDirect3D9/);
});

test('Clear and DrawPrimitiveUP snapshot colored 3D vertices and transformed state', async () => {
  const { runtime, events, call, create } = fixture();
  const device = await create();
  const matrix = runtime.allocate(64);
  for (let i = 0; i < 16; i++) runtime.view.setFloat32(matrix + i * 4, i % 5 === 0 ? 1 : 0, true);
  runtime.view.setFloat32(matrix + 12 * 4, 2, true);
  assert.equal((await call(device, 44, 256, matrix)).argc, 3);
  await call(device, 57, 22, 1);
  await call(device, 57, 137, 0);
  await call(device, 57, 7, 1);
  await call(device, 57, 14, 1);
  await call(device, 89, 0x42);
  assert.equal((await call(device, 43, 0, 0, 3, 0xff123456, 0x3f800000, 0)).result, 0);
  assert.equal((await call(device, 41)).result, 0);
  const vertices = runtime.allocate(48);
  for (let i = 0; i < 3; i++) {
    runtime.view.setFloat32(vertices + i * 16, i, true);
    runtime.view.setFloat32(vertices + i * 16 + 4, i + 1, true);
    runtime.view.setFloat32(vertices + i * 16 + 8, 0.5, true);
    runtime.write32(vertices + i * 16 + 12, 0xff0000ff);
  }
  assert.equal((await call(device, 83, 4, 1, vertices, 16)).result, 0);
  runtime.data.fill(0, vertices, vertices + 48);
  assert.equal((await call(device, 42)).result, 0);
  assert.equal((await call(device, 17, 0, 0, 0, 0)).result, 0);
  const frame = events.at(-1);
  assert.equal(frame.type, 'present');
  assert.equal(frame.commands.length, 2);
  assert.deepEqual(frame.commands[0], {
    type: 'clear',
    color: 0xff123456,
    depth: 1,
    clearColor: true,
    clearDepth: true,
  });
  assert.equal(frame.commands[1].vertexCount, 3);
  assert.equal(frame.commands[1].stride, 16);
  assert.equal(frame.commands[1].vertices.length, 48);
  assert.equal(frame.commands[1].vertices[12], 0xff);
  assert.equal(frame.commands[1].world[12], 2);
  assert.equal(frame.commands[1].depthTest, true);
  assert.equal(frame.commands[1].cullMode, 'none');
  await call(device, 17, 0, 0, 0, 0);
  assert.equal(events.at(-1).commands.length, 0);
});

test('Unsupported D3D9 methods and render modes fail explicitly; failed Present retains commands', async () => {
  const { runtime, events, call, factory, params, output, create } = fixture();
  assert.equal(d3d9Apis['d3d9.dll!Direct3DCreate9'](runtime, () => 31).result, 0);
  await assert.rejects(
    call(factory, 14, 0, 1, 0),
    /Unsupported COM method IDirect3D9.GetDeviceCaps/,
  );
  runtime.write32(params + 32, 0);
  assert.equal((await call(factory, 16, 0, 1, 0x20000, 0x20, params, output)).result, 0x8876086c);
  runtime.write32(params + 32, 1);
  const device = await create();
  await assert.rejects(
    call(device, 23, 1),
    /Unsupported COM method IDirect3DDevice9.CreateTexture/,
  );
  await assert.rejects(call(device, 57, 22, 3), /Unsupported IDirect3DDevice9.SetRenderState/);
  await assert.rejects(call(device, 89, 0x44), /Unsupported IDirect3DDevice9.SetFVF/);
  await call(device, 57, 22, 1);
  await call(device, 57, 137, 0);
  await call(device, 89, 0x42);
  await call(device, 41);
  await assert.rejects(call(device, 83, 4, 1, 0, 16), /Guest memory violation/);
  await assert.rejects(call(device, 83, 4, 21846, 0x1000, 16), /vertex count limit/);
  await call(device, 42);
  await call(device, 43, 0, 0, 1, 0xff000000, 0x3f800000, 0);
  const present = runtime.graphics.present;
  runtime.graphics.present = async () => {
    throw Error('GPU unavailable');
  };
  await assert.rejects(call(device, 17, 0, 0, 0, 0), /GPU unavailable/);
  runtime.graphics.present = present;
  await call(device, 17, 0, 0, 0, 0);
  assert.equal(events.at(-1).commands.length, 1);
});

test('frontend enforces renderer dimensions, command budget, and D16-only depth', async () => {
  const { runtime, call, factory, params, output, create } = fixture();
  runtime.write32(params + 0, 2049);
  assert.equal((await call(factory, 16, 0, 1, 0x20000, 0x20, params, output)).result, 0x8876086c);
  runtime.write32(params + 0, 0);
  runtime.write32(params + 40, 75); // D24S8 needs stencil, which the backend lacks.
  assert.equal((await call(factory, 16, 0, 1, 0x20000, 0x20, params, output)).result, 0x8876086c);
  runtime.write32(params + 40, 80);
  const device = await create();
  for (let i = 0; i < 256; i++)
    assert.equal((await call(device, 43, 0, 0, 1, 0xff000000, 0x3f800000, 0)).result, 0);
  await assert.rejects(call(device, 43, 0, 0, 1, 0xff000000, 0x3f800000, 0), /frame command limit/);
});

test('devices without a depth surface reject depth clear and depth enable', async () => {
  const { runtime, call, params, create } = fixture();
  runtime.write32(params + 36, 0);
  runtime.write32(params + 40, 0);
  const device = await create();
  assert.equal((await call(device, 43, 0, 0, 2, 0, 0x3f800000, 0)).result, 0x8876086c);
  assert.equal((await call(device, 57, 7, 1)).result, 0x8876086c);
  assert.equal((await call(device, 57, 14, 1)).result, 0x8876086c);
  await call(device, 57, 22, 1);
  await call(device, 57, 137, 0);
  await call(device, 89, 0x42);
  await call(device, 41);
  const vertices = runtime.allocate(48);
  assert.equal((await call(device, 83, 4, 1, vertices, 16)).result, 0);
  await call(device, 42);
  await call(device, 17, 0, 0, 0, 0);
});

test('programmable DrawPrimitiveUP owns shaders and snapshots declaration, vertices, and constants', async () => {
  const { runtime, events, call, create } = fixture();
  const device = await create();
  const vsWords = [
    0xfffe0101, 0x0000001f, 0x80000000, 0x900f0000, 0x0000001f, 0x8000000a, 0x900f0001, 0x00000001,
    0xc00f0000, 0x90e40000, 0x00000005, 0xd00f0000, 0xa0e40000, 0x90e40001, 0x0000ffff,
  ];
  // COMMENT uses a 15-bit payload length; a payload over 15 DWORDs must not
  // be mistaken for an unsupported instruction length.
  vsWords.splice(1, 0, 0x0014fffe, ...Array(20).fill(0x12345678));
  const psWords = [
    0xffff0200, 0x0200001f, 0x80000000, 0x900f0000, 0x02000001, 0x800f0800, 0x90e40000, 0x0000ffff,
  ];
  const words = (values) => {
    const pointer = runtime.allocate(values.length * 4);
    values.forEach((value, index) => runtime.write32(pointer + index * 4, value));
    return pointer;
  };
  const vsSource = words(vsWords),
    psSource = words(psWords),
    out = runtime.allocate(4);
  assert.equal((await call(device, 91, vsSource, out)).result, 0);
  const vertexShader = runtime.read32(out);
  assert.equal((await call(device, 106, psSource, out)).result, 0);
  const pixelShader = runtime.read32(out);

  const declarationSource = runtime.allocate(24);
  const element = (at, offset, type, usage) => {
    runtime.view.setUint16(at, 0, true);
    runtime.view.setUint16(at + 2, offset, true);
    runtime.data.set([type, 0, usage, 0], at + 4);
  };
  element(declarationSource, 0, 3, 0); // POSITION0 float4.
  element(declarationSource + 8, 16, 3, 10); // COLOR0 float4.
  runtime.view.setUint16(declarationSource + 16, 0xff, true);
  runtime.data[declarationSource + 20] = 17;
  assert.equal((await call(device, 86, declarationSource, out)).result, 0);
  const declaration = runtime.read32(out);
  const declarationCount = runtime.allocate(4);
  assert.equal((await call(declaration, 4, 0, declarationCount)).result, 0);
  assert.equal(runtime.read32(declarationCount), 3, 'GetDeclaration counts elements including END');
  const declarationCopy = runtime.allocate(24);
  runtime.data.fill(0xa5, declarationCopy, declarationCopy + 24);
  runtime.write32(declarationCount, 2);
  assert.equal((await call(declaration, 4, declarationCopy, declarationCount)).result, 0x8876086c);
  assert.equal(runtime.read32(declarationCount), 2);
  assert.deepEqual(
    [...runtime.data.subarray(declarationCopy, declarationCopy + 24)],
    Array(24).fill(0xa5),
    'short GetDeclaration buffer is untouched',
  );
  runtime.write32(declarationCount, 3);
  assert.equal((await call(declaration, 4, declarationCopy, declarationCount)).result, 0);
  assert.equal(runtime.read32(declarationCount), 3);
  assert.deepEqual(
    [...runtime.data.subarray(declarationCopy, declarationCopy + 24)],
    [...runtime.data.subarray(declarationSource, declarationSource + 24)],
  );
  assert.equal((await call(device, 87, declaration)).result, 0);
  assert.equal((await call(device, 92, vertexShader)).result, 0);
  assert.equal((await call(device, 107, pixelShader)).result, 0);

  const constants = runtime.allocate(17) + 1; // Guest pointers need not be aligned.
  [0.5, 1, 0.25, 1].forEach((value, index) =>
    runtime.view.setFloat32(constants + index * 4, value, true),
  );
  assert.equal((await call(device, 94, 0, constants, 1)).result, 0);
  assert.equal((await call(device, 94, 255, constants, 2)).result, 0x8876086c);
  const readback = runtime.allocate(17) + 1;
  assert.equal((await call(device, 95, 0, readback, 1)).result, 0);
  assert.equal(runtime.view.getFloat32(readback, true), 0.5);

  await call(device, 57, 22, 1);
  await call(device, 41);
  const vertices = runtime.allocate(96);
  const data = [
    [-0.8, -0.8, 0.5, 1, 1, 0, 0, 1],
    [0.8, -0.8, 0.5, 1, 0, 1, 0, 1],
    [0, 0.8, 0.5, 1, 0, 0, 1, 1],
  ];
  data.flat().forEach((value, index) => runtime.view.setFloat32(vertices + index * 4, value, true));
  assert.equal((await call(device, 83, 4, 1, vertices, 32)).result, 0);
  assert.equal(
    runtime.comObjects.objects.get(device).state.frameBytes,
    96 + vsWords.length * 4 + psWords.length * 4 + 256 * 16 + 224 * 16,
    'frame accounting includes copied bytecode and both constant files',
  );
  runtime.data.fill(0, vertices, vertices + 96);
  runtime.data.fill(0, constants, constants + 16);
  runtime.write32(vsSource, 0);
  await call(device, 42);
  await call(device, 17, 0, 0, 0, 0);

  const command = events.at(-1).commands[0];
  assert.equal(command.type, 'draw-programmable');
  assert.deepEqual(command.attributes, [
    { shaderLocation: 0, offset: 0, format: 'float32x4' },
    { shaderLocation: 1, offset: 16, format: 'float32x4' },
  ]);
  assert.equal(new DataView(command.vertices.buffer).getFloat32(0, true), Math.fround(-0.8));
  assert.equal(command.vertexConstants[0], 0.5);
  assert.equal(new Uint32Array(command.vertexShader.buffer)[0], 0xfffe0101);

  const payloadBytes = 96 + vsWords.length * 4 + psWords.length * 4 + 256 * 16 + 224 * 16;
  const deviceState = runtime.comObjects.objects.get(device).state;
  deviceState.frameBytes = 8 * 1024 * 1024 - payloadBytes + 1;
  await call(device, 41);
  await assert.rejects(call(device, 83, 4, 1, vertices, 32), /frame command limit/);
  await call(device, 42);
  deviceState.frameBytes = 0;

  const vertexObject = runtime.comObjects.objects.get(vertexShader);
  const pixelObject = runtime.comObjects.objects.get(pixelShader);
  const declarationObject = runtime.comObjects.objects.get(declaration);
  assert.equal((await call(vertexShader, 2)).result, 0);
  assert.equal(vertexObject.state.internalRefs, 1, 'binding owns a released shader internally');
  assert.equal((await call(device, 93, out)).result, 0);
  assert.equal(
    runtime.read32(out),
    vertexShader,
    'GetVertexShader revives a bound internal object',
  );
  assert.equal((await call(vertexShader, 2)).result, 0);
  assert.equal(
    (await call(device, 2)).result,
    2,
    'externally retained children keep the device alive',
  );
  assert.notEqual(events.at(-1).type, 'destroy');
  assert.equal((await call(pixelShader, 2)).result, 0);
  assert.equal((await call(declaration, 2)).result, 0);
  assert.deepEqual(events.at(-1), { type: 'destroy', id: device });
  assert.equal(vertexObject.state.internalRefs, 0);
  assert.equal(pixelObject.state.internalRefs, 0);
  assert.equal(declarationObject.state.internalRefs, 0);
});
