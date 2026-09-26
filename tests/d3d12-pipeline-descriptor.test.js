import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInputLayout, parsePipelineDescriptor } from '../src/d3d12-descriptors.js';

// The descriptor layout is validated against the i686-w64-mingw32 d3d12.h
// offsets: BlendState=64, SampleMask=392, Rasterizer=396, DepthStencil=440,
// InputLayout=492, Topology=504, NumRenderTargets=508, RTVFormats=512,
// DSVFormat=544, SampleDesc=548, NodeMask=556.
function buffer() {
  const data = new Uint8Array(1024);
  const view = new DataView(data.buffer);
  const read32 = (pointer) => view.getUint32(pointer, true);
  const strings = new Map();
  const readString = (pointer) => strings.get(pointer) ?? '\0';
  const setup = ({ blendDefault = false } = {}) => {
    const pointer = 0;
    data.fill(0);
    view.setUint32(pointer + 392, 0xffffffff, true);
    view.setUint32(pointer + 396, 3, true); // FILL_MODE_SOLID
    view.setUint32(pointer + 400, 3, true); // CULL_MODE_BACK
    view.setUint32(pointer + 420, 1, true); // DepthClipEnable
    view.setUint32(pointer + 504, 3, true); // TRIANGLE
    view.setUint32(pointer + 508, 1, true);
    view.setUint32(pointer + 512, 28, true); // R8G8B8A8_UNORM
    view.setUint32(pointer + 548, 1, true); // SampleDesc.Count
    if (blendDefault)
      for (let rt = 0; rt < 8; rt++) {
        const base = pointer + 72 + rt * 40;
        for (const [index, value] of [
          [2, 2], // SrcBlend ONE
          [3, 1], // DestBlend ZERO
          [4, 1], // BlendOp ADD
          [5, 2], // SrcBlendAlpha ONE
          [6, 1], // DestBlendAlpha ZERO
          [7, 1], // BlendOpAlpha ADD
          [8, 4], // LOGIC_OP_NOOP
        ])
          view.setUint32(base + index * 4, value, true);
        data[base + 36] = 15;
      }
    return pointer;
  };
  const parse = (pointer = 0) =>
    parsePipelineDescriptor({
      check: (p, n) => {
        if (p < 0 || n < 1 || p + n > data.length) throw Error('Guest memory violation');
        return p;
      },
      data,
      read32,
      readString,
      pointer,
    });
  return { data, view, setup, parse, strings, read32 };
}

test('D3D12 pipeline parser accepts both documented default blend descriptors', () => {
  const f = buffer();
  // CD3DX12_BLEND_DESC default constructor: an all-zero disabled blend state.
  assert.equal(f.parse(f.setup()).cullMode, 'back');
  // CD3DX12_BLEND_DESC(D3D12_DEFAULT): Copy (ONE/ZERO/ADD) with all channels.
  const parsed = f.parse(f.setup({ blendDefault: true }));
  assert.equal(parsed.cullMode, 'back');
  assert.equal(parsed.frontFace, 'cw');
});

test('D3D12 pipeline parser honors cull mode and front-face winding', () => {
  const f = buffer();
  for (const [mode, expected] of [
    [1, 'none'],
    [2, 'front'],
    [3, 'back'],
  ]) {
    const p = f.setup();
    f.view.setUint32(p + 400, mode, true);
    assert.equal(f.parse(p).cullMode, expected);
  }
  const front = f.setup();
  f.view.setUint32(front + 404, 1, true);
  assert.equal(f.parse(front).frontFace, 'ccw');
});

test('D3D12 pipeline parser rejects unsupported blend, rasterizer and alpha state', () => {
  const f = buffer();
  // AlphaToCoverage / IndependentBlend are not supported.
  let p = f.setup();
  f.view.setUint32(p + 64, 1, true);
  assert.throws(() => f.parse(p), /alpha-to-coverage/);
  // Wireframe fill and depth bias are unsupported.
  p = f.setup();
  f.view.setUint32(p + 396, 2, true);
  assert.throws(() => f.parse(p), /rasterizer/);
  p = f.setup();
  f.view.setUint32(p + 408, 4, true);
  assert.throws(() => f.parse(p), /rasterizer/);
  // An enabled blend state with non-default factors is unsupported.
  p = f.setup();
  f.view.setUint32(p + 72, 1, true);
  assert.throws(() => f.parse(p), /blend state/);
});

test('D3D12 input layouts map R32G32B32_FLOAT and R32G32B32A32_FLOAT to WebGPU formats', () => {
  const data = new Uint8Array(256);
  const view = new DataView(data.buffer);
  const write = (offset, text) => {
    for (const [index, ch] of [...text].entries()) data[offset + index] = ch.charCodeAt(0);
    data[offset + text.length] = 0;
  };
  const positionName = 160,
    colourName = 176;
  write(positionName, 'POSITION');
  write(colourName, 'COLOR');
  // Two 28-byte D3D12_INPUT_ELEMENT_DESC records at address 8.
  const element = (index, name, format, offset) => {
    const base = 8 + index * 28;
    view.setUint32(base, name, true);
    view.setUint32(base + 8, format, true);
    view.setUint32(base + 16, offset, true);
  };
  element(0, positionName, 6, 0); // R32G32B32_FLOAT
  element(1, colourName, 2, 12); // R32G32B32A32_FLOAT
  const layout = parseInputLayout({
    check: (p, n) => {
      if (p < 0 || n < 1 || p + n > data.length) throw Error('Guest memory violation');
      return p;
    },
    read32: (p) => view.getUint32(p, true),
    readString: (p) => {
      let value = '';
      while (data[p]) value += String.fromCharCode(data[p++]);
      return value;
    },
    pointer: 8,
    count: 2,
    semantics: [
      { semantic: 'POSITION', semanticIndex: 0, shaderLocation: 0 },
      { semantic: 'COLOR', semanticIndex: 0, shaderLocation: 1 },
    ],
  });
  assert.deepEqual(layout.attributes, [
    {
      semantic: 'POSITION',
      semanticIndex: 0,
      shaderLocation: 0,
      format: 'float32x3',
      offset: 0,
      width: 3,
    },
    {
      semantic: 'COLOR',
      semanticIndex: 0,
      shaderLocation: 1,
      format: 'float32x4',
      offset: 12,
      width: 4,
    },
  ]);
  assert.equal(layout.stride, 28);
});
