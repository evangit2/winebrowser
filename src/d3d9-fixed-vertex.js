import { fvfLayout } from './d3d-fvf.js';

function multiply(a, b) {
  const result = new Float32Array(16);
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < 4; column++)
      for (let k = 0; k < 4; k++) result[row * 4 + column] += a[row * 4 + k] * b[k * 4 + column];
  return result;
}

// Native D3D9 allows a programmable pixel shader with fixed vertex processing.
// Generate ordinary VS2 bytecode so the same Wine shader compiler links the
// fixed outputs to the guest pixel shader's COLOR/TEXCOORD semantics.
export function fixedVertexShader(state) {
  const layout = fvfLayout(state.fvf);
  if (!layout || state.vertexDeclaration)
    throw Error('Fixed vertex processing with a pixel shader requires an FVF layout');
  if (layout.normal !== null && state.lightState[137])
    throw Error('Lit fixed vertices with a programmable pixel shader are unsupported');
  const inputs = [{ usage: layout.rhw ? 9 : 0, usageIndex: 0, register: 0 }];
  if (layout.diffuse !== null) inputs.push({ usage: 10, usageIndex: 0, register: 1 });
  if (layout.specular !== null) inputs.push({ usage: 10, usageIndex: 1, register: 2 });
  layout.texcoords.forEach((_coordinate, index) =>
    inputs.push({ usage: 5, usageIndex: index, register: 3 + index }),
  );
  const words = [0xfffe0200];
  for (const input of inputs)
    words.push(
      0x0200001f,
      (0x80000000 | input.usage | (input.usageIndex << 16)) >>> 0,
      (0x900f0000 | input.register) >>> 0,
    );
  if (layout.rhw) {
    words.push(
      0x02000001,
      0x800f0000,
      0x90e40000, // mov r0, v0
      0x02000001,
      0x80080000,
      0xa0ff0004, // mov r0.w, c4.w (1)
      0x03000014,
      0x800f0001,
      0x80e40000,
      0xa0e40000, // m4x4 r1, r0, c0
      0x02000006,
      0x80080000,
      0x90ff0000, // rcp r0.w, v0.w
      0x03000005,
      0xc0070000,
      0x80e40001,
      0x80ff0000, // mul oPos.xyz, r1, r0.w
      0x02000001,
      0xc0080000,
      0x80ff0000, // mov oPos.w, r0.w
    );
  } else words.push(0x03000014, 0xc00f0000, 0x90e40000, 0xa0e40000);
  words.push(0x02000001, 0xd00f0000, layout.diffuse === null ? 0xa0e40004 : 0x90e40001);
  words.push(0x02000001, 0xd00f0001, layout.specular === null ? 0xa0e40005 : 0x90e40002);
  for (let index = 0; index < 8; index++)
    words.push(
      0x02000001,
      (0xe00f0000 | index) >>> 0,
      index < layout.texcoords.length ? (0x90e40000 | (3 + index)) >>> 0 : 0xa0e40005,
    );
  words.push(0xffff);
  let matrix;
  if (layout.rhw) {
    const { x, y, width, height, minZ, maxZ } = state.viewport;
    matrix = Float32Array.from([
      2 / width,
      0,
      0,
      0,
      0,
      -2 / height,
      0,
      0,
      0,
      0,
      maxZ - minZ,
      0,
      -1 - (2 * x) / width,
      1 + (2 * y) / height,
      minZ,
      1,
    ]);
  } else matrix = multiply(multiply(state.world, state.view), state.projection);
  if (!matrix.every(Number.isFinite)) throw Error('Non-finite fixed vertex transform');
  const constants = new Float32Array(1024);
  // VS m4x4 computes dot products against constant rows; D3D transform
  // storage uses row vectors, so each row here is a column of W*V*P.
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < 4; column++)
      constants[row * 4 + column] = matrix[column * 4 + row];
  constants.fill(1, 16, 20);
  return {
    pointer: `fixed-fvf:${state.fvf}`,
    state: { inputs, bytes: new Uint8Array(new Uint32Array(words).buffer) },
    constants,
  };
}
