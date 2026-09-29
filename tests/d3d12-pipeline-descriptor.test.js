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
  const setup = ({
    blendDefault = false,
    depth = null,
    depthEnable = 1,
    stencilEnable = 0,
  } = {}) => {
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
    if (depth !== null) {
      view.setUint32(pointer + 440, depthEnable, true); // DepthEnable
      view.setUint32(pointer + 444, 1, true); // DepthWriteMask = ALL
      view.setUint32(pointer + 448, depth, true); // DepthFunc
      data[pointer + 452] = stencilEnable;
      view.setUint32(pointer + 544, 55, true); // DSVFormat = D16_UNORM
    }
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

test('D3D12 pipeline parser maps an enabled blend state onto WebGPU factors', () => {
  const f = buffer();
  // SourceAlpha / OneMinusSourceAlpha with ADD on both colour and alpha is the
  // ordinary "over" state a HUD or particle layer uses.
  const p = f.setup();
  f.view.setUint32(p + 72, 1, true); // Enable
  f.view.setUint32(p + 80, 5, true); // SrcBlend = SRC_ALPHA
  f.view.setUint32(p + 84, 6, true); // DestBlend = INV_SRC_ALPHA
  f.view.setUint32(p + 88, 1, true); // BlendOp = ADD
  f.view.setUint32(p + 92, 2, true); // SrcBlendAlpha = ONE
  f.view.setUint32(p + 96, 1, true); // DestBlendAlpha = ZERO
  f.view.setUint32(p + 100, 1, true); // BlendOpAlpha = ADD
  f.data[p + 72 + 36] = 15; // RenderTargetWriteMask
  const parsed = f.parse(p);
  assert.equal(parsed.alphaToCoverage, false);
  assert.deepEqual(parsed.blend, [
    {
      writeMask: 15,
      enabled: true,
      color: { operation: 'add', srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
      alpha: { operation: 'add', srcFactor: 'one', dstFactor: 'zero' },
    },
  ]);
  // MIN/MAX ignore the factors, which D3D requires to be ONE.
  const min = f.setup();
  f.view.setUint32(min + 72, 1, true);
  f.view.setUint32(min + 80, 2, true);
  f.view.setUint32(min + 84, 2, true);
  f.view.setUint32(min + 88, 4, true);
  f.view.setUint32(min + 92, 2, true);
  f.view.setUint32(min + 96, 2, true);
  f.view.setUint32(min + 100, 4, true);
  f.data[min + 72 + 36] = 15;
  assert.deepEqual(f.parse(min).blend[0].color.operation, 'min');
});

test('D3D12 pipeline parser maps every depth comparison and a disabled test', () => {
  const f = buffer();
  for (const [value, expected] of [
    [1, 'never'],
    [2, 'less'],
    [3, 'equal'],
    [4, 'less-equal'],
    [5, 'greater'],
    [6, 'not-equal'],
    [7, 'greater-equal'],
    [8, 'always'],
  ]) {
    const p = f.setup({ depth: value });
    const parsed = f.parse(p);
    assert.equal(parsed.depth.compare, expected);
    assert.equal(parsed.depth.testEnabled, true);
  }
  // DepthEnable = FALSE is legal and reports the test as disabled.
  const off = f.setup({ depth: 4, depthEnable: 0 });
  assert.equal(f.parse(off).depth.testEnabled, false);
  // An out-of-range comparison is rejected rather than narrowed.
  assert.throws(() => f.parse(f.setup({ depth: 9 })), /depth\/stencil pipeline/);
  // StencilEnable is not modelled and must fail explicitly.
  assert.throws(() => f.parse(f.setup({ depth: 4, stencilEnable: 1 })), /depth\/stencil pipeline/);
});

test('D3D12 pipeline parser rejects unsupported rasterizer and blend state', () => {
  const f = buffer();
  // Wireframe fill and depth bias are unsupported.
  let p = f.setup();
  f.view.setUint32(p + 396, 2, true);
  assert.throws(() => f.parse(p), /rasterizer/);
  p = f.setup();
  f.view.setUint32(p + 408, 4, true);
  assert.throws(() => f.parse(p), /rasterizer/);
  // A dual-source factor has no single-source WebGPU equivalent, so it is
  // refused rather than silently substituted.
  p = f.setup();
  f.view.setUint32(p + 72, 1, true);
  f.view.setUint32(p + 80, 16, true); // SRC1_COLOR
  f.view.setUint32(p + 84, 1, true);
  f.view.setUint32(p + 88, 1, true); // BlendOp = ADD
  f.view.setUint32(p + 92, 2, true);
  f.view.setUint32(p + 96, 1, true);
  f.view.setUint32(p + 100, 1, true);
  f.data[p + 72 + 36] = 15;
  assert.throws(() => f.parse(p), /blend factor/);
  // A logic operation other than NOOP cannot be expressed.
  p = f.setup();
  f.view.setUint32(p + 72, 1, true);
  f.view.setUint32(p + 80, 2, true);
  f.view.setUint32(p + 84, 1, true);
  f.view.setUint32(p + 88, 1, true);
  f.view.setUint32(p + 92, 2, true);
  f.view.setUint32(p + 96, 1, true);
  f.view.setUint32(p + 100, 1, true);
  f.view.setUint32(p + 104, 2, true); // LogicOp = COPY
  assert.throws(() => f.parse(p), /logic operation/);
  // A write mask outside RGBA is a malformed descriptor.
  p = f.setup();
  f.view.setUint32(p + 72, 1, true);
  f.view.setUint32(p + 80, 2, true);
  f.view.setUint32(p + 84, 1, true);
  f.view.setUint32(p + 88, 1, true);
  f.view.setUint32(p + 92, 2, true);
  f.view.setUint32(p + 96, 1, true);
  f.view.setUint32(p + 100, 1, true);
  f.data[p + 72 + 36] = 0x80;
  assert.throws(() => f.parse(p), /write mask/);
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
  });
  // The semantic names and indices are reported as declared; the vertex shader
  // signature decides the WebGPU shader location, not the parser.
  assert.deepEqual(layout.attributes, [
    {
      semanticName: 'POSITION',
      semanticIndex: 0,
      format: 'float32x3',
      components: 3,
      offset: 0,
    },
    {
      semanticName: 'COLOR',
      semanticIndex: 0,
      format: 'float32x4',
      components: 4,
      offset: 12,
    },
  ]);
  assert.equal(layout.stride, 28);
});

test('input layouts accept the formats a textured vertex carries', () => {
  const data = new Uint8Array(256);
  const view = new DataView(data.buffer);
  const write = (offset, text) => {
    for (const [index, ch] of [...text].entries()) data[offset + index] = ch.charCodeAt(0);
    data[offset + text.length] = 0;
  };
  const positionName = 160,
    uvName = 176;
  write(positionName, 'POSITION');
  write(uvName, 'TEXCOORD');
  const element = (index, name, format, offset, semanticIndex = 0) => {
    const base = 8 + index * 28;
    view.setUint32(base, name, true);
    view.setUint32(base + 4, semanticIndex, true);
    view.setUint32(base + 8, format, true);
    view.setUint32(base + 16, offset, true);
  };
  element(0, positionName, 2, 0); // R32G32B32A32_FLOAT
  element(1, uvName, 16, 16); // R32G32_FLOAT
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
  });
  assert.deepEqual(
    layout.attributes.map((a) => [a.semanticName, a.format, a.offset]),
    [
      ['POSITION', 'float32x4', 0],
      ['TEXCOORD', 'float32x2', 16],
    ],
  );
  assert.equal(layout.stride, 24);
});

test('input layouts reject an unknown semantic format and a duplicate', () => {
  const data = new Uint8Array(256);
  const view = new DataView(data.buffer);
  const write = (offset, text) => {
    for (const [index, ch] of [...text].entries()) data[offset + index] = ch.charCodeAt(0);
    data[offset + text.length] = 0;
  };
  const name = 160;
  write(name, 'POSITION');
  const element = (index, format) => {
    const base = 8 + index * 28;
    view.setUint32(base, name, true);
    view.setUint32(base + 8, format, true);
  };
  const accessors = {
    check: (p, n) => p,
    read32: (p) => view.getUint32(p, true),
    readString: (p) => {
      let value = '';
      while (data[p]) value += String.fromCharCode(data[p++]);
      return value;
    },
    pointer: 8,
  };
  // XYZ32_UNORM (63) is not a per-vertex float layout the backend feeds.
  element(0, 63);
  assert.throws(
    () => parseInputLayout({ ...accessors, count: 1 }),
    /Unsupported D3D12 input layout element/,
  );
  // The same semantic and index twice is not a legal input layout.
  element(0, 6);
  element(1, 6);
  assert.throws(
    () => parseInputLayout({ ...accessors, count: 2 }),
    /Unsupported D3D12 input layout element/,
  );
});
