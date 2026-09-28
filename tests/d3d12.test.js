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
  query: '0d9658ae-ed45-469e-a61d-970ec583cab4',
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
  assert.deepEqual(
    depthPipelineEvent.inputLayout.map(({ shaderLocation, offset, format }) => ({
      shaderLocation,
      offset,
      format,
    })),
    [
      { shaderLocation: 0, offset: 0, format: 'float32x4' },
      { shaderLocation: 1, offset: 16, format: 'float32x4' },
    ],
  );
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
  // Saturate the live-object budget without creating real COM interfaces.
  r.comObjects.liveObjects = 4096;

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

test('CopyBufferRegion performs the canonical upload-to-default-heap copy with state tracking', async () => {
  const f = fixture(),
    { runtime: r, events, alloc, call, create, api } = f;
  const out = alloc();
  await api('d3d12.dll!D3D12CreateDevice', 0, 0xb000, f.guid(IID.device), out);
  const dev = r.read32(out);
  const queueDesc = alloc(16);
  const queue = await create(dev, 8, [queueDesc], 'queue');
  const allocator = await create(dev, 9, [0], 'allocator');
  const list = await create(dev, 12, [0, 0, allocator, 0], 'list');

  const makeBuffer = async (heapType, size, state) => {
    const props = alloc(20);
    r.write32(props, heapType);
    r.write32(props + 12, 1);
    r.write32(props + 16, 1);
    const desc = alloc(56);
    r.write32(desc, 1);
    r.write32(desc + 16, size);
    r.write32(desc + 24, 1);
    r.view.setUint16(desc + 28, 1, true);
    r.view.setUint16(desc + 30, 1, true);
    r.write32(desc + 36, 1);
    r.write32(desc + 44, 1);
    return create(dev, 27, [props, 0, desc, state, 0], 'resource');
  };

  const upload = await makeBuffer(2, 16, 0xac3);
  const target = await makeBuffer(1, 16, 0);
  const uploadStorage = (await call(upload, 11)).result;
  const targetStorage = (await call(target, 11)).result;

  const mappedOut = alloc();
  assert.equal((await call(upload, 8, 0, 0, mappedOut)).result, 0);
  const mapped = r.read32(mappedOut);
  for (let i = 0; i < 16; i++) r.data[mapped + i] = 0x40 + i;
  await call(upload, 9, 0, 0);

  // Barrier the default-heap buffer into COPY_DEST, copy, then into INDEX_BUFFER.
  const barrier = alloc(24);
  r.write32(barrier + 12, 0xffffffff);
  r.write32(barrier + 8, target);
  r.write32(barrier + 16, 0);
  r.write32(barrier + 20, 0x400);
  await call(list, 26, 1, barrier);
  await call(list, 15, target, 0, 0, upload, 0, 0, 16, 0);
  r.write32(barrier + 16, 0x400);
  r.write32(barrier + 20, 0x2);
  await call(list, 26, 1, barrier);
  await call(list, 9);

  const listPtr = alloc();
  r.write32(listPtr, list);
  await call(queue, 10, 1, listPtr);

  assert.deepEqual(
    [...r.data.subarray(targetStorage, targetStorage + 16)],
    Array.from({ length: 16 }, (_, i) => 0x40 + i),
    'the copy landed in the default-heap buffer storage',
  );
  assert.notEqual(targetStorage, uploadStorage);
  assert.equal(events.filter((e) => e.type === 'execute').length, 1);

  // A copy that exceeds either resource must fail before mutating storage.
  await call(allocator, 8);
  await call(list, 10, allocator, 0);
  await assert.rejects(
    call(list, 15, target, 8, 0, upload, 0, 0, 16, 0),
    /exceeds a resource/,
  );
  await call(list, 2);
  await call(target, 2);
  await call(upload, 2);
  await call(allocator, 2);
  await call(queue, 2);
  await call(dev, 2);
});

test('GetDesc, ClearState and the annotation no-ops round-trip without trapping', async () => {
  const f = fixture(),
    { runtime: r, alloc, call, create, api } = f;
  const out = alloc();
  await api('d3d12.dll!D3D12CreateDevice', 0, 0xb000, f.guid(IID.device), out);
  const dev = r.read32(out);
  const allocator = await create(dev, 9, [0], 'allocator');
  const list = await create(dev, 12, [0, 0, allocator, 0], 'list');
  assert.equal((await call(list, 8)).result, 0, 'GetType reports DIRECT');

  const props = alloc(20);
  r.write32(props, 2);
  r.write32(props + 12, 1);
  r.write32(props + 16, 1);
  const desc = alloc(56);
  r.write32(desc, 1);
  r.write32(desc + 16, 256);
  r.write32(desc + 24, 1);
  r.view.setUint16(desc + 28, 1, true);
  r.view.setUint16(desc + 30, 1, true);
  r.write32(desc + 36, 1);
  r.write32(desc + 44, 1);
  const buffer = await create(dev, 27, [props, 0, desc, 0xac3, 0], 'resource');

  const descOut = alloc();
  r.data.fill(0xcc, descOut, descOut + 56);
  await call(buffer, 10, descOut);
  assert.equal(r.read32(descOut), 1, 'buffer dimension');
  assert.equal(r.read32(descOut + 16), 256, 'buffer byte width');
  assert.equal(r.read32(descOut + 44), 1, 'row-major layout');
  assert.ok(
    r.data.subarray(descOut + 48, descOut + 56).every((b) => b === 0),
    'buffer tail stays zeroed',
  );

  // Metadata no-ops, PIX markers, disabled predication and pair setters.
  const name = alloc(8);
  r.data.set([0x78, 0, 0x79, 0, 0, 0, 0, 0], name);
  assert.equal((await call(buffer, 6, name)).result, 0, 'SetName');
  assert.equal((await call(buffer, 4, alloc(16), 0, 0, name)).result, 0, 'SetPrivateData');
  assert.equal((await call(buffer, 5, alloc(16), 0)).result, 0, 'SetPrivateDataInterface');
  const sizeOut = alloc();
  assert.equal(
    (await call(buffer, 3, alloc(16), 0, sizeOut, 0)).result,
    0x887a0002,
    'GetPrivateData reports not-found',
  );
  assert.equal((await call(list, 57, name, 8)).result, undefined, 'BeginEvent');
  assert.equal((await call(list, 58)).result, undefined, 'EndEvent');
  assert.equal((await call(list, 56, 0, 0)).result, undefined, 'SetMarker');
  assert.equal((await call(list, 55, 0, 0, 0)).result, undefined, 'disabled predication');
  await assert.rejects(call(list, 55, buffer, 0, 0), /predication/);
  const blend = alloc(16);
  for (let i = 0; i < 4; i++) r.view.setFloat32(blend + i * 4, 0.5, true);
  assert.equal((await call(list, 23, blend)).result, undefined, 'OMSetBlendFactor');
  assert.equal((await call(list, 24, 3)).result, undefined, 'OMSetStencilRef');
  assert.equal((await call(list, 45, 0, 0, 0)).result, undefined, 'empty SOSetTargets');
  await assert.rejects(call(list, 45, 1, 0, 0), /stream output/);
  await call(list, 26, 0, 0).catch(() => {});
  assert.equal((await call(list, 11)).result, undefined, 'ClearState');
  await call(list, 2);
  await call(allocator, 2);
  await call(buffer, 2);
  await call(dev, 2);
});

test('device-child GetDevice, GetDeviceRemovedReason and GetAdapterLuid answer without trapping', async () => {
  const f = fixture(),
    { runtime: r, alloc, call, create, api, guid } = f;
  const out = alloc();
  await api('d3d12.dll!D3D12CreateDevice', 0, 0xb000, guid(IID.device), out);
  const dev = r.read32(out);
  const allocator = await create(dev, 9, [0], 'allocator');
  const list = await create(dev, 12, [0, 0, allocator, 0], 'list');

  const props = alloc(20);
  r.write32(props, 2);
  r.write32(props + 12, 1);
  r.write32(props + 16, 1);
  const desc = alloc(56);
  r.write32(desc, 1);
  r.write32(desc + 16, 64);
  r.write32(desc + 24, 1);
  r.view.setUint16(desc + 28, 1, true);
  r.view.setUint16(desc + 30, 1, true);
  r.write32(desc + 36, 1);
  r.write32(desc + 44, 1);
  const buffer = await create(dev, 27, [props, 0, desc, 0xac3, 0], 'resource');

  const deviceOut = alloc();
  r.data.fill(0xcc, deviceOut, deviceOut + 4);
  assert.equal((await call(list, 7, guid(IID.device), deviceOut)).result, 0);
  assert.equal(r.read32(deviceOut), dev, 'list GetDevice returns the device');
  deviceOut && r.write32(deviceOut, 0xcccccccc);
  assert.equal((await call(buffer, 7, guid(IID.device), deviceOut)).result, 0);
  assert.equal(r.read32(deviceOut), dev, 'resource GetDevice returns the device');
  // A refused interface clears the output to NULL and reports E_NOINTERFACE,
  // matching the Direct3D contract for a failed interface query.
  r.write32(deviceOut, 0x11223344);
  assert.equal((await call(list, 7, guid(IID.resource), deviceOut)).result, 0x80004002);
  assert.equal(r.read32(deviceOut), 0);
  // A NULL output is a documented probe that must not create a reference.
  const refsBefore = r.comObjects.objects.get(dev).refs;
  assert.equal((await call(list, 7, guid(IID.device), 0)).result, 0);
  assert.equal(r.comObjects.objects.get(dev).refs, refsBefore);

  assert.equal((await call(dev, 37)).result, 0, 'no device removal is simulated');
  const luid = alloc();
  r.data.fill(0xcc, luid, luid + 8);
  assert.equal((await call(dev, 43, luid)).result, undefined);
  assert.notEqual(r.read32(luid), 0xcccccccc, 'GetAdapterLuid writes a LUID');

  await call(list, 2);
  await call(allocator, 2);
  await call(buffer, 2);
  await call(dev, 2);
});

test('DrawInstanced accepts bounded instance counts and first-instance offsets', async () => {
  const f = fixture(),
    { runtime: r, alloc, call, create, api, guid } = f;
  const out = alloc();
  await api('d3d12.dll!D3D12CreateDevice', 0, 0xb000, guid(IID.device), out);
  const dev = r.read32(out);
  const allocator = await create(dev, 9, [0], 'allocator');
  const list = await create(dev, 12, [0, 0, allocator, 0], 'list');

  // A minimal recorded state: no vertex input, a bound root and target, and a
  // valid viewport/scissor. Recording alone proves the frontend gate.
  const root = { pointer: 0x1111 };
  const target = { pointer: 0x2222 };
  Object.assign(r.comObjects.objects.get(list).state, {
    pipeline: { state: { root, inputLayout: [], depth: null, vertexStride: 0 } },
    root,
    target,
    viewport: { x: 0, y: 0, width: 640, height: 480, minDepth: 0, maxDepth: 1 },
    scissor: { left: 0, top: 0, right: 640, bottom: 480 },
    topology: 4,
    vertexBuffer: null,
    indexBuffer: null,
    commands: [],
  });

  const commands = () => r.comObjects.objects.get(list).state.commands;

  await call(list, 12, 3, 4, 0, 0);
  assert.equal(commands().length, 1);
  assert.deepEqual(
    { vertexCount: commands()[0].vertexCount, instanceCount: commands()[0].instanceCount, firstInstance: commands()[0].firstInstance },
    { vertexCount: 3, instanceCount: 4, firstInstance: 0 },
    'instanceCount and firstInstance are recorded',
  );

  await call(list, 12, 3, 2, 0, 5);
  assert.equal(commands()[1].instanceCount, 2);
  assert.equal(commands()[1].firstInstance, 5, 'first-instance offset is preserved');

  // Zero and out-of-range instance counts are rejected before anything records.
  const recorded = commands().length;
  await assert.rejects(call(list, 12, 3, 0, 0, 0), /DrawInstanced state/);
  await assert.rejects(call(list, 12, 3, 1025, 0, 0), /DrawInstanced state/);
  assert.equal(commands().length, recorded, 'rejected draws record nothing');

  await call(list, 2);
  await call(allocator, 2);
  await call(dev, 2);
});

test('CheckFeatureSupport answers the startup capability probes from a fixed profile', async () => {
  const f = fixture(),
    { runtime: r, alloc, call, api, guid } = f;
  const out = alloc();
  await api('d3d12.dll!D3D12CreateDevice', 0, 0xb000, guid(IID.device), out);
  const dev = r.read32(out);

  // D3D12_FEATURE_D3D12_OPTIONS (feature 0) is 15 DWORDs.
  const options = alloc(60);
  assert.equal((await call(dev, 13, 0, options, 60)).result, 0);
  assert.equal(r.read32(options + 16), 1, 'ResourceBindingTier');
  assert.equal(r.read32(options + 36), 32, 'MaxGPUVirtualAddressBitsPerResource');
  assert.equal(r.read32(options + 56), 1, 'ResourceHeapTier');

  // D3D12_FEATURE_ARCHITECTURE (feature 1) only has node 0.
  const arch = alloc(16);
  r.write32(arch, 0);
  assert.equal((await call(dev, 13, 1, arch, 16)).result, 0);
  assert.ok(r.data.subarray(arch, arch + 16).every((b) => b === 0), 'non-UMA non-tiled');
  r.write32(arch, 1);
  assert.equal((await call(dev, 13, 1, arch, 16)).result, 0x80070057, 'only node 0 exists');

  // D3D12_FEATURE_DATA_FEATURE_LEVELS (feature 2) clamps to 11_0.
  const levels = alloc(12);
  const requested = alloc(12);
  r.write32(levels, 3);
  r.write32(levels + 4, requested);
  [0xb100, 0xa100, 0xb000].forEach((v, i) => r.write32(requested + i * 4, v));
  assert.equal((await call(dev, 13, 2, levels, 12)).result, 0);
  assert.equal(r.read32(levels + 8), 0xb000, 'clamps to D3D_FEATURE_LEVEL_11_0');
  r.write32(levels + 4, 0);
  assert.equal((await call(dev, 13, 2, levels, 12)).result, 0x80070057, 'NULL list rejected');

  // SHADER_MODEL, ROOT_SIGNATURE and GPU_VIRTUAL_ADDRESS_SUPPORT.
  const four = alloc(4);
  assert.equal((await call(dev, 13, 7, four, 4)).result, 0);
  assert.equal(r.read32(four), 0x51, 'D3D_SHADER_MODEL_5_1');
  assert.equal((await call(dev, 13, 12, four, 4)).result, 0);
  assert.equal(r.read32(four), 1, 'D3D_ROOT_SIGNATURE_VERSION_1');
  const eight = alloc(8);
  assert.equal((await call(dev, 13, 6, eight, 8)).result, 0);
  assert.deepEqual([r.read32(eight), r.read32(eight + 4)], [32, 32]);

  // Unknown features and undersized buffers fail explicitly.
  assert.equal((await call(dev, 13, 99, four, 4)).result, 0x80070057, 'unknown feature');
  assert.equal((await call(dev, 13, 0, options, 8)).result, 0x80070057, 'short buffer');
  assert.equal((await call(dev, 13, 0, 0, 60)).result, 0x80070057, 'NULL output');

  await call(dev, 2);
});

test('descriptor copies, allocation info, custom heap properties and residency answer real startup calls', async () => {
  const f = fixture(),
    { runtime: r, alloc, call, create, api, guid } = f;
  const out = alloc();
  await api('d3d12.dll!D3D12CreateDevice', 0, 0xb000, guid(IID.device), out);
  const dev = r.read32(out);

  // A 2-slot RTV heap plus an RTV bound to slot 0.
  const heapDesc = alloc(16);
  r.write32(heapDesc, 2);
  r.write32(heapDesc + 4, 2);
  const heap = await create(dev, 14, [heapDesc], 'heap');
  const handleOut = alloc();
  await call(heap, 9, handleOut);
  const handle = r.read32(handleOut);

  const props = alloc(20);
  r.write32(props, 2);
  r.write32(props + 12, 1);
  r.write32(props + 16, 1);
  const desc = alloc(56);
  r.write32(desc, 1);
  r.write32(desc + 16, 128);
  r.write32(desc + 24, 1);
  r.view.setUint16(desc + 28, 1, true);
  r.view.setUint16(desc + 30, 1, true);
  r.write32(desc + 36, 1);
  r.write32(desc + 44, 1);
  const buffer = await create(dev, 27, [props, 0, desc, 0xac3, 0], 'resource');
  await call(dev, 20, buffer, 0, handle);

  const descriptors = r.d3d12State.descriptors;
  assert.equal(descriptors.get(handle).resource, r.comObjects.objects.get(buffer));

  // CopyDescriptorsSimple duplicates slot 0 into slot 1.
  assert.equal((await call(dev, 24, 1, handle + 4, handle, 2)).result, 0);
  assert.equal(descriptors.get(handle + 4).resource, descriptors.get(handle).resource);
  // A mismatched heap type is rejected without mutating anything.
  assert.equal((await call(dev, 24, 1, handle + 4, handle, 3)).result, 0x80070057);

  // CopyDescriptors: two source ranges into two destinations of equal total.
  descriptors.get(handle + 4).resource = null;
  const dstOffsets = alloc(8),
    dstSizes = alloc(8),
    srcOffsets = alloc(8),
    srcSizes = alloc(8);
  r.write32(dstOffsets, handle);
  r.write32(dstSizes, 1);
  r.write32(dstOffsets + 4, handle + 4);
  r.write32(dstSizes + 4, 1);
  r.write32(srcOffsets, handle);
  r.write32(srcSizes, 1);
  r.write32(srcOffsets + 4, handle + 4);
  r.write32(srcSizes + 4, 1);
  assert.equal((await call(dev, 23, 2, dstOffsets, dstSizes, 2, srcOffsets, srcSizes, 2)).result, 0);
  assert.equal(descriptors.get(handle).resource, r.comObjects.objects.get(buffer));
  // Unequal totals are rejected.
  r.write32(srcSizes + 4, 2);
  assert.equal((await call(dev, 23, 2, dstOffsets, dstSizes, 2, srcOffsets, srcSizes, 2)).result, 0x80070057);

  // GetResourceAllocationInfo (hidden struct return) sums buffer sizes.
  const infoDesc = alloc(56);
  r.write32(infoDesc, 1);
  r.write32(infoDesc + 16, 4096);
  const infoOut = alloc(16);
  assert.equal((await call(dev, 25, infoOut, 1, 1, infoDesc)).result, undefined);
  assert.equal(r.read32(infoOut), 4096);
  // GetCustomHeapProperties echoes the heap type with node masks of 1.
  const heapPropsOut = alloc(20);
  assert.equal((await call(dev, 26, heapPropsOut, 1, 1)).result, undefined);
  assert.equal(r.read32(heapPropsOut), 1);
  assert.equal(r.read32(heapPropsOut + 12), 1);
  assert.equal((await call(dev, 26, heapPropsOut, 2, 1)).result, 0x80070057, 'only node 0');

  // MakeResident/Evict validate the object list and succeed.
  const list = alloc(4);
  r.write32(list, buffer);
  assert.equal((await call(dev, 34, 1, list)).result, 0);
  assert.equal((await call(dev, 35, 1, list)).result, 0);
  assert.equal((await call(dev, 34, 0, 0)).result, 0, 'empty list is legal');

  await call(heap, 2);
  await call(buffer, 2);
  await call(dev, 2);
});

test('create CBV/SRV/UAV/sampler descriptors, bind heaps and set stable power', async () => {
  const f = fixture(),
    { runtime: r, alloc, call, create, api, guid } = f;
  const out = alloc();
  await api('d3d12.dll!D3D12CreateDevice', 0, 0xb000, guid(IID.device), out);
  const dev = r.read32(out);

  // One CBV/SRV/UAV heap (type 0, shader-visible) and one SAMPLER heap (type 1).
  const makeHeap = async (type, count) => {
    const desc = alloc(16);
    r.write32(desc, type);
    r.write32(desc + 4, count);
    r.write32(desc + 12, 1); // SHADER_VISIBLE
    const heap = await create(dev, 14, [desc], 'heap');
    const handleOut = alloc();
    await call(heap, 9, handleOut);
    return { heap, base: r.read32(handleOut) };
  };
  const views = await makeHeap(0, 4);
  const samplers = await makeHeap(1, 2);
  assert.equal((await call(dev, 15, 0)).result, 4, 'descriptor increment is 4 bytes');
  assert.equal((await call(dev, 15, 3)).result, 4);

  // An upload buffer sized to hold a 256-byte constant buffer.
  const props = alloc(20);
  r.write32(props, 2);
  r.write32(props + 12, 1);
  r.write32(props + 16, 1);
  const bufferDesc = alloc(56);
  r.write32(bufferDesc, 1);
  r.write32(bufferDesc + 16, 256);
  r.write32(bufferDesc + 24, 1);
  r.view.setUint16(bufferDesc + 28, 1, true);
  r.view.setUint16(bufferDesc + 30, 1, true);
  r.write32(bufferDesc + 36, 1);
  r.write32(bufferDesc + 44, 1);
  const buffer = await create(dev, 27, [props, 0, bufferDesc, 0xac3, 0], 'resource');
  const storage = (await call(buffer, 11)).result;

  const descriptors = r.d3d12State.descriptors;

  // Constant buffer view bound at slot 0.
  const cbv = alloc(16);
  r.write32(cbv, storage);
  r.write32(cbv + 4, 0);
  r.write32(cbv + 8, 256);
  assert.equal((await call(dev, 17, cbv, views.base)).result, 0);
  assert.equal(descriptors.get(views.base).kind, 'cbv');
  assert.equal(descriptors.get(views.base).size, 256);
  // A size that runs past the resource is rejected without mutating the slot.
  r.write32(cbv + 8, 512);
  assert.equal((await call(dev, 17, cbv, views.base + 4)).result, 0x80070057);
  assert.equal(descriptors.get(views.base + 4).kind, undefined);
  // A CBV must target a type-0 heap; a sampler slot is refused.
  assert.equal((await call(dev, 17, cbv, samplers.base)).result, 0x80070057);

  // Shader resource view: buffer SRV with element range and stride.
  const srv = alloc(40);
  r.write32(srv, 0); // Format UNKNOWN for a structured buffer.
  r.write32(srv + 4, 1); // D3D12_SRV_DIMENSION_BUFFER
  r.write32(srv + 8, 0x00016800); // Default 4-component mapping.
  r.write32(srv + 16, 0); // FirstElement
  r.write32(srv + 24, 16); // NumElements
  r.write32(srv + 28, 16); // StructureByteStride
  assert.equal((await call(dev, 18, buffer, srv, views.base + 4)).result, 0);
  assert.equal(descriptors.get(views.base + 4).kind, 'srv');
  assert.equal(descriptors.get(views.base + 4).elementCount, 16);
  r.write32(srv + 24, 1024); // Out-of-range element count.
  assert.equal((await call(dev, 18, buffer, srv, views.base + 8)).result, 0x80070057);

  // Unordered access view with no counter.
  const uav = alloc(40);
  r.write32(uav, 0);
  r.write32(uav + 4, 1); // D3D12_UAV_DIMENSION_BUFFER
  r.write32(uav + 8, 0);
  r.write32(uav + 16, 8);
  r.write32(uav + 20, 16);
  assert.equal((await call(dev, 19, buffer, 0, uav, views.base + 8)).result, 0);
  assert.equal(descriptors.get(views.base + 8).kind, 'uav');

  // Sampler descriptor in the type-1 heap.
  const samplerDesc = alloc(52);
  r.write32(samplerDesc, 1); // Filter MIN_MAG_MIP_POINT
  r.write32(samplerDesc + 24, 4); // ComparisonFunc NEVER (unused)
  r.write32(samplerDesc + 48, 16); // MaxAnisotropy
  assert.equal((await call(dev, 22, samplerDesc, samplers.base)).result, 0);
  assert.equal(descriptors.get(samplers.base).kind, 'sampler');
  // The sampler heap type is enforced.
  assert.equal((await call(dev, 22, samplerDesc, views.base)).result, 0x80070057);

  // SetStablePowerState is accepted.
  assert.equal((await call(dev, 40, 1)).result, 0);

  // Bind both heaps on a command list, then ClearState drops them.
  const allocator = await create(dev, 9, [0], 'allocator');
  const list = await create(dev, 12, [0, 0, allocator, 0], 'list');
  const listState = () => r.comObjects.objects.get(list).state;
  const heapList = alloc(8);
  r.write32(heapList, views.heap);
  r.write32(heapList + 4, samplers.heap);
  assert.equal((await call(list, 28, 2, heapList)).result, undefined);
  assert.equal(listState().descriptorHeaps.length, 2);
  // A single heap of each type is allowed; a duplicate type is not.
  r.write32(heapList, views.heap);
  assert.equal((await call(list, 28, 1, heapList)).result, undefined);
  assert.equal(listState().descriptorHeaps.length, 1);
  assert.equal((await call(list, 11)).result, undefined, 'ClearState');
  assert.equal(listState().descriptorHeaps.length, 0);

  await call(list, 2);
  await call(allocator, 2);
  await call(views.heap, 2);
  await call(samplers.heap, 2);
  await call(buffer, 2);
  await call(dev, 2);
});

test('GetCopyableFootprints lays out buffer and 2D-texture uploads with 256-byte rows', async () => {
  const f = fixture(),
    { runtime: r, alloc, call, api, guid } = f;
  const out = alloc();
  await api('d3d12.dll!D3D12CreateDevice', 0, 0xb000, guid(IID.device), out);
  const dev = r.read32(out);

  // A 100-byte buffer: one row, 256-byte-pitched, 256 total.
  const buffer = alloc(56);
  r.write32(buffer, 1);
  r.write32(buffer + 16, 100);
  r.write32(buffer + 24, 1);
  r.view.setUint16(buffer + 28, 1, true);
  r.view.setUint16(buffer + 30, 1, true);
  r.write32(buffer + 36, 1);
  r.write32(buffer + 44, 1);
  const layout = alloc(32),
    rows = alloc(4),
    rowSize = alloc(8),
    total = alloc(8);
  assert.equal((await call(dev, 38, buffer, 0, 1, 0, 0, layout, rows, rowSize, total)).result, undefined);
  assert.equal(r.read32(layout), 0, 'layout offset honors base offset');
  assert.equal(r.read32(layout + 12), 100, 'layout width');
  assert.equal(r.read32(layout + 16), 1, 'buffer height is 1');
  assert.equal(r.read32(layout + 24), 256, 'row pitch is 256-aligned');
  assert.equal(r.read32(rows), 1);
  assert.equal(r.read32(rowSize), 100, 'row size is the unaligned byte width');
  assert.equal(r.read32(total), 256);

  // A 4x4 RGBA texture (format 28): 16-byte rows, 64 total.
  const texture = alloc(56);
  r.write32(texture, 3);
  r.write32(texture + 16, 4);
  r.write32(texture + 24, 4);
  r.view.setUint16(texture + 28, 1, true);
  r.view.setUint16(texture + 30, 1, true);
  r.write32(texture + 32, 28);
  r.write32(texture + 36, 1);
  assert.equal((await call(dev, 38, texture, 0, 1, 0, 0, layout, rows, rowSize, total)).result, undefined);
  assert.equal(r.read32(layout + 8), 28, 'texture format recorded');
  assert.equal(r.read32(layout + 16), 4, 'texture height');
  assert.equal(r.read32(layout + 24), 256, 'texture row pitch aligned');
  assert.equal(r.read32(rows), 4);
  assert.equal(r.read32(rowSize), 16, 'texture row size 4*4 bytes');
  assert.equal(r.read32(total), 1024);

  // Explicit base offset is folded into the first layout and the total.
  assert.equal((await call(dev, 38, buffer, 0, 1, 0x1000, 0, layout, rows, rowSize, total)).result, undefined);
  assert.equal(r.read32(layout), 0x1000);
  assert.equal(r.read32(total), 0x1100);

  // Unsupported inputs fail explicitly: nonzero first subresource, unknown
  // format, and a count above one for a single-mip texture.
  assert.equal((await call(dev, 38, buffer, 1, 1, 0, 0, 0, 0, 0, 0)).result, 0x80070057);
  r.write32(texture + 32, 9999);
  assert.equal((await call(dev, 38, texture, 0, 1, 0, 0, 0, 0, 0, 0)).result, 0x80070057);
  r.write32(texture + 32, 28);
  assert.equal((await call(dev, 38, texture, 0, 2, 0, 0, 0, 0, 0, 0)).result, 0x80070057);

  await call(dev, 2);
});

test('CheckFeatureSupport reports format, multisample and options admissions', async () => {
  const f = fixture(),
    { runtime: r, alloc, call, api, guid } = f;
  const out = alloc();
  await api('d3d12.dll!D3D12CreateDevice', 0, 0xb000, guid(IID.device), out);
  const dev = r.read32(out);

  // FORMAT_SUPPORT (feature 3): RGBA8 is a sampleable render target; D16 is a
  // depth format; R32G32B32_FLOAT is a vertex format; unknown formats are 0.
  const formatSupport = alloc(12);
  r.write32(formatSupport, 28);
  assert.equal((await call(dev, 13, 3, formatSupport, 12)).result, 0);
  const rgba = r.read32(formatSupport + 4);
  assert.ok(rgba & 0x4000, 'R8G8B8A8_UNORM is a render target');
  assert.ok(rgba & 0x200, 'R8G8B8A8_UNORM is sampleable');
  r.write32(formatSupport, 55);
  assert.equal((await call(dev, 13, 3, formatSupport, 12)).result, 0);
  assert.ok(r.read32(formatSupport + 4) & 0x10000, 'D16_UNORM is a depth format');
  r.write32(formatSupport, 6);
  assert.equal((await call(dev, 13, 3, formatSupport, 12)).result, 0);
  assert.ok(r.read32(formatSupport + 4) & 0x2, 'R32G32B32_FLOAT is a vertex format');
  r.write32(formatSupport, 0);
  assert.equal((await call(dev, 13, 3, formatSupport, 12)).result, 0);
  assert.equal(r.read32(formatSupport + 4), 0, 'unknown format reports no support');
  assert.equal((await call(dev, 13, 3, formatSupport, 8)).result, 0x80070057, 'short buffer');

  // MULTISAMPLE_QUALITY_LEVELS (feature 4): only 1x reports a level.
  const msaa = alloc(16);
  r.write32(msaa, 28);
  r.write32(msaa + 4, 1);
  assert.equal((await call(dev, 13, 4, msaa, 16)).result, 0);
  assert.equal(r.read32(msaa + 12), 1, '1x has one quality level');
  r.write32(msaa + 4, 4);
  assert.equal((await call(dev, 13, 4, msaa, 16)).result, 0);
  assert.equal(r.read32(msaa + 12), 0, '4x has no quality level');

  // OPTIONS1 (feature 8) advertises no wave ops; SHADER_CACHE (19) and
  // EXISTING_HEAPS (22) are explicitly zeroed.
  const options1 = alloc(24);
  r.data.fill(0xcc, options1, options1 + 24);
  assert.equal((await call(dev, 13, 8, options1, 24)).result, 0);
  assert.ok(r.data.subarray(options1, options1 + 24).every((b) => b === 0));
  const four = alloc(4);
  r.write32(four, 0xcc);
  assert.equal((await call(dev, 13, 19, four, 4)).result, 0);
  assert.equal(r.read32(four), 0);
  r.write32(four, 0xcc);
  assert.equal((await call(dev, 13, 22, four, 4)).result, 0);
  assert.equal(r.read32(four), 0);

  await call(dev, 2);
});

test('queue, fence, heap and resource metadata calls answer real startup and readback APIs', async () => {
  const f = fixture(),
    { runtime: r, alloc, call, create, api, guid } = f;
  const out = alloc();
  await api('d3d12.dll!D3D12CreateDevice', 0, 0xb000, guid(IID.device), out);
  const dev = r.read32(out);

  const queueDesc = alloc(16);
  const queue = await create(dev, 8, [queueDesc], 'queue');

  // GetTimestampFrequency is one tick per virtual nanosecond (1e9 Hz).
  const freq = alloc(8);
  assert.equal((await call(queue, 16, freq)).result, 0);
  assert.deepEqual([r.read32(freq), r.read32(freq + 4)], [0x40000000, 0x3b9aca00]);

  // GetClockCalibration writes both 64-bit domains; without a guest clock the
  // values are zero but the call must still succeed and touch memory.
  r.performanceClock = { read: () => 1_234_567_890n };
  const gpuTime = alloc(8),
    cpuTime = alloc(8);
  r.data.fill(0xcc, gpuTime, gpuTime + 16);
  assert.equal((await call(queue, 17, gpuTime, cpuTime)).result, 0);
  assert.deepEqual([r.read32(gpuTime), r.read32(gpuTime + 4)], [1_234_567_890, 0]);
  assert.deepEqual([r.read32(cpuTime), r.read32(cpuTime + 4)], [1_234_567_890, 0]);
  // NULL outputs are tolerated.
  assert.equal((await call(queue, 17, 0, 0)).result, 0);

  // PIX/debug markers validate their optional string range and are no-ops.
  const label = alloc(8);
  r.data.set([0x61, 0x62, 0x63, 0, 0, 0, 0, 0], label);
  // SetMarker/BeginEvent(this, Metadata, pData, Size).
  assert.equal((await call(queue, 11, 0, label, 4)).result, undefined);
  assert.equal((await call(queue, 12, 0, label, 4)).result, undefined);
  assert.equal((await call(queue, 13)).result, undefined);
  await assert.rejects(call(queue, 11, 0, label, 0x400000), /Guest memory violation/);

  // GetDesc returns a zeroed D3D12_COMMAND_QUEUE_DESC.
  const descOut = alloc(16);
  r.data.fill(0xcc, descOut, descOut + 16);
  assert.equal((await call(queue, 18, descOut)).result, undefined);
  assert.ok(r.data.subarray(descOut, descOut + 16).every((b) => b === 0));

  // Fence: a completion value at or below the current one signals immediately;
  // a higher value is released by a later Signal.
  const signaled = [];
  r.syncObjects = { signal: (handle) => signaled.push(handle) };
  const fence = await create(dev, 36, [0, 0, 0], 'fence');
  assert.equal((await call(fence, 9, 0, 0, 0x1111)).result, 0);
  assert.deepEqual(signaled, [0x1111], 'a satisfied completion signals at once');
  signaled.length = 0;
  assert.equal((await call(fence, 9, 0x20, 0, 0x2222)).result, 0);
  assert.deepEqual(signaled, [], 'a future completion waits');
  assert.equal((await call(fence, 10, 0x20, 0)).result, 0, 'Signal raises the value');
  assert.deepEqual(signaled, [0x2222], 'Signal releases the pending waiter');
  assert.equal((await call(fence, 8)).result, 0x20, 'GetCompletedValue');
  // A signal below the current value is rejected.
  assert.equal((await call(fence, 10, 0x1f, 0)).result, 0x80070057);
  // A NULL event handle is rejected.
  assert.equal((await call(fence, 9, 0, 0, 0)).result, 0x80070057);

  // Heap GPU handle mirrors the CPU slot address with a zero high word.
  const heapDesc = alloc(16);
  r.write32(heapDesc, 2);
  r.write32(heapDesc + 4, 1);
  const heap = await create(dev, 14, [heapDesc], 'heap');
  const cpu = alloc(4),
    gpu = alloc(8);
  await call(heap, 9, cpu);
  r.data.fill(0xcc, gpu, gpu + 8);
  assert.equal((await call(heap, 10, gpu)).argc, 2);
  assert.deepEqual([r.read32(gpu), r.read32(gpu + 4)], [r.read32(cpu), 0]);

  // Resource subresource I/O and heap properties for an upload buffer.
  const props = alloc(20);
  r.write32(props, 2);
  r.write32(props + 12, 1);
  r.write32(props + 16, 1);
  const bufferDesc = alloc(56);
  r.write32(bufferDesc, 1);
  r.write32(bufferDesc + 16, 64);
  r.write32(bufferDesc + 24, 1);
  r.view.setUint16(bufferDesc + 28, 1, true);
  r.view.setUint16(bufferDesc + 30, 1, true);
  r.write32(bufferDesc + 36, 1);
  r.write32(bufferDesc + 44, 1);
  const buffer = await create(dev, 27, [props, 0, bufferDesc, 0xac3, 0], 'resource');
  const storage = (await call(buffer, 11)).result;
  const source = alloc(64);
  for (let i = 0; i < 64; i++) r.data[source + i] = 0xa0 + i;
  assert.equal((await call(buffer, 12, 0, source, 0, 0, 0)).result, 0);
  assert.deepEqual(
    [...r.data.subarray(storage, storage + 4)],
    [0xa0, 0xa1, 0xa2, 0xa3],
    'WriteToSubresource copied the buffer bytes',
  );
  const target = alloc(64);
  assert.equal((await call(buffer, 13, target, 0, 0, 0)).result, 0);
  assert.deepEqual([...r.data.subarray(target, target + 4)], [0xa0, 0xa1, 0xa2, 0xa3]);
  const heapPropsOut = alloc(20),
    heapFlagsOut = alloc(4);
  assert.equal((await call(buffer, 14, heapPropsOut, heapFlagsOut)).result, 0);
  assert.equal(r.read32(heapPropsOut), 2, 'upload heap type');
  assert.equal(r.read32(heapFlagsOut), 0);
  // Unknown subresource index is rejected for the buffer path.
  assert.equal((await call(buffer, 12, 1, source, 0, 0, 0)).result, 0x80070057);

  await call(heap, 2);
  await call(buffer, 2);
  await call(fence, 2);
  await call(queue, 2);
  await call(dev, 2);
});

test('query heaps record guest-clock timestamps and resolve them into a buffer', async () => {
  const f = fixture(),
    { runtime: r, alloc, call, create, api, guid } = f;
  const out = alloc();
  await api('d3d12.dll!D3D12CreateDevice', 0, 0xb000, guid(IID.device), out);
  const dev = r.read32(out);

  // A timestamp query heap with two slots.
  const heapDesc = alloc(12);
  r.write32(heapDesc, 1); // D3D12_QUERY_HEAP_TYPE_TIMESTAMP
  r.write32(heapDesc + 4, 2);
  r.write32(heapDesc + 8, 1);
  const query = await create(dev, 39, [heapDesc], 'query');
  assert.equal(r.comObjects.objects.get(query).state.type, 1);
  assert.equal(r.comObjects.objects.get(query).state.count, 2);
  // An unsupported heap type is rejected.
  r.write32(heapDesc, 9);
  assert.equal((await call(dev, 39, heapDesc, guid(IID.query), alloc())).result, 0x80070057);
  // A zero count is rejected.
  r.write32(heapDesc, 1);
  r.write32(heapDesc + 4, 0);
  assert.equal((await call(dev, 39, heapDesc, guid(IID.query), alloc())).result, 0x80070057);
  r.write32(heapDesc + 4, 2);

  const queueDesc = alloc(16);
  const queue = await create(dev, 8, [queueDesc], 'queue');
  const allocator = await create(dev, 9, [0], 'allocator');
  const list = await create(dev, 12, [0, 0, allocator, 0], 'list');

  // A readback buffer for the resolved timestamps.
  const props = alloc(20);
  r.write32(props, 3); // D3D12_HEAP_TYPE_READBACK
  r.write32(props + 12, 1);
  r.write32(props + 16, 1);
  const bufferDesc = alloc(56);
  r.write32(bufferDesc, 1);
  r.write32(bufferDesc + 16, 32);
  r.write32(bufferDesc + 24, 1);
  r.view.setUint16(bufferDesc + 28, 1, true);
  r.view.setUint16(bufferDesc + 30, 1, true);
  r.write32(bufferDesc + 36, 1);
  r.write32(bufferDesc + 44, 1);
  const dst = await create(dev, 27, [props, 0, bufferDesc, 0, 0], 'resource');
  const dstStorage = (await call(dst, 11)).result;

  // Begin/End at two monotonically increasing guest-clock samples.
  let clock = 5_000n;
  r.performanceClock = { read: () => (clock += 1_000n) };
  const sequence = [
    [52, query, 2, 0],
    [53, query, 2, 0],
    [52, query, 2, 1],
    [53, query, 2, 1],
  ];
  for (const [slot, heap, type, index] of sequence) await call(list, slot, heap, type, index);
  // A mismatched query type is rejected before recording.
  await assert.rejects(call(list, 52, query, 0, 0), /BeginQuery/);
  await assert.rejects(call(list, 53, query, 2, 5), /EndQuery/);
  // ResolveQueryData copies both timestamps into the destination buffer.
  await call(list, 54, query, 2, 0, 2, dst, 0, 0);
  await assert.rejects(call(list, 54, query, 2, 1, 2, dst, 0, 0), /ResolveQueryData/);
  await call(list, 9);

  const lists = alloc(4);
  r.write32(lists, list);
  await call(queue, 10, 1, lists);

  const first = [
    r.read32(dstStorage),
    r.read32(dstStorage + 4),
  ];
  const second = [
    r.read32(dstStorage + 8),
    r.read32(dstStorage + 12),
  ];
  const asNumber = ([low, high]) => (BigInt(high >>> 0) << 32n) + BigInt(low >>> 0);
  assert.ok(asNumber(first) >= 5_000n, 'first timestamp is the first sample');
  assert.ok(asNumber(second) > asNumber(first), 'second timestamp is later');

  await call(list, 2);
  await call(allocator, 2);
  await call(queue, 2);
  await call(dst, 2);
  await call(query, 2);
  await call(dev, 2);
});
