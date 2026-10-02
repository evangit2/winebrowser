import test from 'node:test';
import assert from 'node:assert/strict';
import { openglApis } from '../src/opengl.js';
import { gdiApis } from '../src/win32-gdi.js';
import { OpenGLRenderer, opaqueGLPixels } from '../src/opengl-renderer.js';
import { browserGLSL } from '../src/opengl-shaders.js';

function runtime() {
  const data = new Uint8Array(65536),
    view = new DataView(data.buffer);
  const calls = [];
  const gl = {
    isContextLost: () => false,
    getExtension: () => null,
    uniform1f: (...values) => calls.push(values),
    bufferData: (...values) => calls.push(values),
    getError: () => 0,
  };
  const opengl = new OpenGLRenderer({
    canvasFactory: () => ({
      getContext: () => gl,
      addEventListener: () => {},
    }),
  });
  const r = {
    data,
    view,
    opengl,
    calls,
    threads: { current: { id: 1 } },
    windows: {
      windows: new Map([
        [1, { width: 800, height: 600 }],
        [2, { width: 640, height: 480 }],
      ]),
    },
    emit: () => {},
    lastError: 0,
    check(p, n) {
      if (p < 0 || n < 0 || p + n > data.length) throw Error('guest pointer outside memory');
    },
    read32(p) {
      this.check(p, 4);
      return view.getUint32(p, true);
    },
    write32(p, v) {
      this.check(p, 4);
      view.setUint32(p, v >>> 0, true);
    },
  };
  r.dc = gdiApis['user32.dll!GetDC'](r, () => 1).result;
  r.otherDC = gdiApis['user32.dll!GetDC'](r, () => 2).result;
  r.pfd = 256;
  view.setUint16(256, 40, true);
  view.setUint16(258, 1, true);
  r.write32(260, 0x25);
  return r;
}
const call = (r, name, ...values) =>
  openglApis[
    (name.startsWith('wgl') || name.startsWith('gl') ? 'opengl32' : 'gdi32') + '.dll!' + name
  ](r, (i) => values[i] >>> 0);
function context(r) {
  assert.equal(call(r, 'SetPixelFormat', r.dc, 1, r.pfd).result, 1);
  const id = call(r, 'wglCreateContext', r.dc).result;
  assert.equal(call(r, 'wglMakeCurrent', r.dc, id).result, 1);
  return r.opengl.contexts.get(id);
}

test('pixel formats and WGL contexts enforce live DC, window, thread and current-context ownership', () => {
  const r = runtime();
  assert.equal(call(r, 'wglCreateContext', r.dc).result, 0, 'pixel format is required');
  assert.equal(call(r, 'ChoosePixelFormat', 0xffffffff, r.pfd).result, 0);
  const c = context(r);
  assert.equal(call(r, 'SetPixelFormat', r.dc, 1, r.pfd).result, 0, 'set once per window');
  assert.equal(call(r, 'wglMakeCurrent', r.otherDC, c.id).result, 0);
  r.threads.current.id = 2;
  assert.equal(call(r, 'wglMakeCurrent', r.dc, c.id).result, 0, 'another thread owns it');
  assert.equal(
    call(r, 'wglDeleteContext', c.id).result,
    0,
    'another thread owns the current context',
  );
  r.threads.current.id = 1;
  assert.equal(call(r, 'wglMakeCurrent', 0, 0).result, 1);
  assert.equal(call(r, 'glBufferData', 0x8892, 4, 300, 0x88e4).result, 0);
  assert.equal(r.calls.length, 0, 'Windows null-context dispatch ignores GL calls');
  assert.equal(call(r, 'wglDeleteContext', c.id).result, 1);
  gdiApis['user32.dll!ReleaseDC'](r, (i) => [1, r.dc][i]);
  assert.equal(call(r, 'wglCreateContext', r.dc).result, 0, 'released DC is invalid');
});

test('deleting this thread current WGL context unbinds it as Windows does', () => {
  const r = runtime(),
    c = context(r);
  assert.equal(call(r, 'wglDeleteContext', c.id).result, 1);
  assert.equal(call(r, 'wglGetCurrentContext').result, 0);
  assert.equal(call(r, 'wglGetCurrentDC').result, 0);
});

test('uniform locations belong to the selected program and -1 is the documented no-op', () => {
  const r = runtime(),
    c = context(r),
    object = {};
  const location = r.opengl.name(c, 'uniform', object);
  c.names.get(location).program = 41;
  c.program = 41;
  const bits = new Uint32Array(new Float32Array([0.75]).buffer)[0];
  call(r, 'glUniform1f', location, bits);
  assert.deepEqual(r.calls, [[object, 0.75]]);
  call(r, 'glUniform1f', 0xffffffff, bits);
  assert.equal(r.calls.length, 1);
  c.program = 42;
  assert.throws(() => call(r, 'glUniform1f', location, bits), /current program/);
});

test('buffer uploads check guest ranges and size before submitting and snapshot the bytes', () => {
  const r = runtime();
  context(r);
  r.data.set([1, 2, 3, 4], 300);
  call(r, 'glBufferData', 0x8892, 4, 300, 0x88e4);
  r.data[300] = 9;
  assert.deepEqual([...r.calls[0][1]], [1, 2, 3, 4]);
  assert.throws(() => call(r, 'glBufferData', 0x8892, 4, 65534, 0x88e4), /outside memory/);
  assert.throws(() => call(r, 'glBufferData', 0x8892, 0xffffffff, 0, 0x88e4), /size limit/);
  assert.equal(r.calls.length, 1);
});

test('GLSL interface conversion preserves the guest calculations and leaves comments intact', () => {
  const shader =
    '// texture2D varying gl_FragColor\n#version 450 core\nvoid main(){ gl_FragColor=texture2D(tex, uv)*vec4(0.25); }';
  const converted = browserGLSL(shader, 0x8b30);
  assert.match(converted, /^#version 300 es/);
  assert.match(converted, /\/\/ texture2D varying gl_FragColor/);
  assert.match(converted, /wbFragmentColor=texture\(tex, uv\)\*vec4\(0.25\)/);
  assert.match(
    browserGLSL('attribute vec3 p; varying vec3 normal;', 0x8b31),
    /in vec3 p; out vec3 normal/,
  );
  assert.throws(() => browserGLSL('#version 999\nvoid main(){}', 0x8b30), /Unsupported/);
});

test('legacy matrix and vertex built-ins adapt their interface while preserving shader calculations', () => {
  const shader = browserGLSL(
    'void main(){ gl_Position=gl_ModelViewProjectionMatrix*gl_Vertex; } // gl_Vertex in a comment',
    0x8b31,
  );
  assert.match(shader, /layout\(location=0\) in vec4 _wbVertex/);
  assert.match(shader, /uniform mat4 _wbMVP/);
  assert.match(shader, /invariant gl_Position/);
  assert.match(shader, /gl_Position=_wbMVP\*_wbVertex/);
  assert.match(shader, /\/\/ gl_Vertex in a comment/);
});
test('opaque Windows presentation flips rows and preserves actual RGB and guest destination alpha', () => {
  const input = new Uint8Array([200, 100, 50, 0, 10, 20, 30, 128, 70, 80, 90, 255, 1, 2, 3, 4]);
  const before = input.slice();
  assert.deepEqual(
    [...opaqueGLPixels(input, 2, 2)],
    [70, 80, 90, 255, 1, 2, 3, 255, 200, 100, 50, 255, 10, 20, 30, 255],
  );
  assert.deepEqual(input, before);
});

test('legacy BGR texture rows preserve padding boundaries and unpack state', () => {
  const r = runtime(),
    c = context(r),
    uploads = [],
    stores = [];
  Object.assign(c.gl, {
    RGBA: 0x1908,
    RGB: 0x1907,
    RGBA8: 0x8058,
    UNSIGNED_BYTE: 0x1401,
    UNPACK_ALIGNMENT: 0xcf5,
    getParameter: () => 4,
    pixelStorei: (...a) => stores.push(a),
    texImage2D: (...a) => uploads.push(a),
  });
  const input = [
    30, 20, 10, 60, 50, 40, 90, 80, 70, 0xaa, 0xaa, 0xaa, 120, 110, 100, 150, 140, 130, 180, 170,
    160,
  ];
  const p = r.data.length - input.length;
  r.data.set(input, p);
  call(r, 'glTexImage2D', 0xde1, 0, 3, 3, 2, 0, 0x80e0, 0x1401, p);
  assert.deepEqual(
    [...uploads[0][8]],
    [
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255, 130, 140, 150, 255,
      160, 170, 180, 255,
    ],
  );
  assert.deepEqual(stores, [
    [0xcf5, 1],
    [0xcf5, 4],
  ]);
  call(r, 'glTexImage2D', 0xde1, 0, 0x804b, 1, 1, 0, 0x1909, 0x1401, p);
  assert.deepEqual(
    [...uploads[1][8]],
    [30, 30, 30, 30],
    'GL_INTENSITY carries the luminance into alpha',
  );
});
test('S3TC uploads decode the original block and validate size before submitting', () => {
  const r = runtime(),
    c = context(r),
    uploads = [];
  Object.assign(c.gl, {
    RGBA: 0x1908,
    RGBA8: 0x8058,
    UNSIGNED_BYTE: 0x1401,
    UNPACK_ALIGNMENT: 0xcf5,
    getParameter: () => 4,
    pixelStorei: () => {},
    texImage2D: (...a) => uploads.push(a),
  });
  r.data.set([0, 0xf8, 0x1f, 0, 0, 0, 0, 0], 300);
  call(r, 'glCompressedTexImage2DARB', 0xde1, 0, 0x83f0, 4, 4, 0, 8, 300);
  assert.deepEqual([...uploads[0][8]], Array.from({ length: 16 }, () => [255, 0, 0, 255]).flat());
  assert.throws(
    () => call(r, 'glCompressedTexImage2DARB', 0xde1, 0, 0x83f0, 4, 4, 0, 7, 300),
    /size mismatch/,
  );
  assert.equal(uploads.length, 1);
});
test('client-memory quads submit the correct triangles and reject out-of-bounds vertices before drawing', () => {
  const r = runtime(),
    c = context(r),
    draws = [];
  Object.assign(c.gl, {
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    ARRAY_BUFFER_BINDING: 0x8894,
    ELEMENT_ARRAY_BUFFER_BINDING: 0x8895,
    FLOAT: 0x1406,
    UNSIGNED_INT: 0x1405,
    TRIANGLES: 4,
    STREAM_DRAW: 0x88e0,
    getParameter: () => null,
    getUniformLocation: () => null,
    useProgram: () => {},
    createBuffer: () => ({}),
    bindBuffer: () => {},
    enableVertexAttribArray: () => {},
    disableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttrib4fv: () => {},
    drawElements: (...a) => draws.push(a),
  });
  c.program = r.opengl.name(c, 'program', {});
  call(r, 'glVertexPointer', 3, 0x1406, 0, r.data.length - 48);
  call(r, 'glEnableClientState', 0x8074);
  call(r, 'glDrawArrays', 7, 0, 4);
  assert.deepEqual(draws, [[4, 6, 0x1405, 0]]);
  assert.deepEqual([...r.calls.find((a) => a[0] === 0x8893)[1]], [0, 1, 2, 0, 2, 3]);
  call(r, 'glVertexPointer', 3, 0x1406, 0, r.data.length - 4);
  assert.throws(() => call(r, 'glDrawArrays', 7, 0, 4), /outside memory/);
  assert.equal(draws.length, 1);
});
