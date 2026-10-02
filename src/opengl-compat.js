import { decodeCompressed } from './d3d-compressed.js';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
export function multiplyGLMatrices(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      for (let k = 0; k < 4; k++) out[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
  return out;
}
const legacy = (c) =>
  (c.legacy ??= {
    matrices: new Map([
      [0x1700, identity()],
      [0x1701, identity()],
      [0x1702, identity()],
    ]),
    mode: 0x1700,
    arrays: new Map(),
    enabled: new Set(),
    color: [1, 1, 1, 1],
    texcoord: [0, 0, 0, 1],
    textures: new Set(),
    textureUnit: 0,
    clientUnit: 0,
    texenv: 0x2100,
  });
const componentBytes = (type) =>
  ({ 0x1400: 1, 0x1401: 1, 0x1402: 2, 0x1403: 2, 0x1404: 4, 0x1405: 4, 0x1406: 4, 0x140a: 8 })[
    type
  ];
export function installGLCompatibility(
  apis,
  { glAPI, backend, bytes, f32, ok, fail, current, state, thread, writeText },
) {
  const wrap = (name, fn) => {
    const original = apis['opengl32.dll!' + name];
    apis['opengl32.dll!' + name] = (r, a) => fn(original, r, a);
  };
  apis['opengl32.dll!wglShareLists'] = (r, a) => {
    if (!backend(r).contexts.has(a(0)) || !backend(r).contexts.has(a(1))) return fail(r, 6, 2);
    return fail(r, 50, 2); // WebGL objects cannot be shared across independent contexts.
  };
  const doubles = (a) => {
    const view = new DataView(new ArrayBuffer(8));
    return (i) => {
      view.setUint32(0, a(i * 2), true);
      view.setUint32(4, a(i * 2 + 1), true);
      return view.getFloat64(0, true);
    };
  };
  glAPI('glMatrixMode', 1, (gl, c, r, a) => {
    if (!legacy(c).matrices.has(a(0))) {
      c.error = 0x500;
      return;
    }
    legacy(c).mode = a(0);
  });
  glAPI('glLoadIdentity', 0, (gl, c) => legacy(c).matrices.set(legacy(c).mode, identity()));
  glAPI('glLoadMatrixf', 1, (gl, c, r, a) =>
    legacy(c).matrices.set(legacy(c).mode, new Float32Array(bytes(r, a(0), 64).slice().buffer)),
  );
  glAPI('glMultMatrixf', 1, (gl, c, r, a) =>
    legacy(c).matrices.set(
      legacy(c).mode,
      multiplyGLMatrices(
        legacy(c).matrices.get(legacy(c).mode),
        new Float32Array(bytes(r, a(0), 64).slice().buffer),
      ),
    ),
  );
  glAPI('glOrtho', 12, (gl, c, r, a) => {
    const d = doubles(a),
      l = d(0),
      rr = d(1),
      b = d(2),
      t = d(3),
      n = d(4),
      f = d(5);
    if (l === rr || b === t || n === f) {
      c.error = 0x501;
      return;
    }
    const m = identity();
    m[0] = 2 / (rr - l);
    m[5] = 2 / (t - b);
    m[10] = -2 / (f - n);
    m[12] = -(rr + l) / (rr - l);
    m[13] = -(t + b) / (t - b);
    m[14] = -(f + n) / (f - n);
    legacy(c).matrices.set(
      legacy(c).mode,
      multiplyGLMatrices(legacy(c).matrices.get(legacy(c).mode), m),
    );
  });
  for (const name of ['glEnable', 'glDisable'])
    wrap(name, (original, r, a) => {
      if (state(r).current.has(thread(r)) && [0xde0, 0xde1].includes(a(0))) {
        const l = legacy(current(r));
        if (name === 'glEnable') l.textures.add(l.textureUnit);
        else l.textures.delete(l.textureUnit);
        return ok(0, 1);
      }
      return original(r, a);
    });
  wrap('glActiveTexture', (original, r, a) => {
    const result = original(r, a);
    if (state(r).current.has(thread(r))) legacy(current(r)).textureUnit = a(0) - 0x84c0;
    return result;
  });
  glAPI('glClientActiveTextureARB', 1, (gl, c, r, a) => {
    if (a(0) !== 0x84c0)
      throw Error('Only compatibility texture-coordinate array zero is supported');
    legacy(c).clientUnit = 0;
  });
  const env = (c, unit = legacy(c).textureUnit) => {
    const l = legacy(c);
    l.envs ??= new Map();
    if (!l.envs.has(unit))
      l.envs.set(unit, {
        mode: 0x2100,
        rgb: 0x2100,
        alpha: 0x2100,
        rgbScale: 1,
        alphaScale: 1,
        lod: 0,
        color: [0, 0, 0, 0],
        rgbSource: [0x1702, 0x8578, 0x8576],
        alphaSource: [0x1702, 0x8578, 0x8576],
        rgbOperand: [0x300, 0x300, 0x302],
        alphaOperand: [0x302, 0x302, 0x302],
      });
    return l.envs.get(unit);
  };
  for (const name of ['glTexEnvi', 'glTexEnvf'])
    glAPI(name, 3, (gl, c, r, a) => {
      const v = name === 'glTexEnvf' ? f32(a(2)) : a(2),
        e = env(c),
        p = a(1);
      if (a(0) === 0x8500 && p === 0x8501) {
        e.lod = v;
        return;
      }
      if (a(0) !== 0x2300) throw Error('Unsupported texture environment target');
      if (p === 0x2200 && [0x2100, 0x1e01, 0x104, 0x8570].includes(v)) {
        e.mode = v;
        return;
      }
      if (
        [0x8571, 0x8572].includes(p) &&
        [0x1e01, 0x2100, 0x104, 0x8574, 0x8575, 0x84e7, 0x86ae, 0x86af].includes(v)
      ) {
        e[p === 0x8571 ? 'rgb' : 'alpha'] = v;
        return;
      }
      if ([0x8573, 0x0d1c].includes(p) && [1, 2, 4].includes(v)) {
        e[p === 0x8573 ? 'rgbScale' : 'alphaScale'] = v;
        return;
      }
      for (const [base, key] of [
        [0x8580, 'rgbSource'],
        [0x8588, 'alphaSource'],
        [0x8590, 'rgbOperand'],
        [0x8598, 'alphaOperand'],
      ])
        if (p >= base && p < base + 3) {
          const allowed = key.endsWith('Source')
            ? [0x1702, 0x8576, 0x8577, 0x8578]
            : [0x300, 0x301, 0x302, 0x303];
          if (!allowed.includes(v)) throw Error('Unsupported texture combiner operand');
          e[key][p - base] = v;
          return;
        }
      throw Error(
        'Unsupported texture environment ' +
          [a(0), p, v].map((v) => '0x' + v.toString(16)).join('/'),
      );
    });
  const arrayIndex = (cap) => ({ 0x8074: 0, 0x8075: 9, 0x8076: 10, 0x8078: 8 })[cap];
  for (const [name, enabled] of [
    ['glEnableClientState', true],
    ['glDisableClientState', false],
  ])
    glAPI(name, 1, (gl, c, r, a) => {
      const index = arrayIndex(a(0));
      if (index === undefined) {
        c.error = 0x500;
        return;
      }
      if (enabled) legacy(c).enabled.add(index);
      else legacy(c).enabled.delete(index);
      gl[enabled ? 'enableVertexAttribArray' : 'disableVertexAttribArray'](index);
    });
  for (const [name, index, argc] of [
    ['glVertexPointer', 0, 4],
    ['glNormalPointer', 9, 3],
    ['glColorPointer', 10, 4],
    ['glTexCoordPointer', 8, 4],
  ])
    glAPI(name, argc, (gl, c, r, a) => {
      const size = name === 'glNormalPointer' ? 3 : a(0),
        offset = name === 'glNormalPointer' ? -1 : 0;
      const type = a(offset + 1),
        stride = a(offset + 2),
        pointer = a(offset + 3);
      if (!componentBytes(type) || size < 1 || size > 4 || stride > 2048)
        throw Error('Unsupported compatibility array format');
      legacy(c).arrays.set(index, {
        size,
        type,
        stride,
        pointer,
        normalized: index === 10,
        buffer: gl.getParameter(gl.ARRAY_BUFFER_BINDING),
      });
    });
  for (const [name, enabled] of [
    ['glEnableVertexAttribArray', true],
    ['glDisableVertexAttribArray', false],
  ])
    wrap(name, (original, r, a) => {
      const result = original(r, a);
      if (state(r).current.has(thread(r))) {
        const l = legacy(current(r));
        if (enabled) l.enabled.add(a(0));
        else l.enabled.delete(a(0));
      }
      return result;
    });
  wrap('glVertexAttribPointer', (original, r, a) => {
    if (!state(r).current.has(thread(r))) return original(r, a);
    const c = current(r),
      l = legacy(c);
    if (!c.gl.getParameter(c.gl.ARRAY_BUFFER_BINDING)) {
      l.arrays.set(a(0), {
        size: a(1),
        type: a(2),
        normalized: !!a(3),
        stride: a(4),
        pointer: a(5),
        buffer: null,
      });
      return ok(0, 6);
    }
    l.arrays.delete(a(0));
    return original(r, a);
  });
  const setColor = (l, v) => {
    l.color = v;
  };
  glAPI('glColor3f', 3, (gl, c, r, a) => setColor(legacy(c), [f32(a(0)), f32(a(1)), f32(a(2)), 1]));
  glAPI('glColor4f', 4, (gl, c, r, a) =>
    setColor(
      legacy(c),
      [0, 1, 2, 3].map((i) => f32(a(i))),
    ),
  );
  glAPI('glTexCoord2f', 2, (gl, c, r, a) => {
    legacy(c).texcoord = [f32(a(0)), f32(a(1)), 0, 1];
  });
  glAPI('glBegin', 1, (gl, c, r, a) => {
    const l = legacy(c);
    if (l.immediate) throw Error('Nested glBegin');
    if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9].includes(a(0)))
      throw Error('Unsupported immediate primitive');
    l.immediate = { mode: a(0), vertices: [] };
  });
  const vertex = (c, value) => {
    const l = legacy(c);
    if (!l.immediate) throw Error('glVertex outside glBegin');
    if (l.immediate.vertices.length >= 65536) throw Error('Immediate vertex limit');
    l.immediate.vertices.push([...value, ...l.texcoord, ...l.color]);
  };
  glAPI('glVertex2f', 2, (gl, c, r, a) => vertex(c, [f32(a(0)), f32(a(1)), 0, 1]));
  glAPI('glVertex3f', 3, (gl, c, r, a) => vertex(c, [f32(a(0)), f32(a(1)), f32(a(2)), 1]));
  glAPI('glVertex3fv', 1, (gl, c, r, a) =>
    vertex(c, [...new Float32Array(bytes(r, a(0), 12).slice().buffer), 1]),
  );

  const ensureFixed = (c) => {
    const l = legacy(c),
      gl = c.gl;
    if (l.fixed) return l.fixed;
    const program = gl.createProgram();
    for (const [type, source] of [
      [
        gl.VERTEX_SHADER,
        '#version 300 es\nprecision highp float;layout(location=0) in vec4 v;layout(location=8) in vec4 uv;layout(location=10) in vec4 color;uniform mat4 _wbMVP;out vec2 texcoord;out vec4 col;void main(){gl_Position=_wbMVP*v;texcoord=uv.xy;col=color;}',
      ],
      [
        gl.FRAGMENT_SHADER,
        `#version 300 es
precision highp float;
precision highp int;
in vec2 texcoord;in vec4 col;
uniform sampler2D tex;uniform int textured;uniform int envMode;
uniform int rgbMode;uniform int alphaMode;uniform ivec3 rgbSource;uniform ivec3 alphaSource;
uniform ivec3 rgbOperand;uniform ivec3 alphaOperand;uniform float rgbScale;uniform float alphaScale;
uniform float lodBias;uniform vec4 envColor;out vec4 frag;
vec4 source(int s,vec4 t){return s==5890?t:s==34166?envColor:col;}
vec3 rgbArg(int s,int op,vec4 t){vec4 v=source(s,t);return op==768?v.rgb:op==769?vec3(1)-v.rgb:op==770?vec3(v.a):vec3(1.0-v.a);}
float alphaArg(int s,int op,vec4 t){float v=source(s,t).a;return op==771?1.0-v:v;}
vec3 combineRGB(vec3 a,vec3 b,vec3 c){return rgbMode==7681?a:rgbMode==8448?a*b:rgbMode==260?a+b:rgbMode==34164?a+b-0.5:rgbMode==34165?a*c+b*(vec3(1)-c):rgbMode==34023?a-b:vec3(4.0*dot(a-0.5,b-0.5));}
float combineAlpha(float a,float b,float c){return alphaMode==7681?a:alphaMode==8448?a*b:alphaMode==260?a+b:alphaMode==34164?a+b-0.5:alphaMode==34165?a*c+b*(1.0-c):a-b;}
void main(){vec4 t=textured!=0?texture(tex,texcoord,lodBias):vec4(1);if(textured==0){frag=col;return;}if(envMode==7681){frag=t;return;}if(envMode==8448){frag=col*t;return;}if(envMode==260){frag=vec4(col.rgb+t.rgb,col.a*t.a);return;}
vec3 rgb=combineRGB(rgbArg(rgbSource.x,rgbOperand.x,t),rgbArg(rgbSource.y,rgbOperand.y,t),rgbArg(rgbSource.z,rgbOperand.z,t))*rgbScale;
float a=combineAlpha(alphaArg(alphaSource.x,alphaOperand.x,t),alphaArg(alphaSource.y,alphaOperand.y,t),alphaArg(alphaSource.z,alphaOperand.z,t))*alphaScale;
frag=clamp(vec4(rgb,rgbMode==34479?rgb.r:a),0.0,1.0);}`,
      ],
    ]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw Error(gl.getProgramInfoLog(program));
    l.fixed = program;
    return program;
  };
  const prepare = (c, r, count) => {
    const l = legacy(c),
      gl = c.gl,
      program = c.program ? backend(r).object(c, c.program, 'program') : ensureFixed(c);
    gl.useProgram(program);
    if (l.matrices.get(0x1701)[15] === 0)
      c.perspectiveModelView = Array.from(l.matrices.get(0x1700));
    const mvp = gl.getUniformLocation(program, '_wbMVP');
    if (mvp !== null)
      gl.uniformMatrix4fv(
        mvp,
        false,
        multiplyGLMatrices(l.matrices.get(0x1701), l.matrices.get(0x1700)),
      );
    if (!c.program) {
      gl.uniform1i(gl.getUniformLocation(program, 'tex'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'textured'), l.textures.has(0) ? 1 : 0);
      const e = env(c, 0);
      if ([...l.textures].some((unit) => unit !== 0))
        throw Error('Fixed-function multitexture drawing is unsupported');
      for (const [name, value] of [
        ['envMode', e.mode],
        ['rgbMode', e.rgb],
        ['alphaMode', e.alpha],
      ])
        gl.uniform1i(gl.getUniformLocation(program, name), value);
      for (const [name, value] of [
        ['rgbSource', e.rgbSource],
        ['alphaSource', e.alphaSource],
        ['rgbOperand', e.rgbOperand],
        ['alphaOperand', e.alphaOperand],
      ])
        gl.uniform3iv(gl.getUniformLocation(program, name), value);
      for (const [name, value] of [
        ['rgbScale', e.rgbScale],
        ['alphaScale', e.alphaScale],
        ['lodBias', e.lod],
      ])
        gl.uniform1f(gl.getUniformLocation(program, name), value);
      gl.uniform4fv(gl.getUniformLocation(program, 'envColor'), e.color);
    }
    for (const [index, value] of [
      [8, l.texcoord],
      [10, l.color],
    ])
      if (!l.enabled.has(index)) {
        gl.disableVertexAttribArray(index);
        gl.vertexAttrib4fv(index, value);
      }
    const previous = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    l.buffers ??= new Map();
    for (const index of l.enabled) {
      const arr = l.arrays.get(index);
      if (!arr) continue;
      const element = componentBytes(arr.type) * arr.size,
        stride = arr.stride || element;
      if (!element || stride > 2048 || count > 1048576)
        throw Error('Compatibility vertex transfer limit');
      if (arr.buffer) gl.bindBuffer(gl.ARRAY_BUFFER, arr.buffer);
      else {
        if (!l.buffers.has(index)) l.buffers.set(index, gl.createBuffer());
        gl.bindBuffer(gl.ARRAY_BUFFER, l.buffers.get(index));
        gl.bufferData(
          gl.ARRAY_BUFFER,
          bytes(r, arr.pointer, count ? (count - 1) * stride + element : 0).slice(),
          gl.STREAM_DRAW,
        );
      }
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(
        index,
        arr.size,
        arr.type,
        arr.normalized,
        arr.stride,
        arr.buffer ? arr.pointer : 0,
      );
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, previous);
    return () => {
      if (!c.program) gl.useProgram(null);
    };
  };
  const triangulate = (mode, indices) => {
    if (mode === 7) {
      if (indices.length % 4) throw Error('Incomplete quad');
      return indices.flatMap((v, i) =>
        i % 4 === 0 ? [v, indices[i + 1], indices[i + 2], v, indices[i + 2], indices[i + 3]] : [],
      );
    }
    if (mode === 8) {
      const result = [];
      for (let i = 0; i + 3 < indices.length; i += 2)
        result.push(
          indices[i],
          indices[i + 1],
          indices[i + 3],
          indices[i],
          indices[i + 3],
          indices[i + 2],
        );
      return result;
    }
    if (mode === 9) {
      const result = [];
      for (let i = 1; i + 1 < indices.length; i++)
        result.push(indices[0], indices[i], indices[i + 1]);
      return result;
    }
    return indices;
  };
  const indexed = (gl, c, mode, indices) => {
    const old = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING);
    const l = legacy(c);
    l.indexBuffer ??= gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, l.indexBuffer);
    const tris = triangulate(mode, indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(tris), gl.STREAM_DRAW);
    gl.drawElements(mode >= 7 ? gl.TRIANGLES : mode, tris.length, gl.UNSIGNED_INT, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, old);
  };
  wrap('glDrawArrays', (original, r, a) => {
    if (!state(r).current.has(thread(r))) return original(r, a);
    const c = current(r);
    if (!c.legacy && a(0) < 7) return original(r, a);
    if (a(1) + a(2) > 1048576) throw Error('Compatibility draw count limit');
    const restore = prepare(c, r, a(1) + a(2));
    if (a(0) >= 7)
      indexed(
        c.gl,
        c,
        a(0),
        Array.from({ length: a(2) }, (_, i) => a(1) + i),
      );
    else c.gl.drawArrays(a(0), a(1), a(2));
    backend(r).draws++;
    restore();
    return ok(0, 3);
  });
  wrap('glDrawElements', (original, r, a) => {
    if (!state(r).current.has(thread(r))) return original(r, a);
    const c = current(r),
      gl = c.gl;
    if (!c.legacy && a(0) < 7) return original(r, a);
    if (a(1) > 1048576) throw Error('Compatibility draw count limit');
    const buffer = gl.getParameter(gl.ELEMENT_ARRAY_BUFFER_BINDING);
    const size = componentBytes(a(2));
    if (![0x1401, 0x1403, 0x1405].includes(a(2))) throw Error('Unsupported index type');
    const raw = buffer ? new Uint8Array(a(1) * size) : bytes(r, a(3), a(1) * size).slice();
    if (buffer) {
      gl.getBufferSubData(gl.ELEMENT_ARRAY_BUFFER, a(3), raw);
    }
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const indices = Array.from({ length: a(1) }, (_, i) =>
      size === 1
        ? view.getUint8(i)
        : size === 2
          ? view.getUint16(i * 2, true)
          : view.getUint32(i * 4, true),
    );
    const restore = prepare(
      c,
      r,
      indices.length ? indices.reduce((max, value) => Math.max(max, value), 0) + 1 : 0,
    );
    indexed(gl, c, a(0), indices);
    backend(r).draws++;
    restore();
    return ok(0, 4);
  });
  glAPI('glEnd', 0, (gl, c, r) => {
    const l = legacy(c),
      immediate = l.immediate;
    if (!immediate) throw Error('glEnd without glBegin');
    delete l.immediate;
    const old = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    l.immediateBuffer ??= gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, l.immediateBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(immediate.vertices.flat()), gl.STREAM_DRAW);
    const savedArrays = l.arrays,
      savedEnabled = l.enabled;
    l.arrays = new Map([
      [0, { size: 4, type: gl.FLOAT, stride: 48, pointer: 0, buffer: l.immediateBuffer }],
      [8, { size: 4, type: gl.FLOAT, stride: 48, pointer: 16, buffer: l.immediateBuffer }],
      [10, { size: 4, type: gl.FLOAT, stride: 48, pointer: 32, buffer: l.immediateBuffer }],
    ]);
    l.enabled = new Set([0, 8, 10]);
    const restore = prepare(c, r, immediate.vertices.length);
    indexed(
      gl,
      c,
      immediate.mode,
      Array.from({ length: immediate.vertices.length }, (_, i) => i),
    );
    backend(r).draws++;
    restore();
    l.arrays = savedArrays;
    l.enabled = savedEnabled;
    for (const i of [0, 8, 10]) if (!l.enabled.has(i)) gl.disableVertexAttribArray(i);
    gl.bindBuffer(gl.ARRAY_BUFFER, old);
  });
  glAPI('glGetActiveUniform', 7, (gl, c, r, a) => {
    const u = gl.getActiveUniform(backend(r).object(c, a(0), 'program'), a(1));
    if (!u) {
      c.error = 0x501;
      return;
    }
    if (a(4)) r.write32(a(4), u.size);
    if (a(5)) r.write32(a(5), u.type);
    writeText(r, u.name, a(2) | 0, a(6), a(3));
  });
  glAPI('glGetActiveAttrib', 7, (gl, c, r, a) => {
    const u = gl.getActiveAttrib(backend(r).object(c, a(0), 'program'), a(1));
    if (!u) {
      c.error = 0x501;
      return;
    }
    if (a(4)) r.write32(a(4), u.size);
    if (a(5)) r.write32(a(5), u.type);
    writeText(r, u.name, a(2) | 0, a(6), a(3));
  });
  glAPI('glValidateProgram', 1, (gl, c, r, a) =>
    gl.validateProgram(backend(r).object(c, a(0), 'program')),
  );
  glAPI('glGetObjectParameterivARB', 3, (gl, c, r, a) => {
    const entry = c.names.get(a(0));
    if (!entry || !['program', 'shader'].includes(entry.kind)) throw Error('Invalid ARB object');
    let value;
    const object = entry.object;
    if (a(1) === 0x8b4e) value = entry.kind === 'program' ? 0x8b40 : 0x8b48;
    else if (a(1) === 0x8b84)
      value =
        (gl[entry.kind === 'program' ? 'getProgramInfoLog' : 'getShaderInfoLog'](object) || '')
          .length + 1;
    else if (a(1) === 0x8b87 || a(1) === 0x8b8a) {
      const uniform = a(1) === 0x8b87,
        count = gl.getProgramParameter(object, uniform ? gl.ACTIVE_UNIFORMS : gl.ACTIVE_ATTRIBUTES);
      value = 0;
      for (let i = 0; i < count; i++)
        value = Math.max(
          value,
          (uniform ? gl.getActiveUniform(object, i) : gl.getActiveAttrib(object, i)).name.length +
            1,
        );
    } else
      value = gl[entry.kind === 'program' ? 'getProgramParameter' : 'getShaderParameter'](
        object,
        a(1),
      );
    r.write32(a(2), Number(value));
  });
  glAPI('glGetInfoLogARB', 4, (gl, c, r, a) => {
    const entry = c.names.get(a(0));
    if (!entry || !['shader', 'program'].includes(entry.kind))
      throw Error('Invalid ARB log object');
    writeText(
      r,
      gl[entry.kind === 'shader' ? 'getShaderInfoLog' : 'getProgramInfoLog'](entry.object) || '',
      a(1) | 0,
      a(3),
      a(2),
    );
  });
  glAPI('glDeleteObjectARB', 1, (gl, c, r, a) => {
    const entry = c.names.get(a(0));
    if (!entry) return;
    apis['opengl32.dll!glDelete' + (entry.kind === 'shader' ? 'Shader' : 'Program')](r, a);
  });
  glAPI('glGetHandleARB', 1, (gl, c, r, a) => {
    if (a(0) !== 0x8b40) {
      c.error = 0x500;
      return 0;
    }
    return c.program || 0;
  });
  const dimensions = (w, h) => {
    if (w > 4096 || h > 4096 || w * h * 4 > 16 * 1024 * 1024)
      throw Error('OpenGL texture transfer limit');
  };
  const upload = (gl, c, r, target, level, internal, w, h, border, format, type, pointer) => {
    dimensions(w, h);
    if (border) throw Error('OpenGL texture borders unsupported');
    if (type !== gl.UNSIGNED_BYTE) throw Error('Unsupported OpenGL texture pixel type');
    const components = {
      [gl.RGBA]: 4,
      [gl.RGB]: 3,
      0x80e1: 4,
      0x80e0: 3,
      0x1909: 1,
      0x1906: 1,
      0x190a: 2,
    }[format];
    if (!components) throw Error('Unsupported OpenGL texture pixel format');
    const row = w * components,
      align = gl.getParameter(gl.UNPACK_ALIGNMENT),
      stride = Math.ceil(row / align) * align;
    const source = pointer ? bytes(r, pointer, h ? stride * (h - 1) + row : 0) : null;
    // Expand legacy luminance/alpha and BGR into RGBA. This also makes unpack
    // padding explicit rather than reading bytes outside the guest allocation.
    const rgba = source ? new Uint8Array(w * h * 4) : null;
    if (source)
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const p = y * stride + x * components,
            q = (y * w + x) * 4;
          if ([0x1909, 0x190a].includes(format)) {
            rgba[q] = rgba[q + 1] = rgba[q + 2] = source[p];
            rgba[q + 3] = format === 0x190a ? source[p + 1] : 255;
          } else if (format === 0x1906) {
            rgba[q] = rgba[q + 1] = rgba[q + 2] = 255;
            rgba[q + 3] = source[p];
          } else {
            rgba[q] = source[p + ([0x80e1, 0x80e0].includes(format) ? 2 : 0)];
            rgba[q + 1] = source[p + 1];
            rgba[q + 2] = source[p + ([0x80e1, 0x80e0].includes(format) ? 0 : 2)];
            rgba[q + 3] = components === 4 ? source[p + 3] : 255;
          }
        }
    if (
      ![
        1, 2, 3, 4, 0x1906, 0x1907, 0x1908, 0x1909, 0x190a, 0x803c, 0x8040, 0x8045, 0x8049, 0x804b,
        0x8051, 0x8058,
      ].includes(internal)
    )
      throw Error('Unsupported OpenGL texture internal format 0x' + internal.toString(16));
    if (rgba && [0x8049, 0x804b].includes(internal))
      for (let i = 0; i < rgba.length; i += 4) rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = rgba[i];
    if (rgba && [3, 0x1907, 0x8051].includes(internal))
      for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(target, level, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, align);
  };
  glAPI('glTexImage2D', 9, (gl, c, r, a) =>
    upload(gl, c, r, ...Array.from({ length: 9 }, (_, i) => a(i))),
  );
  glAPI('glTexImage1D', 8, () => {
    throw Error('1D textures are unsupported by the WebGL2 bridge');
  });
  glAPI('glCompressedTexImage2D', 8, (gl, c, r, a) => {
    const format = {
      0x83f0: 0x31545844,
      0x83f1: 0x31545844,
      0x83f2: 0x33545844,
      0x83f3: 0x35545844,
    }[a(2)];
    if (!format) throw Error('Unsupported compressed OpenGL texture');
    dimensions(a(3), a(4));
    if (a(5)) throw Error('Compressed texture border');
    const required = Math.ceil(a(3) / 4) * Math.ceil(a(4) / 4) * (format === 0x31545844 ? 8 : 16);
    if (a(6) !== required) throw Error('Compressed texture size mismatch');
    const source = bytes(r, a(7), required),
      rgba = new Uint8Array(a(3) * a(4) * 4);
    decodeCompressed(source, 0, format, a(3), a(4), rgba);
    if (a(2) === 0x83f0) for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    const align = gl.getParameter(gl.UNPACK_ALIGNMENT);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(a(0), a(1), gl.RGBA8, a(3), a(4), 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, align);
  });
  glAPI('glReadPixels', 7, (gl, c, r, a) => {
    dimensions(a(2), a(3));
    if (a(4) !== gl.RGBA || a(5) !== gl.UNSIGNED_BYTE)
      throw Error('Unsupported OpenGL readback format');
    const row = a(2) * 4,
      align = gl.getParameter(gl.PACK_ALIGNMENT),
      stride = Math.ceil(row / align) * align,
      data = new Uint8Array(a(2) * a(3) * 4),
      out = bytes(r, a(6), a(3) ? stride * (a(3) - 1) + row : 0, true);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(a(0), a(1), a(2), a(3), gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.PACK_ALIGNMENT, align);
    for (let y = 0; y < a(3); y++) out.set(data.subarray(y * row, (y + 1) * row), y * stride);
  });
  // ARB_shader_objects uses GLuint object handles. Aliases retain the original
  // guest import identity while dispatching the matching WebGL object operation.
  const aliases = {
    glCreateShaderObjectARB: 'glCreateShader',
    glCreateProgramObjectARB: 'glCreateProgram',
    glAttachObjectARB: 'glAttachShader',
    glDetachObjectARB: 'glDetachShader',
    glUseProgramObjectARB: 'glUseProgram',
    glGetAttachedObjectsARB: 'glGetAttachedShaders',
    glBlendColorEXT: 'glBlendColor',
    glBlendEquationEXT: 'glBlendEquation',
    glBlendFuncSeparateEXT: 'glBlendFuncSeparate',
    glPolygonOffsetEXT: 'glPolygonOffset',
  };
  for (const name of [
    'ShaderSource',
    'CompileShader',
    'LinkProgram',
    'ValidateProgram',
    'BindAttribLocation',
    'GetAttribLocation',
    'GetUniformLocation',
    'GetActiveUniform',
    'GetActiveAttrib',
    'GenBuffers',
    'DeleteBuffers',
    'BindBuffer',
    'BufferData',
    'BufferSubData',
    'EnableVertexAttribArray',
    'DisableVertexAttribArray',
    'VertexAttribPointer',
    'ActiveTexture',
    'CompressedTexImage2D',
  ])
    aliases['gl' + name + 'ARB'] = 'gl' + name;
  for (let n = 1; n <= 4; n++)
    for (const suffix of ['f', 'fv', 'i', 'iv'])
      aliases['glUniform' + n + suffix + 'ARB'] = 'glUniform' + n + suffix;
  for (let n = 2; n <= 4; n++)
    aliases['glUniformMatrix' + n + 'fvARB'] = 'glUniformMatrix' + n + 'fv';
  for (const [alias, name] of Object.entries(aliases))
    apis['opengl32.dll!' + alias] = apis['opengl32.dll!' + name];
}
