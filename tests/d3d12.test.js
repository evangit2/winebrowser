import test from 'node:test';
import assert from 'node:assert/strict';
import { d3d12Apis, dxgiApis } from '../src/d3d12.js';

const IID = {
  factory: '7b7166ec-21c7-44ae-b21a-c9ae321ae369',
  device: '189819f1-1db6-4b57-be54-1821339b85f7',
  queue: '0ec870a6-5d7e-4c22-8cfc-5baae07616ed',
  heap: '8efb471d-616c-4f49-90f7-127bb763fa51',
  resource: '696442be-a72e-4059-bc79-5b5c98040fad',
  allocator: '6102dee4-af59-4b09-b999-b44d73f09b24',
  list: '5b160d0f-ac1b-4185-8ba8-b3ae42a5a455',
  root: 'c54a6b66-72df-4ee8-8be5-a946a1429214',
  pipeline: '765a30f3-f624-4c6f-a828-ace948622445',
  fence: '0a753dcf-c4d8-4b91-adf6-be5a60d95a76',
};
function fixture() {
  const buffer = new ArrayBuffer(2 * 1024 * 1024);
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
      async serializeRootSignature(flags) {
        events.push({ type: 'serialize', flags });
        return Uint8Array.of(0x44, 0x58, 0x42, 0x43, flags);
      },
      async validateRootSignature(raw) {
        events.push({ type: 'validate', raw: [...raw] });
        return raw[4];
      },
      async createSwapChain(args) {
        events.push({ type: 'swapchain', ...args });
      },
      async destroySwapChain(args) {
        events.push({ type: 'destroySwapChain', ...args });
      },
      async createPipeline(args) {
        events.push({ type: 'pipeline', ...args });
      },
      async destroyPipeline(args) {
        events.push({ type: 'destroyPipeline', ...args });
      },
      async createResource(args) {
        events.push({ type: 'resource', ...args });
      },
      async destroyResource(args) {
        events.push({ type: 'destroyResource', ...args });
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
  const api = async (key, ...args) => d3d12Apis[key](runtime, (i) => args[i]);
  const factoryApi = async (key, ...args) => dxgiApis[key](runtime, (i) => args[i]);
  const create = async (ptr, slot, args, iidName) => {
    const out = alloc();
    const response = await call(ptr, slot, ...args, guid(IID[iidName]), out);
    assert.equal(response.result, 0);
    return runtime.read32(out);
  };
  return { runtime, events, freed, alloc, guid, call, api, factoryApi, create };
}

test('native PE32 D3D12 triangle sequence records, executes, presents, and signals a 64-bit fence', async () => {
  const f = fixture(),
    { runtime: r, events, freed, alloc, call, create, guid } = f;
  const out = alloc();
  assert.equal(
    (await f.factoryApi('dxgi.dll!CreateDXGIFactory1', guid(IID.factory), out)).result,
    0,
  );
  const factory = r.read32(out);
  assert.equal(
    (await f.api('d3d12.dll!D3D12CreateDevice', 0, 0xb000, guid(IID.device), out)).result,
    0,
  );
  const dev = r.read32(out);
  const queueDesc = alloc(16);
  const queue = await create(dev, 8, [queueDesc], 'queue');
  const swapDesc = alloc(60);
  r.write32(swapDesc, 640);
  r.write32(swapDesc + 4, 480);
  r.write32(swapDesc + 16, 28);
  r.write32(swapDesc + 28, 1);
  r.write32(swapDesc + 36, 0x20);
  r.write32(swapDesc + 40, 2);
  r.write32(swapDesc + 44, 0x20000);
  r.write32(swapDesc + 48, 1);
  r.write32(swapDesc + 52, 4);
  const swapOut = alloc();
  assert.equal((await call(factory, 10, queue, swapDesc, swapOut)).result, 0);
  const swap = r.read32(swapOut);
  const swapchain3 = guid('94d99bdb-f1f8-4ab0-b236-7da0170edab1');
  const swapchain3Out = alloc();
  assert.equal((await call(swap, 0, swapchain3, swapchain3Out)).result, 0);
  assert.equal(r.read32(swapchain3Out), swap);
  assert.equal((await call(swap, 36)).result, 0);
  await call(swap, 2); // Release the QueryInterface reference.
  const heapDesc = alloc(16);
  r.write32(heapDesc, 2);
  r.write32(heapDesc + 4, 2);
  const heap = await create(dev, 14, [heapDesc], 'heap');
  const handleOut = alloc();
  assert.equal((await call(heap, 9, handleOut)).argc, 2);
  const handle = r.read32(handleOut);
  assert.equal((await call(dev, 15, 2)).result, 4);
  const buffers = [];
  for (let i = 0; i < 2; i++) {
    const p = await create(swap, 9, [i], 'resource');
    buffers.push(p);
    assert.equal((await call(dev, 20, p, 0, handle + i * 4)).argc, 4);
  }
  const allocator = await create(dev, 9, [0], 'allocator');
  const list = await create(dev, 12, [0, 0, allocator, 0], 'list');
  for (const [slot, method] of [
    [13, 'DrawIndexedInstanced'],
    [43, 'IASetIndexBuffer'],
    [44, 'IASetVertexBuffers'],
    [46, 'OMSetRenderTargets'],
    [47, 'ClearDepthStencilView'],
    [48, 'ClearRenderTargetView'],
  ]) {
    const thunk = r.thunks.get(r.read32(r.read32(list) + slot * 4));
    assert.equal(thunk.name, `ID3D12GraphicsCommandList.${method}`);
  }
  assert.equal((await call(list, 9)).result, 0);
  await assert.rejects(call(list, 21, 1, alloc(24)), /command list is closed/);
  const aliasOut = alloc();
  const baseCommandList = guid('7116d91c-e7e4-47ce-b8c6-ec8168f437e5');
  assert.equal((await call(list, 0, baseCommandList, aliasOut)).result, 0);
  assert.equal(r.read32(aliasOut), list);
  await call(list, 2);
  const rootDesc = alloc(20);
  r.write32(rootDesc + 16, 1);
  assert.equal(
    (await f.api('d3d12.dll!D3D12SerializeRootSignature', rootDesc, 1, out, 0)).result,
    0,
  );
  const blob = r.read32(out),
    blobPtr = (await call(blob, 3)).result,
    blobSize = (await call(blob, 4)).result;
  assert.deepEqual([...r.data.subarray(blobPtr, blobPtr + blobSize)], [0x44, 0x58, 0x42, 0x43, 1]);
  const root = await create(dev, 16, [0, blobPtr, blobSize], 'root');
  const vs = alloc(8),
    ps = alloc(8);
  r.data.set([1, 2, 3, 4, 5, 6, 7, 8], vs);
  r.data.set([9, 10, 11, 12, 13, 14, 15, 16], ps);
  const psoDesc = alloc(572);
  r.write32(psoDesc, root);
  r.write32(psoDesc + 4, vs);
  r.write32(psoDesc + 8, 8);
  r.write32(psoDesc + 12, ps);
  r.write32(psoDesc + 16, 8);
  r.write32(psoDesc + 392, 0xffffffff);
  r.write32(psoDesc + 396, 3);
  r.write32(psoDesc + 400, 1);
  r.write32(psoDesc + 420, 1);
  r.write32(psoDesc + 504, 3);
  r.write32(psoDesc + 508, 1);
  r.write32(psoDesc + 512, 28);
  r.write32(psoDesc + 548, 1);
  r.data[psoDesc + 108] = 15;
  const pipeline = await create(dev, 10, [psoDesc], 'pipeline');
  r.data.fill(0, vs, vs + 8);
  r.data.fill(0, ps, ps + 8);
  assert.deepEqual([...events.find((e) => e.type === 'pipeline').vertex], [1, 2, 3, 4, 5, 6, 7, 8]);
  const fence = await create(dev, 36, [0, 0, 0], 'fence');
  const heapProps = alloc(20);
  r.write32(heapProps, 2);
  r.write32(heapProps + 12, 1);
  r.write32(heapProps + 16, 1);
  const bufferDesc = alloc(56);
  r.write32(bufferDesc, 1);
  r.write32(bufferDesc + 16, 32 * 3);
  r.write32(bufferDesc + 24, 1);
  r.view.setUint16(bufferDesc + 28, 1, true);
  r.view.setUint16(bufferDesc + 30, 1, true);
  r.write32(bufferDesc + 36, 1);
  r.write32(bufferDesc + 44, 1);
  const upload = await create(dev, 27, [heapProps, 0, bufferDesc, 0xac3, 0], 'resource');
  const mappedOut = alloc();
  assert.equal((await call(upload, 8, 0, 0, mappedOut)).result, 0);
  const mapped = r.read32(mappedOut);
  for (let i = 0; i < 24; i++) r.view.setFloat32(mapped + i * 4, i / 24, true);
  await call(upload, 9, 0, 0);
  const gpu = await call(upload, 11);
  assert.equal(gpu.result, mapped);
  assert.equal(gpu.resultHigh, 0);

  const depthProps = alloc(20);
  r.write32(depthProps, 1);
  r.write32(depthProps + 12, 1);
  r.write32(depthProps + 16, 1);
  const depthDesc = alloc(56);
  r.write32(depthDesc, 3);
  r.write32(depthDesc + 16, 640);
  r.write32(depthDesc + 24, 480);
  r.view.setUint16(depthDesc + 28, 1, true);
  r.view.setUint16(depthDesc + 30, 1, true);
  r.write32(depthDesc + 32, 55);
  r.write32(depthDesc + 36, 1);
  r.write32(depthDesc + 48, 2);
  const clearValue = alloc(20);
  r.write32(clearValue, 55);
  r.view.setFloat32(clearValue + 4, 1, true);
  const depthResource = await create(
    dev,
    27,
    [depthProps, 0, depthDesc, 0x10, clearValue],
    'resource',
  );
  const dsvHeapDesc = alloc(16);
  r.write32(dsvHeapDesc, 3);
  r.write32(dsvHeapDesc + 4, 1);
  const dsvHeap = await create(dev, 14, [dsvHeapDesc], 'heap');
  const dsvOut = alloc();
  await call(dsvHeap, 9, dsvOut);
  const dsv = r.read32(dsvOut);
  const dsvDescOut = alloc(16);
  assert.equal((await call(dsvHeap, 8, dsvDescOut)).result, dsvDescOut);
  assert.equal(r.read32(dsvDescOut), 3);
  await call(dev, 21, depthResource, 0, dsv);

  const position = alloc(9),
    colour = alloc(6);
  r.data.set(new TextEncoder().encode('POSITION\0'), position);
  r.data.set(new TextEncoder().encode('COLOR\0'), colour);
  const elements = alloc(56);
  r.write32(elements, position);
  r.write32(elements + 8, 2);
  r.write32(elements + 28, colour);
  r.write32(elements + 36, 2);
  r.write32(elements + 44, 16);
  const depthPsoDesc = alloc(572);
  r.data.set(r.data.subarray(psoDesc, psoDesc + 572), depthPsoDesc);
  r.write32(depthPsoDesc + 440, 1);
  r.write32(depthPsoDesc + 444, 1);
  r.write32(depthPsoDesc + 448, 4);
  r.write32(depthPsoDesc + 492, elements);
  r.write32(depthPsoDesc + 496, 2);
  r.write32(depthPsoDesc + 544, 55);
  const depthPipeline = await create(dev, 10, [depthPsoDesc], 'pipeline');
  const depthPipelineEvent = events.filter((event) => event.type === 'pipeline').at(-1);
  assert.deepEqual(depthPipelineEvent.inputLayout, [
    { shaderLocation: 0, offset: 0, format: 'float32x4' },
    { shaderLocation: 1, offset: 16, format: 'float32x4' },
  ]);
  assert.equal(depthPipelineEvent.vertexStride, 32);
  assert.deepEqual(depthPipelineEvent.depth, {
    format: 'depth16unorm',
    writeEnabled: true,
    compare: 'less-equal',
  });
  const barrier = alloc(24),
    target = alloc(),
    color = alloc(16),
    vp = alloc(24),
    rect = alloc(16),
    lists = alloc();
  r.write32(barrier + 12, 0xffffffff);
  r.write32(target, handle);
  [0.055, 0.095, 0.19, 1].forEach((v, i) => r.view.setFloat32(color + i * 4, v, true));
  [48, 50, 360, 300, 0, 1].forEach((v, i) => r.view.setFloat32(vp + i * 4, v, true));
  [0, 0, 640, 480].forEach((v, i) => r.write32(rect + i * 4, v));
  for (let frame = 0; frame < 2; frame++) {
    assert.equal((await call(swap, 36)).result, frame);
    assert.equal((await call(allocator, 8)).result, 0);
    assert.equal((await call(list, 10, allocator, pipeline)).result, 0);
    r.write32(barrier + 8, buffers[frame]);
    r.write32(barrier + 16, 0);
    r.write32(barrier + 20, 4);
    await call(list, 26, 1, barrier);
    r.write32(target, handle + frame * 4);
    await call(list, 46, 1, target, 0, 0);
    await call(list, 48, handle + frame * 4, color, 0, 0);
    await call(list, 21, 1, vp);
    await call(list, 22, 1, rect);
    await call(list, 30, root);
    await call(list, 20, 4);
    await call(list, 12, 3, 1, 0, 0);
    r.write32(barrier + 16, 4);
    r.write32(barrier + 20, 0);
    await call(list, 26, 1, barrier);
    assert.equal((await call(list, 9)).result, 0);
    r.write32(lists, list);
    await call(queue, 10, 1, lists);
    assert.equal((await call(swap, 8, 0, 0)).result, 0);
    assert.equal((await call(swap, 36)).result, (frame + 1) % 2);
    assert.equal((await call(queue, 14, fence, frame + 1, 0)).result, 0);
    const completed = await call(fence, 8);
    assert.equal(completed.result, frame + 1);
    assert.equal(completed.resultHigh, 0);
  }
  assert.equal((await call(queue, 14, fence, 0x12345678, 1)).result, 0);
  const completed64 = await call(fence, 8);
  assert.equal(completed64.result, 0x12345678);
  assert.equal(completed64.resultHigh, 1);
  assert.deepEqual(
    events.filter((e) => e.type === 'present').map((e) => e.index),
    [0, 1],
  );
  const executes = events.filter((e) => e.type === 'execute');
  assert.equal(executes.length, 2);
  assert.deepEqual(
    executes[0].commands.map((c) => c.type),
    ['clear', 'draw'],
  );
  assert.equal(executes[0].commands[0].target, buffers[0]);
  assert.equal(executes[0].commands[1].pipeline, pipeline);
  assert.deepEqual(executes[0].commands[1].viewport, {
    x: 48,
    y: 50,
    width: 360,
    height: 300,
    minDepth: 0,
    maxDepth: 1,
  });
  // Record a depth-tested colored draw and verify the immutable upload snapshot.
  await call(allocator, 8);
  await call(list, 10, allocator, depthPipeline);
  r.write32(barrier + 8, buffers[0]);
  r.write32(barrier + 16, 0);
  r.write32(barrier + 20, 4);
  await call(list, 26, 1, barrier);
  r.write32(target, handle);
  const dsvPointer = alloc();
  r.write32(dsvPointer, dsv);
  await call(list, 46, 1, target, 0, dsvPointer);
  await call(list, 47, dsv, 1, 0x3f800000, 0, 0, 0);
  const vertexView = alloc(16);
  r.write32(vertexView, mapped);
  r.write32(vertexView + 8, 96);
  r.write32(vertexView + 12, 32);
  await call(list, 44, 0, 1, vertexView);
  await call(list, 21, 1, vp);
  await call(list, 22, 1, rect);
  await call(list, 30, root);
  await call(list, 20, 4);
  await call(list, 12, 3, 1, 0, 0);
  // Upload writes after recording remain visible until ExecuteCommandLists.
  r.data[mapped + 7] = 0x77;
  r.write32(barrier + 16, 4);
  r.write32(barrier + 20, 0);
  await call(list, 26, 1, barrier);
  await call(list, 9);
  await call(queue, 10, 1, lists);
  // The submitted backend command owns a snapshot and no longer aliases guest memory.
  r.data[mapped + 7] = 0;
  const depthExecute = events.filter((event) => event.type === 'execute').at(-1);
  assert.deepEqual(
    depthExecute.commands.map((command) => command.type),
    ['clear-depth', 'draw'],
  );
  assert.equal(depthExecute.commands[1].vertices.length, 96);
  assert.equal(depthExecute.commands[1].vertices[7], 0x77);
  assert.equal(depthExecute.commands[1].vertexStride, 32);
  assert.equal(depthExecute.commands[1].depthTarget, depthResource);
  // Index values are read at execution time, including a signed base vertex
  // and a nonzero first index. Bad values must fail before committing barriers.
  const indexUpload = await create(dev, 27, [heapProps, 0, bufferDesc, 0xac3, 0], 'resource');
  await call(indexUpload, 8, 0, 0, mappedOut);
  const indexData = r.read32(mappedOut),
    indexView = alloc(16);
  r.write32(indexView, indexData);
  r.write32(indexView + 8, 8);
  r.write32(indexView + 12, 57); // DXGI_FORMAT_R16_UINT
  await call(allocator, 8);
  await call(list, 10, allocator, depthPipeline);
  r.write32(barrier + 16, 0);
  r.write32(barrier + 20, 4);
  await call(list, 26, 1, barrier);
  await call(list, 46, 1, target, 0, dsvPointer);
  await call(list, 44, 0, 1, vertexView);
  await call(list, 21, 1, vp);
  await call(list, 22, 1, rect);
  await call(list, 30, root);
  await call(list, 20, 4);
  await call(list, 43, indexView);
  await call(list, 43, 0); // A null view unbinds the index buffer.
  await assert.rejects(call(list, 13, 3, 1, 1, -1, 0), /bound index buffer/);
  r.write32(indexView + 12, 28);
  await assert.rejects(call(list, 43, indexView), /index buffer view/);
  r.write32(indexView + 12, 57);
  await call(list, 43, indexView);
  await assert.rejects(call(list, 13, 4, 1, 1, -1, 0), /bound index buffer/);
  assert.equal((await call(list, 13, 3, 1, 1, -1, 0)).argc, 6);
  r.write32(barrier + 16, 4);
  r.write32(barrier + 20, 0);
  await call(list, 26, 1, barrier);
  await call(list, 9);
  [99, 4, 1, 2].forEach((v, i) => r.view.setUint16(indexData + i * 2, v, true));
  const executeCount = events.filter((event) => event.type === 'execute').length;
  await assert.rejects(call(queue, 10, 1, lists), /index references a vertex outside/);
  assert.equal(events.filter((event) => event.type === 'execute').length, executeCount);
  assert.equal(r.comObjects.objects.get(buffers[0]).state.state, 0);
  r.view.setUint16(indexData + 2, 3, true);
  await call(queue, 10, 1, lists);
  const indexedDraw = events.filter((event) => event.type === 'execute').at(-1).commands[0];
  assert.equal(indexedDraw.baseVertex, -1);
  assert.equal(indexedDraw.firstIndex, 1);
  assert.equal(indexedDraw.indexCount, 3);
  assert.equal(indexedDraw.indexFormat, 'uint16');
  assert.deepEqual([...indexedDraw.indices], [99, 0, 3, 0, 1, 0, 2, 0]);
  r.data.fill(0, indexData, indexData + 8);
  assert.equal(indexedDraw.indices[2], 3, 'Submitted index bytes do not alias guest storage');
  await call(indexUpload, 2);
  await assert.rejects(call(queue, 10, 1, lists), /Invalid or released ID3D12Resource/);
  assert.ok(freed.includes(indexData));
  // A rejected submission must not commit the transition to RENDER_TARGET.
  await call(allocator, 8);
  await call(list, 10, allocator, pipeline);
  r.write32(barrier + 8, buffers[0]);
  r.write32(barrier + 16, 0);
  r.write32(barrier + 20, 4);
  await call(list, 26, 1, barrier);
  await call(list, 9);
  const execute = r.graphics12.execute;
  r.graphics12.execute = async () => {
    throw Error('GPU submission failed');
  };
  await assert.rejects(call(queue, 10, 1, lists), /GPU submission failed/);
  assert.equal(r.comObjects.objects.get(buffers[0]).state.state, 0);
  r.graphics12.execute = execute;
  await call(queue, 10, 1, lists);
  assert.equal(r.comObjects.objects.get(buffers[0]).state.state, 4);
  await assert.rejects(call(swap, 8, 0, 0), /requires PRESENT resource state/);
  await call(allocator, 8);
  await call(list, 10, allocator, pipeline);
  r.write32(barrier + 16, 4);
  r.write32(barrier + 20, 0);
  await call(list, 26, 1, barrier);
  await call(list, 9);
  await call(queue, 10, 1, lists);
  assert.equal((await call(swap, 8, 0, 0)).result, 0);
  for (const ptr of [
    fence,
    depthPipeline,
    pipeline,
    root,
    blob,
    list,
    allocator,
    upload,
    depthResource,
    ...buffers,
    heap,
    dsvHeap,
    swap,
    queue,
    dev,
    factory,
  ])
    await call(ptr, 2);
  assert.equal(events.filter((e) => e.type === 'destroySwapChain').length, 1);
  assert.equal(events.filter((e) => e.type === 'destroyPipeline').length, 2);
  assert.equal(events.filter((e) => e.type === 'destroyResource').length, 1);
  for (const owned of [mapped, handle, dsv, blobPtr]) assert.ok(freed.includes(owned));
  for (const persistent of [blob, position, clearValue, rootDesc])
    assert.ok(!freed.includes(persistent));
});

test('unsupported calls and released COM pointers stay explicit', async () => {
  const f = fixture(),
    { runtime: r, call, alloc, guid } = f;
  const out = alloc();
  assert.equal(
    (await f.api('d3d12.dll!D3D12CreateDevice', 1, 0xb000, guid(IID.device), out)).result,
    0x80070057,
  );
  await f.api('d3d12.dll!D3D12CreateDevice', 0, 0xb000, guid(IID.device), out);
  const dev = r.read32(out);
  const queueDesc = alloc(16);
  r.write32(queueDesc + 4, 1);
  assert.equal((await call(dev, 8, queueDesc, guid(IID.queue), out)).result, 0x80070057);
  r.write32(queueDesc + 4, 0);
  r.write32(queueDesc + 8, 1);
  assert.equal((await call(dev, 8, queueDesc, guid(IID.queue), out)).result, 0x80070057);
  await assert.rejects(call(dev, 28, 0), /Unsupported COM method ID3D12Device.CreateHeap/);
  const heapDesc = alloc(16);
  r.write32(heapDesc, 2);
  r.write32(heapDesc + 4, 17);
  assert.equal((await call(dev, 14, heapDesc, guid(IID.heap), out)).result, 0x80070057);
  r.write32(heapDesc + 4, 2);
  const heap = await f.create(dev, 14, [heapDesc], 'heap');
  const result = alloc();
  await call(heap, 9, result);
  await assert.rejects(
    call(dev, 20, 1234, 0, r.read32(result)),
    /Invalid or released ID3D12Resource/,
  );
  assert.equal((await call(heap, 2)).result, 0);
  await assert.rejects(call(heap, 9, result), /Released COM object/);
});

test('payload allocations roll back when COM object creation fails', async () => {
  const f = fixture(),
    { runtime: r, freed, alloc, guid, call } = f;
  const out = alloc();
  await f.api('d3d12.dll!D3D12CreateDevice', 0, 0xb000, guid(IID.device), out);
  const dev = r.read32(out);
  for (let key = 1; r.comObjects.objects.size < 64; key++)
    if (!r.comObjects.objects.has(key)) r.comObjects.objects.set(key, {});

  const heapDesc = alloc(16);
  r.write32(heapDesc, 2);
  r.write32(heapDesc + 4, 2);
  await assert.rejects(call(dev, 14, heapDesc, guid(IID.heap), out), /COM object limit/);
  assert.equal(freed.length, 1); // Descriptor backing allocation.

  const heapProps = alloc(20);
  r.write32(heapProps, 2);
  r.write32(heapProps + 12, 1);
  r.write32(heapProps + 16, 1);
  const bufferDesc = alloc(56);
  r.write32(bufferDesc, 1);
  r.write32(bufferDesc + 16, 256);
  r.write32(bufferDesc + 24, 1);
  r.view.setUint16(bufferDesc + 28, 1, true);
  r.view.setUint16(bufferDesc + 30, 1, true);
  r.write32(bufferDesc + 36, 1);
  r.write32(bufferDesc + 44, 1);
  await assert.rejects(
    call(dev, 27, heapProps, 0, bufferDesc, 0xac3, 0, guid(IID.resource), out),
    /COM object limit/,
  );
  assert.equal(freed.length, 2); // Upload storage allocation.

  const rootDesc = alloc(20);
  r.write32(rootDesc + 16, 1);
  await assert.rejects(
    f.api('d3d12.dll!D3D12SerializeRootSignature', rootDesc, 1, out, 0),
    /COM object limit/,
  );
  assert.equal(freed.length, 3); // Serialized blob payload.
  assert.ok(!freed.includes(heapDesc));
  assert.ok(!freed.includes(bufferDesc));
  assert.ok(!freed.includes(rootDesc));
});
