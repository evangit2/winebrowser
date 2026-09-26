import test from 'node:test';
import assert from 'node:assert/strict';
import { d3d9Apis } from '../src/d3d9.js';

function fixture(version = 9) {
  const buffer = new ArrayBuffer(1024 * 1024);
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let next = 0x1000;
  const events = [];
  const freed = [];
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
    free(address) {
      freed.push(address);
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
  const factory = d3d9Apis[`d3d${version}.dll!Direct3DCreate${version}`](runtime, () =>
    version === 8 ? 220 : 32,
  ).result;
  const params = runtime.allocate(version === 8 ? 52 : 56);
  const output = runtime.allocate(4);
  const shift = version === 8 ? 4 : 0;
  runtime.write32(params + 24 - shift, 1); // D3DSWAPEFFECT_DISCARD.
  runtime.write32(params + 28 - shift, 0x20000);
  runtime.write32(params + 32 - shift, 1); // Windowed.
  runtime.write32(params + 36 - shift, 1); // AutoDepthStencil.
  runtime.write32(params + 40 - shift, 80); // D3DFMT_D16.
  const create = async () => {
    assert.equal(
      (await call(factory, version === 8 ? 15 : 16, 0, 1, 0x20000, 0x20, params, output)).result,
      0,
    );
    return runtime.read32(output);
  };
  return { runtime, events, call, factory, params, output, create, freed };
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
    regions: [{ x: 0, y: 0, width: 640, height: 480 }],
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
  assert.equal(d3d9Apis['d3d9.dll!Direct3DCreate9'](runtime, () => 0).result, 0);
  await assert.rejects(
    call(factory, 3, 0),
    /Unsupported COM method IDirect3D9.RegisterSoftwareDevice/,
  );
  runtime.write32(params + 32, 0);
  assert.equal((await call(factory, 16, 0, 1, 0x20000, 0x20, params, output)).result, 0x8876086c);
  runtime.write32(params + 32, 1);
  const device = await create();
  await assert.rejects(
    call(device, 25, 1),
    /Unsupported COM method IDirect3DDevice9.CreateCubeTexture/,
  );
  await assert.rejects(call(device, 57, 22, 4), /Unsupported IDirect3DDevice9.SetRenderState/);
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

test('legacy SDK 31 uses the same COM factory, identity and device lifetime as SDK 32', async () => {
  const { runtime, call, params, output, events } = fixture();
  const factory = d3d9Apis['d3d9.dll!Direct3DCreate9'](runtime, () => 31).result;
  assert.ok(factory);
  assert.equal((await call(factory, 4)).result, 1);
  assert.equal((await call(factory, 16, 0, 1, 0x20000, 0x20, params, output)).result, 0);
  assert.equal(events.at(-1).type, 'create');
  const device = runtime.read32(output);
  assert.equal((await call(factory, 2)).result, 1); // device owns its factory
  assert.equal((await call(device, 2)).result, 0);
  assert.equal(runtime.comObjects.objects.get(factory).refs, 0);
  assert.equal(events.at(-1).type, 'destroy');
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

test('D3D8 SDK versions use distinct IIDs, 52-byte presentation parameters and FVF shader values', async () => {
  const { runtime, events, call, factory, create } = fixture(8);
  for (const sdk of [120, 220])
    assert.ok(d3d9Apis['d3d8.dll!Direct3DCreate8'](runtime, () => sdk).result);
  for (const sdk of [0, 32, 219])
    assert.equal(d3d9Apis['d3d8.dll!Direct3DCreate8'](runtime, () => sdk).result, 0);
  const device = await create();
  assert.equal(events[0].depth, true);
  assert.equal(events[0].windowId, 0x20000);
  assert.equal(runtime.comObjects.objects.get(device).iid, '7385e5df-8fe8-41d5-86b6-d7b48547b6cf');
  assert.equal((await call(device, 76, 0x42)).argc, 2);
  const out = runtime.allocate(4);
  assert.equal((await call(device, 77, out)).result, 0);
  assert.equal(runtime.read32(out), 0x42);
  await assert.rejects(call(device, 76, 0x10001), /Unsupported.*SetFVF/);
  assert.equal((await call(device, 36, 0, 0, 3, 0xff123456, 0x3f800000, 0)).argc, 7);
  assert.equal((await call(device, 34)).result, 0);
  assert.equal((await call(device, 35)).result, 0);
  assert.equal((await call(device, 15, 0, 0, 0, 0)).argc, 5);
  assert.equal(events.at(-1).commands[0].color, 0xff123456);
  assert.equal((await call(factory, 2)).result, 1);
  assert.equal((await call(device, 2)).result, 0);
  await assert.rejects(call(factory, 4), /Released COM object/);
});

for (const version of [8, 9]) {
  test(`D3D${version} display enumeration matches USER32 and validates outputs atomically`, async () => {
    const { runtime, call, factory, create } = fixture(version);
    const output = runtime.allocate(24),
      pointer = output + 4;
    runtime.data.fill(0xa5, output, output + 24);
    const current = await call(factory, 8, 0, pointer);
    assert.deepEqual(current, { result: 0, argc: 3 });
    assert.deepEqual(
      Array.from({ length: 4 }, (_, i) => runtime.read32(pointer + i * 4)),
      [1024, 768, 60, 22],
    );
    assert.equal(runtime.read32(output), 0xa5a5a5a5);
    assert.equal(runtime.read32(output + 20), 0xa5a5a5a5);
    assert.equal((await call(factory, 6, 0, 22)).result, version === 8 ? 6 : 3);
    assert.equal((await call(factory, 6, 1, 22)).result, 0);
    if (version === 9) assert.equal((await call(factory, 6, 0, 23)).result, 3);
    const enumArgs = (adapter, mode, ptr) =>
      version === 8 ? [adapter, mode, ptr] : [adapter, 22, mode, ptr];
    assert.deepEqual(await call(factory, 7, ...enumArgs(0, 0, pointer)), {
      result: 0,
      argc: version === 8 ? 4 : 5,
    });
    const snapshot = runtime.data.slice(output, output + 24);
    for (const [slot, args] of [
      [8, [1, pointer]],
      [8, [0, 0]],
      [8, [0, runtime.data.length - 12]],
      [7, enumArgs(1, 0, pointer)],
      [7, enumArgs(0, version === 8 ? 6 : 3, pointer)],
      [7, enumArgs(0, 0, 0)],
      [7, enumArgs(0, 0, runtime.data.length - 12)],
      ...(version === 9 ? [[7, [0, 21, 0, pointer]]] : []),
    ])
      assert.equal((await call(factory, slot, ...args)).result, 0x8876086c);
    assert.deepEqual(runtime.data.slice(output, output + 24), snapshot);
    const device = await create(); // Its 640x480 backbuffer is not the desktop mode.
    await call(factory, 8, 0, pointer);
    assert.equal(runtime.read32(pointer), 1024);
    assert.equal(runtime.read32(pointer + 4), 768);
    await call(device, 2);
    await call(factory, 2);
  });
}

for (const version of [8, 9]) {
  test(`D3D${version} depth matching exposes only the implemented D16 attachment`, async () => {
    const { call, factory } = fixture(version);
    for (const color of [21, 22])
      assert.deepEqual(await call(factory, 12, 0, 1, 22, color, 80), { result: 0, argc: 6 });
    for (const depth of [0, 70, 75, 77, 79])
      assert.equal((await call(factory, 12, 0, 1, 22, 22, depth)).result, 0x8876086a);
    assert.equal((await call(factory, 12, 0, 1, 23, 22, 80)).result, 0);
    assert.equal((await call(factory, 12, 0, 1, 22, 23, 80)).result, 0);
    assert.equal((await call(factory, 12, 0, 2, 22, 22, 80)).result, 0x8876086a);
    assert.equal((await call(factory, 12, 1, 1, 22, 22, 80)).result, 0x8876086c);
  });
}

for (const version of [8, 9]) {
  test(`D3D${version} factory/device capability ABI validates whole outputs and reports only implemented paths`, async () => {
    const { runtime, call, factory, create } = fixture(version);
    const size = version === 8 ? 212 : 304,
      output = runtime.allocate(size + 8),
      p = output + 4;
    runtime.data.fill(0xcc, output, output + size + 8);
    const slot = version === 8 ? 13 : 14;
    for (const [adapter, type, pointer, error] of [
      [1, 1, p, 0x8876086c],
      [0, 2, p, 0x8876086b],
      [0, 1, 0, 0x8876086c],
      [0, 1, runtime.data.length - size + 1, 0x8876086c],
    ])
      assert.equal((await call(factory, slot, adapter, type, pointer)).result, error);
    assert.ok(runtime.data.subarray(output, output + size + 8).every((v) => v === 0xcc));
    assert.deepEqual(await call(factory, slot, 0, 1, p), { result: 0, argc: 4 });
    assert.equal(runtime.read32(output), 0xcccccccc);
    assert.equal(runtime.read32(p + size), 0xcccccccc);
    assert.equal(runtime.read32(p), 1);
    assert.equal(runtime.read32(p + 8 * 4), version === 9 ? 0x208f2 : 0x8f2);
    assert.equal(runtime.read32(p + 10 * 4), 0xff);
    assert.equal(runtime.read32(p + 11 * 4), version === 9 ? 0x3fff : 0x1fff);
    assert.equal(runtime.read32(p + 12 * 4), version === 9 ? 0x27ff : 0x7ff);
    assert.equal(runtime.read32(p + 14 * 4), 0x4208);
    assert.equal(runtime.read32(p + 9 * 4) & 1, 1); // D3DPRASTERCAPS_DITHER.
    assert.ok(runtime.view.getFloat32(p + 28 * 4, true) > 0);
    for (const index of [17, 18, 34, 47, 49, 51]) assert.equal(runtime.read32(p + index * 4), 0);
    assert.equal(runtime.read32(p + 15 * 4), 0x4005);
    assert.equal(runtime.read32(p + 16 * 4), 0x03030300);
    assert.equal(runtime.read32(p + 22 * 4), 2048);
    assert.equal(runtime.read32(p + 38 * 4), 1);
    assert.equal(runtime.read32(p + 39 * 4), 0x3a);
    assert.equal(runtime.read32(p + 40 * 4), 8);
    assert.equal((await call(factory, 10, 0, 1, 22, 0, 3, 21)).result, 0);
    assert.equal((await call(factory, 10, 0, 1, 23, 0x200, 3, 23)).result, 0);
    assert.equal((await call(factory, 10, 0, 1, 22, 1, 3, 21)).result, 0x8876086a);
    assert.equal((await call(factory, 10, 0, 1, 22, 0, 3, 0x31545844)).result, 0x8876086a);
    const expected = runtime.data.slice(p, p + size),
      device = await create();
    runtime.data.fill(0xee, p, p + size);
    assert.deepEqual(await call(device, 7, p), { result: 0, argc: 2 });
    assert.deepEqual(runtime.data.slice(p, p + size), expected);
    await call(device, 2);
    await call(factory, 2);
  });
}

for (const version of [8, 9]) {
  test(`D3D${version} depth/cull state queries and queued draws preserve the selected state`, async () => {
    const { runtime, call, create, events } = fixture(version);
    const setState = version === 8 ? 50 : 57,
      getState = version === 8 ? 51 : 58;
    const d = await create(),
      p = runtime.allocate(4),
      vertices = runtime.allocate(48);
    await call(d, setState, 137, 0);
    for (const [state, value] of [
      [8, 3],
      [9, 2],
      [136, 1],
    ]) {
      await call(d, getState, state, p);
      assert.equal(runtime.read32(p), value);
      assert.equal((await call(d, setState, state, value)).result, 0);
    }
    for (const [state, value] of [
      [8, 2],
      [9, 1],
      [136, 0],
    ])
      await assert.rejects(call(d, setState, state, value), /Unsupported.*SetRenderState/);
    await call(d, getState, 26, p);
    assert.equal(runtime.read32(p), 0);
    await call(d, setState, 26, 1);
    await call(d, getState, 26, p);
    assert.equal(runtime.read32(p), 1);
    await call(d, version === 8 ? 76 : 89, 0x42);
    await call(d, setState, 22, 3);
    await call(d, setState, 23, 5);
    await call(d, getState, 22, p);
    assert.equal(runtime.read32(p), 3);
    await call(d, getState, 23, p);
    assert.equal(runtime.read32(p), 5);
    await call(d, version === 8 ? 34 : 41);
    await call(d, version === 8 ? 72 : 83, 4, 1, vertices, 16);
    await call(d, version === 8 ? 35 : 42);
    await call(d, setState, 22, 1);
    await call(d, setState, 23, 1);
    await call(d, setState, 26, 0);
    await call(d, version === 8 ? 15 : 17, 0, 0, 0, 0);
    assert.equal(events.at(-1).commands[0].cullMode, 'ccw');
    assert.equal(events.at(-1).commands[0].depthCompare, 'greater');
    assert.equal(events.at(-1).commands[0].dither, true);
    await assert.rejects(call(d, setState, 26, 2), /Unsupported.*SetRenderState/);
    await assert.rejects(call(d, setState, 23, 9), /Unsupported.*SetRenderState/);
    await call(d, 2);
  });

  test(`D3D${version} Set/GetTransform preserve nonfinite bit patterns until the application replaces startup state`, async () => {
    const { runtime, call, create } = fixture(version);
    const d = await create(),
      p = runtime.allocate(64),
      q = runtime.allocate(64);
    runtime.write32(p, 0x7fa12345);
    runtime.write32(p + 40, 0xffc00000);
    await call(d, version === 8 ? 37 : 44, 3, p);
    runtime.data.fill(0, p, p + 64);
    await call(d, version === 8 ? 38 : 45, 3, q);
    assert.equal(runtime.read32(q), 0x7fa12345);
    assert.equal(runtime.read32(q + 40), 0xffc00000);
    await call(d, version === 8 ? 37 : 44, 3, p);
    await call(d, version === 8 ? 38 : 45, 3, q);
    assert.ok(runtime.data.subarray(q, q + 64).every((v) => v === 0));
    await call(d, 2);
  });
}

for (const version of [8, 9]) {
  test(`D3D${version} viewport ABI, bounds and queued draw/clear snapshots`, async () => {
    const { runtime: r, call, create, events } = fixture(version);
    const d = await create(),
      p = r.allocate(32),
      q = r.allocate(24),
      rects = r.allocate(48);
    const set = version === 8 ? 40 : 47,
      get = version === 8 ? 41 : 48,
      clear = version === 8 ? 36 : 43;
    const write = (x, y, width, height, minZ = 0, maxZ = 1) => {
      [x, y, width, height].forEach((v, i) => r.write32(p + i * 4, v));
      r.view.setFloat32(p + 16, minZ, true);
      r.view.setFloat32(p + 20, maxZ, true);
    };
    const read = (ptr) =>
      [0, 4, 8, 12]
        .map((i) => r.read32(ptr + i))
        .concat([16, 20].map((i) => r.view.getFloat32(ptr + i, true)));
    assert.deepEqual(await call(d, get, q), { result: 0, argc: 2 });
    assert.deepEqual(read(q), [0, 0, 640, 480, 0, 1]);
    for (const v of [
      [639, 0, 2, 1],
      [0, 480, 1, 1],
      [0xffffffff, 0, 1, 1],
      [0, 0, 10, 10, NaN, 1],
      [0, 0, 10, 10, 1, 0],
    ]) {
      write(...v);
      assert.equal((await call(d, set, p)).result, 0x8876086c);
    }
    for (const ptr of [0, r.data.length - 20]) {
      assert.equal((await call(d, get, ptr)).result, 0x8876086c);
      assert.equal((await call(d, set, ptr)).result, 0x8876086c);
    }
    await call(d, get, q);
    assert.deepEqual(read(q), [0, 0, 640, 480, 0, 1]);
    write(100, 50, 200, 150, 0.25, 0.75);
    assert.deepEqual(await call(d, set, p), { result: 0, argc: 2 });
    await call(d, get, q);
    assert.deepEqual(read(q), [100, 50, 200, 150, 0.25, 0.75]);
    // Signed screen rectangles intersect the viewport, including negative starts.
    [-20, -10, 150, 100, 250, 175, 500, 300, 400, 400, 500, 500].forEach((v, i) =>
      r.write32(rects + i * 4, v),
    );
    await call(d, clear, 3, rects, 3, 0xff123456, 0x3f800000, 0);
    await call(d, clear, 0, 0, 1, 0xff112233, 0, 0);
    const v = r.allocate(48);
    await call(d, version === 8 ? 50 : 57, 137, 0);
    await call(d, version === 8 ? 76 : 89, 0x42);
    await call(d, version === 8 ? 34 : 41);
    await call(d, version === 8 ? 72 : 83, 4, 1, v, 16);
    await call(d, version === 8 ? 35 : 42);
    write(0, 0, 640, 480);
    await call(d, set, p);
    r.data.fill(0, rects, rects + 48);
    for (const [count, ptr] of [
      [1, 0],
      [0, rects],
      [3, r.data.length - 16],
    ])
      assert.equal((await call(d, clear, count, ptr, 1, 0, 0, 0)).result, 0x8876086c);
    await call(d, version === 8 ? 15 : 17, 0, 0, 0, 0);
    const commands = events.at(-1).commands;
    assert.equal(commands.length, 3);
    assert.deepEqual(commands[0].regions, [
      { x: 100, y: 50, width: 50, height: 50 },
      { x: 250, y: 175, width: 50, height: 25 },
    ]);
    assert.deepEqual(commands[1].regions, [{ x: 100, y: 50, width: 200, height: 150 }]);
    assert.deepEqual(commands[2].viewport, {
      x: 100,
      y: 50,
      width: 200,
      height: 150,
      minZ: 0.25,
      maxZ: 0.75,
    });
    await call(d, 2);
  });
}

for (const version of [8, 9]) {
  const slots =
    version === 8
      ? {
          create: 20,
          bind: 61,
          get: 60,
          stage: 63,
          getStage: 62,
          sampler: 63,
          getSampler: 62,
          lock: 16,
          unlock: 17,
          desc: 14,
          scene: 34,
          end: 35,
          draw: 72,
          render: 50,
          fvf: 76,
          present: 15,
        }
      : {
          create: 23,
          bind: 65,
          get: 64,
          stage: 67,
          getStage: 66,
          sampler: 69,
          getSampler: 68,
          lock: 19,
          unlock: 20,
          desc: 17,
          scene: 41,
          end: 42,
          draw: 83,
          render: 57,
          fvf: 89,
          present: 17,
        };
  test(`D3D${version} texture mip locks, formats, ABI and binding lifetime`, async () => {
    const { runtime: r, call, create, output, freed } = fixture(version),
      d = await create();
    const make = async (format, width = 3, height = 2, levels = 0, usage = 0, pool = 1) => {
      const result = await call(
        d,
        slots.create,
        width,
        height,
        levels,
        usage,
        format,
        pool,
        output,
        0,
      );
      assert.equal(result.argc, version === 8 ? 8 : 9);
      assert.equal(result.result, 0);
      return r.read32(output);
    };
    const tex = await make(21),
      obj = r.comObjects.objects.get(tex);
    assert.equal((await call(tex, 13)).result, 2);
    const desc = r.allocate(36);
    r.write32(desc + 32, 0x12345678);
    assert.equal((await call(tex, slots.desc, 0, desc)).result, 0);
    assert.deepEqual(
      Array.from({ length: 8 }, (_, i) => r.read32(desc + i * 4)),
      version === 8 ? [21, 1, 0, 1, 24, 0, 3, 2] : [21, 1, 0, 1, 0, 0, 3, 2],
    );
    assert.equal(r.read32(desc + 32), 0x12345678);
    assert.equal((await call(tex, slots.desc, 2, desc)).result, 0x8876086c);
    const locked = r.allocate(8),
      rect = r.allocate(16);
    [1, 0, 3, 2].forEach((v, i) => r.write32(rect + i * 4, v));
    assert.equal((await call(tex, slots.lock, 0, locked, rect, 0)).argc, 5);
    assert.equal(r.read32(locked), 12);
    assert.equal(r.read32(locked + 4), obj.state.base + 4);
    assert.equal((await call(tex, slots.lock, 0, locked, 0, 0)).result, 0x8876086c);
    r.write32(r.read32(locked + 4), 0x7f112233);
    assert.equal((await call(tex, slots.unlock, 0)).result, 0);
    assert.equal((await call(tex, slots.unlock, 0)).result, 0x8876086c);
    r.write32(rect + 8, 4);
    assert.equal((await call(tex, slots.lock, 0, locked, rect, 0)).result, 0x8876086c);
    assert.equal((await call(tex, slots.lock, 0, locked, 0, 0x2000)).result, 0x8876086c);
    assert.equal((await call(tex, 11, 99)).result, 0);
    assert.equal((await call(tex, 12)).result, 1);
    assert.equal((await call(tex, 11, 0)).result, 1);
    assert.equal((await call(d, slots.bind, 0, tex)).result, 0);
    assert.equal((await call(tex, 2)).result, 0);
    assert.equal(freed.includes(obj.state.base), false, 'binding retains backing memory');
    assert.equal((await call(d, slots.get, 0, output)).result, 0);
    assert.equal(r.read32(output), tex);
    assert.equal((await call(tex, 3, output)).result, 0);
    assert.equal(r.read32(output), d);
    await call(d, 2);
    await call(tex, 2);
    assert.equal((await call(d, slots.bind, 0, 0)).result, 0);
    assert.equal(freed.filter((p) => p === obj.state.base).length, 1);
    assert.equal(r.d3dTextureBytes, 0);
    await assert.rejects(call(tex, 13), /Released COM object/);
    const { textureSnapshot } = await import('../src/d3d9-textures.js');
    for (const [format, raw, expected] of [
      [21, 0x7f112233, [17, 34, 51, 127]],
      [22, 0x00112233, [17, 34, 51, 255]],
      [23, 0xf800, [255, 0, 0, 255]],
      [24, 0x001f, [0, 0, 255, 255]],
      [25, 0x83e0, [0, 255, 0, 255]],
      [26, 0x8123, [17, 34, 51, 136]],
      [28, 127, [255, 255, 255, 127]],
    ]) {
      const t = await make(format, 1, 1, 1),
        o = r.comObjects.objects.get(t);
      await call(t, slots.lock, 0, locked, 0, 0);
      const p = r.read32(locked + 4);
      if (format === 28) r.data[p] = raw;
      else if (format >= 23) r.view.setUint16(p, raw, true);
      else r.write32(p, raw);
      await call(t, slots.unlock, 0);
      assert.deepEqual([...textureSnapshot(r, o).levels[0].rgba], expected);
      await call(t, 2);
    }
    const dynamic = await make(21, 2, 2, 1, 0x200, 0);
    assert.equal((await call(dynamic, slots.lock, 0, locked, 0, 0x2000)).result, 0);
    assert.equal((await call(dynamic, slots.unlock, 0)).result, 0);
    await call(dynamic, 2);
    const bound = await make(21, 1, 1, 1);
    await call(d, slots.bind, 0, bound);
    await call(bound, 2);
    await call(d, 2);
    assert.equal(r.d3dTextureBytes, 0, 'device destruction frees internally owned textures');
  });
  test(`D3D${version} texture/sampler state and immutable draw snapshots`, async () => {
    const { runtime: r, call, create, output, events } = fixture(version),
      d = await create();
    const bias = version === 8 ? 19 : 8,
      mag = version === 8 ? 16 : 5;
    await call(d, slots.getSampler, 0, bias, output);
    assert.equal(r.read32(output), 0);
    await call(d, slots.sampler, 0, bias, 0xbf800000);
    await call(d, slots.getSampler, 0, bias, output);
    assert.equal(r.read32(output), 0xbf800000);
    await call(d, slots.sampler, 0, mag, 2);
    await assert.rejects(call(d, slots.sampler, 0, bias, 0x7fc00000), /Unsupported.*sampler/);
    await call(d, slots.stage, 0, 1, 4);
    await call(d, slots.getStage, 0, 1, output);
    assert.equal(r.read32(output), 4);
    assert.equal((await call(d, slots.stage, 8, 1, 1)).result, 0x8876086c);
    await call(d, slots.create, 2, 2, 1, 0, 21, 1, output, 0);
    const t = r.read32(output),
      locked = r.allocate(8);
    await call(t, slots.lock, 0, locked, 0, 0);
    const data = r.read32(locked + 4);
    r.write32(data, 0xff112233);
    await call(t, slots.unlock, 0);
    await call(d, slots.bind, 0, t);
    await call(d, slots.render, 137, 0);
    await call(d, slots.fvf, 0x142);
    await call(d, slots.scene);
    const vertices = r.allocate(72);
    for (let i = 0; i < 3; i++) r.write32(vertices + i * 24 + 12, 0xffffffff);
    await call(d, slots.draw, 4, 1, vertices, 24);
    await call(d, slots.draw, 4, 1, vertices, 24);
    await call(t, slots.lock, 0, locked, 0, 0);
    await assert.rejects(call(d, slots.draw, 4, 1, vertices, 24), /locked texture/);
    r.write32(data, 0xffaabbcc);
    await call(t, slots.unlock, 0);
    await call(d, slots.sampler, 0, bias, 0x40000000);
    await call(d, slots.draw, 4, 1, vertices, 24);
    await call(d, slots.end);
    await call(d, slots.present, 0, 0, 0, 0);
    const draws = events.at(-1).commands;
    assert.equal(
      draws[0].texturing.texture,
      draws[1].texturing.texture,
      'unchanged texels share one upload',
    );
    assert.notEqual(draws[0].texturing.texture, draws[2].texturing.texture);
    assert.deepEqual([...draws[0].texturing.texture.levels[0].rgba.slice(0, 4)], [17, 34, 51, 255]);
    assert.deepEqual(
      [...draws[2].texturing.texture.levels[0].rgba.slice(0, 4)],
      [170, 187, 204, 255],
    );
    assert.equal(draws[0].texturing.sampler[8], 0xbf800000);
    assert.equal(draws[2].texturing.sampler[8], 0x40000000);
    assert.equal(r.comObjects.objects.get(d).state.frameBytes, 0);
    await call(d, slots.bind, 0, 0);
    await call(t, 2);
    await call(d, 2);
  });
}

for (const version of [8, 9])
  test(`D3D${version} texture failures preserve memory and device ownership`, async () => {
    const { runtime: r, call, create, output, freed } = fixture(version),
      d = await create();
    const device = r.comObjects.objects.get(d),
      slot = version === 8 ? 20 : 23,
      lock = version === 8 ? 16 : 19,
      unlock = lock + 1,
      bind = version === 8 ? 61 : 65;
    const args = [2, 2, 1, 0, 21, 1, output, 0];
    for (const [index, value] of [
      [0, 0],
      [0, 2049],
      [2, 3],
      [3, 1],
      [4, 0x31545844],
      [5, 4],
      ...(version === 9 ? [[7, output]] : []),
    ]) {
      const bad = [...args];
      bad[index] = value;
      r.write32(output, 0x12345678);
      assert.equal((await call(d, slot, ...bad)).result, 0x8876086c);
      assert.equal(r.read32(output), 0);
      assert.equal(device.refs, 1);
      assert.equal(r.d3dTextureBytes ?? 0, 0);
    }
    r.d3dTextureBytes = 32 * 1024 * 1024;
    assert.equal((await call(d, slot, ...args)).result, 0x8876017c);
    assert.equal(device.refs, 1);
    r.d3dTextureBytes = 0;
    const createObject = r.comObjects.create;
    r.comObjects.create = () => {
      throw Error('injected object allocation failure');
    };
    await assert.rejects(call(d, slot, ...args), /injected/);
    r.comObjects.create = createObject;
    assert.equal(freed.length, 1);
    assert.equal(device.refs, 1);
    assert.equal(r.d3dTextureBytes, 0);
    await call(d, slot, ...args);
    const t = r.read32(output),
      object = r.comObjects.objects.get(t),
      p = r.allocate(8);
    await call(d, bind, 0, t);
    const other = await create();
    assert.equal((await call(other, bind, 0, t)).result, 0x8876086c);
    const { textureSnapshot } = await import('../src/d3d9-textures.js');
    const before = textureSnapshot(r, object);
    await call(t, lock, 0, p, 0, 0x10);
    assert.equal((await call(t, unlock, 0)).result, 0);
    assert.equal(
      textureSnapshot(r, object),
      before,
      'read-only locks do not trigger another upload',
    );
    r.write32(p, 0x12345678);
    r.write32(p + 4, 0xabcdef01);
    assert.equal((await call(t, lock, 8, p, 0, 0)).result, 0x8876086c);
    assert.equal(r.read32(p), 0x12345678);
    assert.equal(r.read32(p + 4), 0xabcdef01);
    await call(t, 2);
    await call(d, 2);
    await call(other, 2);
    assert.equal(r.d3dTextureBytes, 0);
  });

for (const version of [8, 9]) {
  const slots =
    version === 8
      ? {
          material: 42,
          getMaterial: 43,
          light: 44,
          getLight: 45,
          enable: 46,
          getEnable: 47,
          set: 50,
          get: 51,
          fvf: 76,
          scene: 34,
          draw: 72,
          end: 35,
          present: 15,
        }
      : {
          material: 49,
          getMaterial: 50,
          light: 51,
          getLight: 52,
          enable: 53,
          getEnable: 54,
          set: 57,
          get: 58,
          fvf: 89,
          scene: 41,
          draw: 83,
          end: 42,
          present: 17,
        };
  test(`D3D${version} materials and lights use native structures with atomic validation`, async () => {
    const { runtime: r, call, create, output } = fixture(version),
      d = await create(),
      material = r.allocate(72),
      light = r.allocate(108),
      copy = r.allocate(108);
    assert.equal((await call(d, slots.getMaterial, copy)).argc, 2);
    assert.ok(r.data.subarray(copy, copy + 68).every((v) => v === 0));
    for (let i = 0; i < 17; i++) r.view.setFloat32(material + i * 4, i / 16, true);
    r.write32(copy + 68, 0xabcdef01);
    assert.equal((await call(d, slots.material, material)).result, 0);
    await call(d, slots.getMaterial, copy);
    assert.deepEqual(r.data.slice(copy, copy + 68), r.data.slice(material, material + 68));
    assert.equal(r.read32(copy + 68), 0xabcdef01);
    r.write32(material + 64, 0x7fc00000);
    assert.equal((await call(d, slots.material, material)).result, 0x8876086c);
    r.write32(material + 64, 0xbf800000);
    assert.equal((await call(d, slots.material, material)).result, 0x8876086c);
    await call(d, slots.getMaterial, copy);
    assert.equal(r.read32(copy + 64), 0x3f800000);
    assert.equal((await call(d, slots.getLight, 19, copy)).result, 0x8876086c);
    assert.equal((await call(d, slots.enable, 19, 0)).result, 0);
    await call(d, slots.getLight, 19, copy);
    assert.equal(r.read32(copy), 3);
    assert.equal(r.read32(copy + 4), 0x3f800000);
    assert.equal(r.read32(copy + 72), 0x3f800000);
    await call(d, slots.getEnable, 19, output);
    assert.equal(r.read32(output), 0);
    r.write32(light, 1);
    r.view.setFloat32(light + 76, 10, true);
    r.view.setFloat32(light + 84, 1, true);
    assert.equal((await call(d, slots.light, 0xffffffff, light)).argc, 3);
    r.write32(copy + 104, 0xfeedbeef);
    await call(d, slots.getLight, 0xffffffff, copy);
    assert.deepEqual(r.data.slice(copy, copy + 104), r.data.slice(light, light + 104));
    assert.equal(r.read32(copy + 104), 0xfeedbeef);
    r.view.setFloat32(light + 84, -1, true);
    assert.equal((await call(d, slots.light, 0xffffffff, light)).result, 0x8876086c);
    await call(d, slots.getLight, 0xffffffff, copy);
    assert.equal(r.read32(copy + 84), 0x3f800000);
    await assert.rejects(call(d, slots.getLight, 0xffffffff, r.data.length - 100), /memory/);
    for (let i = 0; i < 8; i++) assert.equal((await call(d, slots.enable, i, 1)).result, 0);
    assert.equal((await call(d, slots.enable, 8, 1)).result, 0x8876086c);
    await call(d, slots.getEnable, 0, output);
    assert.equal(r.read32(output), 128);
    await call(d, slots.enable, 0, 0);
    assert.equal((await call(d, slots.enable, 8, 1)).result, 0);
    await call(d, 2);
  });
  test(`D3D${version} lighting and material-source states survive queued draws`, async () => {
    const { runtime: r, call, create, output, events } = fixture(version),
      d = await create();
    for (const [state, value] of [
      [29, 0],
      [137, 1],
      [139, 0],
      [141, 1],
      [142, 1],
      [143, 0],
      [145, 1],
      [146, 2],
      [147, 0],
      [148, 0],
    ]) {
      await call(d, slots.get, state, output);
      assert.equal(r.read32(output), value);
    }
    assert.equal((await call(d, slots.set, 146, 0)).result, 0);
    assert.equal((await call(d, slots.set, 146, 3)).result, 0x8876086c);
    const vertices = r.allocate(96),
      m = r.allocate(68);
    r.view.setFloat32(m, 1, true);
    r.view.setFloat32(m + 12, 0.5, true);
    await call(d, slots.material, m);
    await call(d, slots.enable, 4, 1);
    await call(d, slots.set, 143, 1);
    await call(d, slots.set, 139, 0xff804020);
    await call(d, slots.fvf, 0x112);
    await call(d, slots.scene);
    assert.equal((await call(d, slots.draw, 4, 1, vertices, 32)).result, 0);
    r.view.setFloat32(m, 0, true);
    await call(d, slots.material, m);
    await call(d, slots.enable, 4, 0);
    await call(d, slots.set, 143, 0);
    await call(d, slots.draw, 4, 1, vertices, 32);
    await call(d, slots.end);
    await call(d, slots.present, 0, 0, 0, 0);
    const commands = events.at(-1).commands;
    assert.equal(commands[0].lighting.material[0], 1);
    assert.equal(commands[1].lighting.material[0], 0);
    assert.equal(commands[0].lighting.lights.length, 1);
    assert.equal(commands[1].lighting.lights.length, 0);
    assert.equal(commands[0].lighting.states[143], 1);
    assert.equal(commands[1].lighting.states[143], 0);
    assert.equal(commands[0].lighting.states[146], 0);
    await call(d, 2);
  });
}

for (const version of [8, 9]) {
  test(`D3D${version} blend states validate, round-trip and stay immutable in queued draws`, async () => {
    const { runtime: r, call, create, output, events } = fixture(version),
      d = await create();
    const set = version === 8 ? 50 : 57,
      get = version === 8 ? 51 : 58;
    const defaults = {
      19: 2,
      20: 1,
      27: 0,
      168: 15,
      171: 1,
      ...(version === 9 ? { 193: 0xffffffff, 206: 0, 207: 2, 208: 1, 209: 1 } : {}),
    };
    for (const [state, value] of Object.entries(defaults)) {
      assert.equal((await call(d, get, +state, output)).result, 0);
      assert.equal(r.read32(output), value);
    }
    for (const [state, value] of [
      [19, 0],
      [19, 16],
      [20, 12],
      [20, 13],
      [27, 2],
      [168, 16],
      [171, 0],
      [171, 6],
      ...(version === 8
        ? [
            [19, 14],
            [20, 15],
          ]
        : [
            [206, 2],
            [207, 12],
            [208, 13],
            [209, 6],
          ]),
    ]) {
      assert.equal((await call(d, set, state, value)).result, 0x8876086c);
      await call(d, get, state, output);
      assert.equal(r.read32(output), defaults[state]);
    }
    if (version === 8)
      for (const state of [193, 206, 207, 208, 209])
        await assert.rejects(() => call(d, set, state, 0), /Unsupported/);
    for (const factor of [
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      ...(version === 9 ? [14, 15] : []),
    ]) {
      assert.equal((await call(d, set, 19, factor)).result, 0);
      await call(d, get, 19, output);
      assert.equal(r.read32(output), factor);
    }
    const vertices = r.allocate(48);
    await call(d, set, 137, 0);
    await call(d, version === 8 ? 76 : 89, 0x42);
    await call(d, version === 8 ? 34 : 41);
    for (const [state, value] of [
      [19, 5],
      [20, 6],
      [27, 1],
      [168, 3],
      [171, 3],
    ])
      await call(d, set, state, value);
    assert.equal((await call(d, version === 8 ? 72 : 83, 4, 1, vertices, 16)).result, 0);
    for (const [state, value] of [
      [19, 2],
      [27, 0],
      [168, 15],
      [171, 1],
    ])
      await call(d, set, state, value);
    await call(d, version === 8 ? 72 : 83, 4, 1, vertices, 16);
    await call(d, version === 8 ? 35 : 42);
    await call(d, version === 8 ? 15 : 17, 0, 0, 0, 0);
    const [a, b] = events.at(-1).commands;
    assert.deepEqual(
      [a.blend[19], a.blend[20], a.blend[27], a.blend[168], a.blend[171]],
      [5, 6, 1, 3, 3],
    );
    assert.deepEqual([b.blend[19], b.blend[27], b.blend[168], b.blend[171]], [2, 0, 15, 1]);
    await call(d, 2);
  });
}

for (const version of [8, 9]) {
  test(`D3D${version} disabled effects are queryable without claiming enabled rendering`, async () => {
    const { runtime: r, call, create, output } = fixture(version),
      d = await create();
    const set = version === 8 ? 50 : 57,
      get = version === 8 ? 51 : 58;
    for (const state of [15, 28, 52]) {
      await call(d, get, state, output);
      assert.equal(r.read32(output), 0);
      assert.equal((await call(d, set, state, 0)).result, 0);
      await assert.rejects(() => call(d, set, state, 1), new RegExp(`Unsupported.*${state}=1`));
      await call(d, get, state, output);
      assert.equal(r.read32(output), 0);
    }
    for (const [state, value] of [
      [24, 0x123456ab],
      [25, 5],
      [34, 0x10203040],
      [35, 3],
      [36, 0x7fc01234],
      [37, 0x3f000000],
      [38, 0x3e800000],
      [48, 1],
      [140, 2],
      [53, 3],
      [54, 4],
      [55, 8],
      [56, 7],
      [57, 0x12345678],
      [58, 0xffffff00],
      [59, 0xff00ffff],
    ]) {
      assert.equal((await call(d, set, state, value)).result, 0);
      await call(d, get, state, output);
      assert.equal(r.read32(output), value);
      if ([25, 53, 54, 55, 56].includes(state)) {
        assert.equal((await call(d, set, state, 9)).result, 0x8876086c);
        await call(d, get, state, output);
        assert.equal(r.read32(output), value);
      }
    }
    await call(d, 2);
  });
}

for (const version of [8, 9]) {
  test(`D3D${version} GetDirect3D returns its original factory with independent ownership`, async () => {
    const { runtime, events, call, factory, create } = fixture(version),
      device = await create();
    const parent = runtime.comObjects.objects.get(factory),
      out = runtime.allocate(4);
    assert.equal(parent.refs, 2);
    assert.equal(
      (await call(factory, 2)).result,
      1,
      'device keeps its parent alive after the caller releases it',
    );
    assert.deepEqual(await call(device, 6, out), { result: 0, argc: 2 });
    assert.equal(runtime.read32(out), factory);
    assert.equal(parent.refs, 2);
    const second = runtime.allocate(4);
    assert.equal((await call(device, 6, second)).result, 0);
    assert.equal(runtime.read32(second), factory);
    assert.equal(parent.refs, 3);
    assert.equal((await call(factory, 2)).result, 2, 'release one returned reference');
    assert.equal((await call(device, 2)).result, 0);
    assert.equal(events.at(-1).type, 'destroy');
    assert.equal(parent.refs, 1, 'a returned factory reference survives device destruction');
    assert.equal((await call(factory, 4)).result, 1);
    assert.equal((await call(factory, 2)).result, 0);
    await assert.rejects(call(factory, 4), /Released COM object/);
    await assert.rejects(call(device, 6, out), /Released COM object/);
  });
  test(`D3D${version} parent queries validate outputs and reference limits before mutation`, async () => {
    const { runtime, call, factory, create, events } = fixture(version),
      device = await create();
    const parent = runtime.comObjects.objects.get(factory),
      out = runtime.allocate(4);
    runtime.write32(out, 0xaabbccdd);
    assert.equal((await call(device, 6, 0)).result, 0x8876086c);
    await assert.rejects(call(device, 6, 0xffffffff), /memory violation/);
    assert.equal(parent.refs, 2);
    parent.refs = 0x7fffffff;
    await assert.rejects(call(device, 6, out), /reference count limit/);
    assert.equal(parent.refs, 0x7fffffff);
    assert.equal(runtime.read32(out), 0xaabbccdd);
    const count = runtime.comObjects.objects.size;
    await assert.rejects(create(), /reference count limit/);
    assert.equal(runtime.comObjects.objects.size, count);
    assert.equal(events.length, 1);
    parent.refs = 2;
    await call(device, 2);
    await call(factory, 2);
  });
}

for (const fail of [false, true]) {
  test(`pending GPU device creation retains its factory and ${fail ? 'rolls back on failure' : 'transfers ownership on success'}`, async () => {
    const { runtime, call, factory, create, output } = fixture(),
      parent = runtime.comObjects.objects.get(factory);
    let finish;
    runtime.graphics.createDevice = () =>
      new Promise((resolve, reject) => {
        finish = fail ? () => reject(Error('GPU failure')) : resolve;
      });
    const pending = create();
    assert.equal(parent.refs, 2);
    assert.equal((await call(factory, 2)).result, 1);
    finish();
    if (fail) {
      await assert.rejects(pending, /GPU failure/);
      assert.equal(runtime.read32(output), 0);
      assert.equal(parent.refs, 0);
    } else {
      const device = await pending,
        out = runtime.allocate(4);
      assert.equal((await call(device, 6, out)).result, 0);
      assert.equal(runtime.read32(out), factory);
      await call(device, 2);
      assert.equal(parent.refs, 1);
      await call(factory, 2);
    }
    assert.equal(parent.refs, 0);
  });
}
