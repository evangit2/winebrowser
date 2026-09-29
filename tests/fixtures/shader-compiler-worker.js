import { ShaderCompiler } from '../../src/shader-compiler.js';

onmessage = async ({ data }) => {
  let device;
  try {
    const compiler = new ShaderCompiler({ baseURL: new URL('/', location.origin) });
    const start = performance.now();
    const vertex = await compiler.compile(data.vertex);
    const fragment = await compiler.compile(data.fragment);
    const legacy = await compiler.compileLegacyPair(data.legacyVertex, data.legacyPixel);
    const compilationMs = performance.now() - start;
    const rootSignatures = [];
    const rootSignatureBlobs = [];
    for (const flags of [0, 1]) {
      const bytes = await compiler.serializeRootSignature(flags);
      const parsed = await compiler.validateRootSignature(bytes);
      if (parsed !== flags) throw Error('Root signature flags changed during round trip');
      rootSignatures.push({ flags, bytes: bytes.length });
      // Snapshot before the corruption check below mutates this buffer.
      rootSignatureBlobs.push({ flags, bytes: bytes.slice() });
      bytes[4] ^= 1;
      let rejected = false;
      try {
        await compiler.validateRootSignature(bytes);
      } catch {
        rejected = true;
      }
      if (!rejected) throw Error('Corrupt root signature accepted');
    }
    // Canonical D3D12 bindings: scan a shader that declares constant buffers,
    // textures and samplers, plan a dense per-kind layout, recompile the shader
    // against it and confirm the emitted WGSL honours the assigned groups.
    const descriptorSource = new TextEncoder().encode(
      [
        'cbuffer CB0 : register(b0) { float4x4 mvp; };',
        'cbuffer CB1 : register(b2) { float4 tint; };',
        'Texture2D tex0 : register(t0);',
        'TextureCube env : register(t3);',
        'SamplerState samp0 : register(s0);',
        'SamplerState samp2 : register(s2);',
        'struct VSOut { float4 p : SV_Position; float2 uv : TEXCOORD0; };',
        'float4 main(VSOut i) : SV_Target {',
        '  return tex0.Sample(samp0, i.uv) * tint',
        '    + env.Sample(samp2, float3(i.uv, 1)) + mvp[0];',
        '}',
      ].join('\n'),
    );
    const { bytes: descriptorDXBC } = await compiler.compileHLSL(
      descriptorSource,
      'main',
      'ps_5_0',
      'bindings.hlsl',
    );
    const descriptors = await compiler.scanDescriptors(descriptorDXBC);
    const module = await import('../../src/d3d12-bindings.js');
    const plan = module.canonicalBindings(descriptors);
    const bound = await compiler.compileBound(descriptorDXBC, plan.bindings);
    // The declared registers must appear with exactly the planned decorations.
    const decorations = new Map();
    for (const binding of plan.bindings)
      decorations.set(`${binding.group}:${binding.binding}`, binding);
    const observed = [...bound.wgsl.matchAll(/@group\((\d+)\) @binding\((\d+)\)/g)].map((match) =>
      Number(match[1]) + ':' + Number(match[2]),
    );
    const expected = [...decorations.keys()].sort();
    if (JSON.stringify(observed.sort()) !== JSON.stringify(expected))
      throw Error(
        'Bound WGSL groups/bindings do not match the planned layout: ' +
          JSON.stringify({ observed, expected }),
      );

    // A guest D3D12_ROOT_SIGNATURE_DESC (as D3D12HelloTexture declares it: an
    // SRV descriptor table, a pixel static sampler and a root CBV) must parse
    // into the flattened description, build into a real DXBC container and
    // inspect back into the same shape. This is the exact path
    // D3D12SerializeRootSignature takes for a non-empty signature.
    const memory = new Uint8Array(512);
    const memoryView = new DataView(memory.buffer);
    let alloc = memory.length;
    const reserve = (bytes) => (alloc = (alloc - bytes) & ~3);
    const put32 = (at, value, offset = 0) =>
      memoryView.setUint32(at + offset, value >>> 0, true);
    const putFloat = (at, value, offset = 0) => memoryView.setFloat32(at + offset, value, true);
    const rangeArray = reserve(20);
    put32(rangeArray, 0); // D3D12_DESCRIPTOR_RANGE_TYPE_SRV
    put32(rangeArray, 1, 4);
    put32(rangeArray, 0, 8);
    put32(rangeArray, 0, 12);
    put32(rangeArray, 0, 16);
    const parameters = reserve(40);
    put32(parameters, 0); // D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE
    put32(parameters, 1, 4);
    put32(parameters, rangeArray, 8);
    put32(parameters, 5, 16); // D3D12_SHADER_VISIBILITY_PIXEL
    put32(parameters, 2, 20); // D3D12_ROOT_PARAMETER_TYPE_CBV
    put32(parameters, 0, 24);
    put32(parameters, 0, 28);
    put32(parameters, 1, 36); // D3D12_SHADER_VISIBILITY_VERTEX
    const samplerArray = reserve(52);
    put32(samplerArray, 21); // MIN_MAG_MIP_LINEAR
    put32(samplerArray, 3, 4);
    put32(samplerArray, 3, 8);
    put32(samplerArray, 3, 12);
    putFloat(samplerArray, 0, 16);
    put32(samplerArray, 1, 20);
    putFloat(samplerArray, 0, 32);
    putFloat(samplerArray, 3.4028234663852886e38, 36);
    put32(samplerArray, 0, 40);
    put32(samplerArray, 0, 44);
    put32(samplerArray, 5, 48);
    const description = reserve(20);
    put32(description, 2);
    put32(description, parameters, 4);
    put32(description, 1, 8);
    put32(description, samplerArray, 12);
    put32(description, 1, 16);
    const descriptorParser = await import('../../src/d3d12-descriptors.js');
    const flattened = descriptorParser.parseRootSignatureDescriptor({
      check: (pointer, length) => {
        if (!Number.isInteger(pointer) || pointer < 0 || pointer + length > memory.length)
          throw Error('out of bounds');
        return pointer;
      },
      read32: (pointer) => memoryView.getUint32(pointer, true),
      readFloat32: (pointer) => memoryView.getFloat32(pointer, true),
      pointer: description,
    });
    if (!flattened) throw Error('Guest root signature description was rejected');
    const builtTable = await compiler.buildRootSignature(flattened);
    const inspectedTable = await compiler.inspectRootSignature(builtTable);
    if (inspectedTable.words.length !== flattened.length ||
        inspectedTable.words.some((word, index) => word !== flattened[index]))
      throw Error('Application root signature did not round trip through the bridge');

    // Root-signature inspection must report the serialised structure, not just
    // accept it, and rebuilding from those words must reproduce the exact
    // container: the same description has to survive a full round trip.
    const signatureWords = await compiler.inspectRootSignature(rootSignatureBlobs[1].bytes);
    const rebuiltSignature = await compiler.buildRootSignature(signatureWords.words);
    const original = rootSignatureBlobs[1].bytes;
    if (
      rebuiltSignature.length !== original.length ||
      rebuiltSignature.some((byte, index) => byte !== original[index])
    )
      throw Error('Rebuilt root signature differs from the serialized original');
    // A signature the bridge itself produced from a real description must also
    // inspect back into the same description.
    const descriptorTable = await compiler.serializeRootSignature(1);
    const descriptorInspected = await compiler.inspectRootSignature(descriptorTable);
    const rebuiltTable = await compiler.buildRootSignature(descriptorInspected.words);
    if (
      rebuiltTable.length !== descriptorTable.length ||
      rebuiltTable.some((byte, index) => byte !== descriptorTable[index])
    )
      throw Error('Empty root signature did not survive a build round trip');

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw Error('WebGPU adapter unavailable');
    device = await adapter.requestDevice();
    device.pushErrorScope('validation');
    const modules = [vertex, fragment, legacy.vertex, legacy.pixel].map(({ wgsl }) =>
      device.createShaderModule({ code: wgsl }),
    );
    for (const module of modules) {
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter((message) => message.type === 'error');
      if (errors.length) throw Error(errors.map((error) => error.message).join('\n'));
    }
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: modules[0] },
      fragment: { module: modules[1], targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    const texture = device.createTexture({
      size: [128, 128],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    });
    const readback = device.createBuffer({
      size: 128 * 128 * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const drawParameters = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const groups = Array.from({ length: 4 }, (_, index) =>
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(index),
        entries: index === 3 ? [{ binding: 0, resource: { buffer: drawParameters } }] : [],
      }),
    );
    const render = async (firstVertex) => {
      device.queue.writeBuffer(drawParameters, 0, new Int32Array([firstVertex, 0, 0, 0]));
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: texture.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [17 / 255, 34 / 255, 51 / 255, 1],
          },
        ],
      });
      pass.setPipeline(pipeline);
      groups.forEach((group, index) => pass.setBindGroup(index, group));
      pass.setViewport(16, 16, 96, 96, 0, 1);
      pass.draw(3, 1, firstVertex, 0);
      pass.end();
      encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: 512 }, [128, 128]);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const pixels = new Uint8Array(readback.getMappedRange()).slice();
      readback.unmap();
      return pixels;
    };
    const pixels = await render(0);
    const offsetPixels = await render(7);
    const drawOffsetPreserved = pixels.every((value, index) => value === offsetPixels[index]);
    const validation = await device.popErrorScope();
    if (validation) throw Error(validation.message);
    texture.destroy();
    readback.destroy();
    drawParameters.destroy();

    const invalid = [];
    for (const bytes of [new Uint8Array(32), data.vertex.slice(0, 32)]) {
      try {
        await compiler.compile(bytes);
        throw Error('Malformed shader was accepted');
      } catch (error) {
        if (error.message === 'Malformed shader was accepted') throw error;
        invalid.push(error.message);
      }
    }
    for (const [legacyVertex, legacyPixel] of [
      [data.legacyPixel, data.legacyPixel],
      [data.legacyVertex.slice(0, -4), data.legacyPixel],
    ]) {
      try {
        await compiler.compileLegacyPair(legacyVertex, legacyPixel);
        throw Error('Malformed legacy shader was accepted');
      } catch (error) {
        if (error.message === 'Malformed legacy shader was accepted') throw error;
        invalid.push(error.message);
      }
    }
    postMessage(
      {
        type: 'shader-result',
        pixels,
        compilationMs,
        drawOffsetPreserved,
        rootSignatures,
        descriptorBindings: {
          scanned: descriptors.map(({ type, space, register, resourceType, dataType }) => ({
            type,
            space,
            register,
            resourceType,
            dataType,
          })),
          planned: plan.bindings.map(({ type, space, register, group, binding }) => ({
            type,
            space,
            register,
            group,
            binding,
          })),
          boundWGSL: bound.wgsl,
        },
        signatureWords: Array.from(signatureWords.words),
        applicationSignature: {
          flattened: Array.from(flattened),
          builtBytes: builtTable.length,
          roundTripWords: inspectedTable.words.length,
        },
        signatureRoundTrip: {
          originalBytes: original.length,
          rebuiltBytes: rebuiltSignature.length,
          rebuiltEmptyBytes: rebuiltTable.length,
        },
        signatureFlags: signatureWords.flags,
        shaders: [vertex, fragment].map(({ spirv, wgsl }) => ({ spirvBytes: spirv.length, wgsl })),
        legacy: {
          vertex: { spirvBytes: legacy.vertex.spirv.length, wgsl: legacy.vertex.wgsl },
          pixel: { spirvBytes: legacy.pixel.spirv.length, wgsl: legacy.pixel.wgsl },
          bindings: legacy.bindings,
        },
        invalid,
      },
      [pixels.buffer],
    );
  } catch (error) {
    postMessage({ type: 'shader-result', error: error.stack ?? error.message ?? String(error) });
  } finally {
    device?.destroy();
  }
};
