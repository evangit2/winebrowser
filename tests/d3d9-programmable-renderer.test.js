import test from 'node:test';
import assert from 'node:assert/strict';
import { D3D9ProgrammableRenderer } from '../src/d3d9-programmable-renderer.js';

function fixture() {
  const calls = { translations: 0, pipelines: 0, scopes: 0 };
  const renderer = new D3D9ProgrammableRenderer({
    format: 'rgba8unorm',
    device: {
      pushErrorScope() {
        calls.scopes++;
      },
      async popErrorScope() {
        calls.scopes--;
        return null;
      },
      createShaderModule(descriptor) {
        return descriptor;
      },
      async createRenderPipelineAsync(descriptor) {
        calls.pipelines++;
        await Promise.resolve();
        return { descriptor };
      },
    },
  });
  renderer.compiler = {
    async compileLegacyPair() {
      calls.translations++;
      await Promise.resolve();
      return { vertex: { wgsl: 'vertex' }, pixel: { wgsl: 'pixel' } };
    },
  };
  const command = {
    vertexShaderId: 1,
    pixelShaderId: 2,
    vertexShader: new Uint8Array(8),
    pixelShader: new Uint8Array(8),
    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
    stride: 12,
    depthTest: false,
    depthWrite: false,
    cullMode: 1,
  };
  return { renderer, calls, command, surface: { colorFormat: 21 } };
}

test('concurrent same-state draws translate and create one shared programmable pipeline', async () => {
  const { renderer, calls, surface, command } = fixture();
  const prepared = await Promise.all(
    Array.from({ length: 600 }, () => renderer.pipeline(surface, command)),
  );
  assert.equal(new Set(prepared).size, 1);
  assert.equal(calls.translations, 1);
  assert.equal(calls.pipelines, 1);
  assert.equal(calls.scopes, 0);
  assert.equal(renderer.pendingPipelines.size, 0);
  assert.equal(await renderer.pipeline(surface, command), prepared[0]);
  await renderer.pipeline(surface, { ...command, pixelShaderId: 3 });
  assert.equal(calls.pipelines, 2);
});

test('failed shared translation releases its pending entry so the pipeline can retry', async () => {
  const { renderer, calls, surface, command } = fixture();
  const original = renderer.compiler.compileLegacyPair;
  renderer.compiler.compileLegacyPair = async () => {
    throw Error('shader rejected');
  };
  const failed = await Promise.allSettled(
    Array.from({ length: 20 }, () => renderer.pipeline(surface, command)),
  );
  assert.ok(
    failed.every(
      (result) => result.status === 'rejected' && result.reason.message === 'shader rejected',
    ),
  );
  assert.equal(renderer.pendingPipelines.size, 0);
  assert.equal(renderer.pipelines.size, 0);
  renderer.compiler.compileLegacyPair = original;
  await renderer.pipeline(surface, command);
  assert.equal(calls.pipelines, 1);
});
