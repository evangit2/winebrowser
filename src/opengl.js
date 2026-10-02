import { describeDisplayDC } from './win32-gdi.js';

const states = new WeakMap();
const ok = (result = 0, argc = 0) => ({ result: result >>> 0, argc });
const MAX_BYTES = 16 * 1024 * 1024;
const GL_EXTENSIONS = [
  'GL_ARB_shader_objects',
  'GL_ARB_vertex_shader',
  'GL_ARB_fragment_shader',
  'GL_ARB_shading_language_100',
  'GL_ARB_vertex_buffer_object',
  'GL_ARB_vertex_array_object',
];
const state = (r) => {
  let s = states.get(r);
  if (!s) states.set(r, (s = { formats: new Map(), current: new Map(), strings: new Map() }));
  return s;
};
const thread = (r) => r.threads?.current?.id ?? 0;
const backend = (r) => {
  if (!r.opengl?.contexts) throw Error('OpenGL browser backend is unavailable');
  return r.opengl;
};
const current = (r) => {
  const c = backend(r).contexts.get(state(r).current.get(thread(r))?.id);
  if (!c) throw Error('OpenGL call without a current WGL context');
  if (c.failure || c.gl.isContextLost()) throw Error(c.failure ?? 'OpenGL context lost');
  return c;
};
const floatBits = new DataView(new ArrayBuffer(4));
const f32 = (bits) => {
  floatBits.setUint32(0, bits, true);
  return floatBits.getFloat32(0, true);
};
const bytes = (r, pointer, size, write = false) => {
  if (!Number.isInteger(size) || size < 0 || size > MAX_BYTES) throw Error('OpenGL transfer limit');
  r.check(pointer, size, write);
  return r.data.subarray(pointer, pointer + size);
};
const stringPointer = (r, value) => {
  const s = state(r);
  if (s.strings.has(value)) return s.strings.get(value);
  if (s.strings.size >= 256) throw Error('OpenGL string limit');
  const data = new TextEncoder().encode(value + '\0');
  const p = r.allocate(data.length);
  r.data.set(data, p);
  s.strings.set(value, p);
  return p;
};
const writeText = (r, value, size, out, written) => {
  if (size < 0 || size > MAX_BYTES) throw Error('OpenGL text buffer limit');
  const text = new TextEncoder().encode(value).subarray(0, Math.max(0, size - 1));
  if (size) {
    bytes(r, out, size, true).set(text);
    r.data[out + text.length] = 0;
  }
  if (written) r.write32(written, text.length);
};
const fail = (r, code, argc) => {
  r.lastError = code;
  return ok(0, argc);
};
const descriptor = () => {
  const b = new Uint8Array(40),
    v = new DataView(b.buffer);
  v.setUint16(0, 40, true);
  v.setUint16(2, 1, true);
  v.setUint32(4, 0x25, true); // DRAW_TO_WINDOW | SUPPORT_OPENGL | DOUBLEBUFFER
  b[9] = 32;
  b[10] = b[12] = b[14] = b[16] = 8;
  b[11] = 16;
  b[13] = 8;
  b[17] = 24;
  b[23] = 24;
  b[24] = 8;
  return b;
};
const validPFD = (r, p) => {
  bytes(r, p, 40);
  return (
    r.view.getUint16(p, true) === 40 &&
    r.view.getUint16(p + 2, true) === 1 &&
    (r.read32(p + 4) & 0x24) === 0x24 &&
    r.data[p + 8] === 0 &&
    r.data[p + 26] === 0
  );
};

export const openglApis = {
  'gdi32.dll!ChoosePixelFormat': (r, a) =>
    describeDisplayDC(r, a(0)) && validPFD(r, a(1)) ? ok(1, 2) : fail(r, 87, 2),
  'gdi32.dll!DescribePixelFormat': (r, a) => {
    if (!describeDisplayDC(r, a(0)) || a(1) !== 1) return fail(r, 87, 4);
    if (a(3)) {
      if (a(2) < 40) return fail(r, 87, 4);
      bytes(r, a(3), 40, true).set(descriptor());
    }
    return ok(1, 4);
  },
  'gdi32.dll!SetPixelFormat': (r, a) => {
    const d = describeDisplayDC(r, a(0));
    if (!d || a(1) !== 1 || (a(2) && !validPFD(r, a(2))) || state(r).formats.has(d.windowId))
      return fail(r, 87, 3);
    state(r).formats.set(d.windowId, 1);
    return ok(1, 3);
  },
  'gdi32.dll!GetPixelFormat': (r, a) =>
    ok(state(r).formats.get(describeDisplayDC(r, a(0))?.windowId) ?? 0, 1),
  'gdi32.dll!SwapBuffers': async (r, a) => {
    const d = describeDisplayDC(r, a(0));
    if (!d) return fail(r, 6, 1);
    const c = current(r);
    if (c.windowId !== d.windowId) return fail(r, 6, 1);
    await backend(r).present(c, d);
    return ok(1, 1);
  },
  'opengl32.dll!wglCreateContext': (r, a) => {
    const d = describeDisplayDC(r, a(0));
    if (!d || !state(r).formats.has(d.windowId)) return fail(r, 2000, 1);
    return ok(backend(r).create(d), 1);
  },
  'opengl32.dll!wglCreateContextAttribsARB': (r, a) => {
    const d = describeDisplayDC(r, a(0));
    if (!d || !state(r).formats.has(d.windowId) || a(1)) return fail(r, 87, 3);
    const attributes = new Map();
    if (a(2)) {
      let end = false;
      for (let i = 0; i < 64; i++) {
        const key = r.read32(a(2) + i * 8);
        if (!key) {
          end = true;
          break;
        }
        if (![0x2091, 0x2092, 0x2094, 0x9126].includes(key)) return fail(r, 87, 3);
        attributes.set(key, r.read32(a(2) + i * 8 + 4));
      }
      if (!end) return fail(r, 87, 3);
    }
    const major = attributes.get(0x2091) ?? 1,
      minor = attributes.get(0x2092) ?? 0;
    if (
      major < 1 ||
      major > 3 ||
      minor > 3 ||
      (attributes.get(0x2094) ?? 0) & ~3 ||
      ![1, 2].includes(attributes.get(0x9126) ?? 1)
    )
      return fail(r, 0x2095, 3);
    return ok(backend(r).create(d), 3);
  },
  'opengl32.dll!wglMakeCurrent': (r, a) => {
    const s = state(r),
      owner = thread(r);
    if (!a(0) && !a(1)) {
      s.current.delete(owner);
      return ok(1, 2);
    }
    const d = describeDisplayDC(r, a(0)),
      c = backend(r).contexts.get(a(1));
    if (
      !d ||
      !c ||
      c.windowId !== d.windowId ||
      [...s.current].some(([id, value]) => id !== owner && value.id === c.id)
    )
      return fail(r, 6, 2);
    s.current.set(owner, { id: c.id, dc: a(0) });
    return ok(1, 2);
  },
  'opengl32.dll!wglDeleteContext': (r, a) => {
    const s = state(r),
      owner = thread(r);
    if ([...s.current].some(([id, v]) => id !== owner && v.id === a(0))) return fail(r, 170, 1);
    if (s.current.get(owner)?.id === a(0)) s.current.delete(owner);
    return backend(r).destroy(a(0)) ? ok(1, 1) : fail(r, 6, 1);
  },
  'opengl32.dll!wglGetCurrentContext': (r) => ok(state(r).current.get(thread(r))?.id ?? 0),
  'opengl32.dll!wglGetCurrentDC': (r) => ok(state(r).current.get(thread(r))?.dc ?? 0),
  'opengl32.dll!wglGetProcAddress': (r, a) => {
    const name = r.string(a(0));
    if (!state(r).current.has(thread(r)) || !openglApis['opengl32.dll!' + name]) return ok(0, 1);
    const module = r.graph.load('opengl32.dll');
    return ok(r.graph.hostThunk({ module, symbol: name }), 1);
  },
  'opengl32.dll!wglSwapIntervalEXT': (r, a) => {
    if (a(0) > 1) return fail(r, 87, 1);
    current(r).interval = a(0);
    return ok(1, 1);
  },
  'opengl32.dll!wglGetSwapIntervalEXT': (r) => ok(current(r).interval ?? 1),
  'opengl32.dll!wglGetExtensionsStringARB': (r, a) =>
    ok(
      describeDisplayDC(r, a(0))
        ? stringPointer(
            r,
            'WGL_ARB_create_context WGL_ARB_create_context_profile WGL_EXT_swap_control',
          )
        : 0,
      1,
    ),
  'opengl32.dll!glGetString': (r, a) => {
    if (!state(r).current.has(thread(r))) return ok(0, 1);
    current(r);
    const value = {
      0x1f00: 'WineBrowser',
      0x1f01: 'WineBrowser WebGL2 desktop OpenGL subset',
      0x1f02: '3.3 WineBrowser (bounded WebGL2 bridge)',
      0x8b8c: '3.30 WineBrowser GLSL ES bridge',
      0x1f03: GL_EXTENSIONS.join(' '),
    }[a(0)];
    if (value === undefined) {
      current(r).error = 0x500;
      return ok(0, 1);
    }
    return ok(stringPointer(r, value), 1);
  },
  'opengl32.dll!glGetError': (r) => {
    if (!state(r).current.has(thread(r))) return ok(0);
    const c = current(r),
      error = c.error ?? c.gl.getError();
    delete c.error;
    return ok(error);
  },
};

const glAPI = (name, argc, run) => {
  openglApis['opengl32.dll!' + name] = (r, a) => {
    // Windows' null-context GL dispatch ignores these calls. WM_SIZE commonly
    // calls glViewport while CreateWindowEx is still running, before WGL init.
    if (!state(r).current.has(thread(r))) return ok(0, argc);
    const c = current(r);
    return ok(run(c.gl, c, r, a) ?? 0, argc);
  };
};
const direct = (name, count, convert = (a, i) => a(i)) =>
  glAPI('gl' + name[0].toUpperCase() + name.slice(1), count, (gl, c, r, a) => {
    gl[name](...Array.from({ length: count }, (_, i) => convert(a, i)));
  });
for (const [name, count] of [
  ['viewport', 4],
  ['scissor', 4],
  ['clear', 1],
  ['enable', 1],
  ['disable', 1],
  ['depthFunc', 1],
  ['depthMask', 1],
  ['colorMask', 4],
  ['frontFace', 1],
  ['cullFace', 1],
  ['blendFunc', 2],
  ['blendFuncSeparate', 4],
  ['blendEquation', 1],
  ['blendEquationSeparate', 2],
  ['stencilFunc', 3],
  ['stencilOp', 3],
  ['stencilMask', 1],
  ['clearStencil', 1],
  ['pixelStorei', 2],
  ['activeTexture', 1],
  ['texParameteri', 3],
  ['generateMipmap', 1],
  ['flush', 0],
  ['finish', 0],
])
  direct(name, count);
for (const [name, count] of [
  ['clearColor', 4],
  ['blendColor', 4],
  ['polygonOffset', 2],
  ['lineWidth', 1],
])
  direct(name, count, (a, i) => f32(a(i)));

glAPI('glGetIntegerv', 2, (gl, c, r, a) => {
  const value =
    { 0x821b: 3, 0x821c: 3, 0x821d: GL_EXTENSIONS.length }[a(0)] ?? gl.getParameter(a(0));
  const values = ArrayBuffer.isView(value) || Array.isArray(value) ? value : [value];
  if (values.some((v) => typeof v !== 'number' && typeof v !== 'boolean'))
    throw Error('Unsupported OpenGL object-valued integer query');
  bytes(r, a(1), values.length * 4, true);
  values.forEach((v, i) => r.write32(a(1) + i * 4, Number(v)));
});
glAPI('glGetStringi', 2, (gl, c, r, a) => {
  if (a(0) !== 0x1f03 || a(1) >= GL_EXTENSIONS.length) {
    c.error = a(0) !== 0x1f03 ? 0x500 : 0x501;
    return 0;
  }
  return stringPointer(r, GL_EXTENSIONS[a(1)]);
});
glAPI('glClearDepth', 2, (gl, c, r, a) => {
  const value = new DataView(new ArrayBuffer(8));
  value.setUint32(0, a(0), true);
  value.setUint32(4, a(1), true);
  gl.clearDepth(value.getFloat64(0, true));
});
glAPI('glShadeModel', 1, (gl, c, r, a) => {
  if (![0x1d00, 0x1d01].includes(a(0))) {
    c.error = 0x500;
    return;
  }
  // Interpolation in a programmable pipeline is specified by the shader.
  c.shadeModel = a(0);
});
glAPI('glHint', 2, (gl, c, r, a) => {
  if (![0x1100, 0x1101, 0x1102].includes(a(1))) {
    c.error = 0x500;
    return;
  }
  if (a(0) === 0x0c50) {
    c.perspectiveHint = a(1);
    return;
  }
  gl.hint(a(0), a(1));
});
glAPI('glGetAttachedShaders', 4, (gl, c, r, a) => {
  const attached = gl.getAttachedShaders(backend(r).object(c, a(0), 'program')) ?? [];
  const count = Math.min(a(1), attached.length);
  bytes(r, a(3), count * 4, true);
  for (let i = 0; i < count; i++) {
    const name = [...c.names].find(
      ([, entry]) => entry.kind === 'shader' && entry.object === attached[i],
    )?.[0];
    if (name === undefined) throw Error('Unowned OpenGL attached shader');
    r.write32(a(3) + i * 4, name);
  }
  if (a(2)) r.write32(a(2), count);
});
glAPI('glCreateShader', 1, (gl, c, r, a) => backend(r).name(c, 'shader', gl.createShader(a(0))));
glAPI('glCreateProgram', 0, (gl, c, r) => backend(r).name(c, 'program', gl.createProgram()));
glAPI('glShaderSource', 4, (gl, c, r, a) => {
  backend(r).object(c, a(0), 'shader');
  if (a(1) > 256) throw Error('OpenGL shader string count limit');
  bytes(r, a(2), a(1) * 4);
  if (a(3)) bytes(r, a(3), a(1) * 4);
  let source = '';
  for (let i = 0; i < a(1); i++) {
    const p = r.read32(a(2) + i * 4),
      size = a(3) ? r.read32(a(3) + i * 4) | 0 : -1;
    source += size < 0 ? r.string(p) : new TextDecoder().decode(bytes(r, p, size));
    if (source.length > 1024 * 1024) throw Error('OpenGL shader source limit');
  }
  c.sources.set(a(0), source);
});
glAPI('glCompileShader', 1, (gl, c, r, a) => backend(r).compile(c, a(0)));
for (const name of ['attachShader', 'detachShader'])
  glAPI('gl' + name[0].toUpperCase() + name.slice(1), 2, (gl, c, r, a) =>
    gl[name](backend(r).object(c, a(0), 'program'), backend(r).object(c, a(1), 'shader')),
  );
glAPI('glLinkProgram', 1, (gl, c, r, a) => gl.linkProgram(backend(r).object(c, a(0), 'program')));
glAPI('glUseProgram', 1, (gl, c, r, a) => {
  gl.useProgram(backend(r).object(c, a(0), 'program', true));
  c.program = a(0);
});
glAPI('glBindAttribLocation', 3, (gl, c, r, a) =>
  gl.bindAttribLocation(backend(r).object(c, a(0), 'program'), a(1), r.string(a(2))),
);
glAPI('glGetAttribLocation', 2, (gl, c, r, a) =>
  gl.getAttribLocation(backend(r).object(c, a(0), 'program'), r.string(a(1))),
);
glAPI('glGetUniformLocation', 2, (gl, c, r, a) => {
  const program = backend(r).object(c, a(0), 'program'),
    name = r.string(a(1));
  c.uniforms ??= new Map();
  const key = a(0) + ':' + name;
  if (c.uniforms.has(key)) return c.uniforms.get(key);
  const location = gl.getUniformLocation(program, name);
  if (location === null) return -1;
  const id = backend(r).name(c, 'uniform', location);
  c.names.get(id).program = a(0);
  c.uniforms.set(key, id);
  return id;
});
for (const kind of ['Shader', 'Program']) {
  const method = kind.toLowerCase();
  glAPI('glGet' + kind + 'iv', 3, (gl, c, r, a) => {
    const object = backend(r).object(c, a(0), method);
    const value =
      a(1) === 0x8b84
        ? (gl['get' + kind + 'InfoLog'](object) ?? '').length + 1
        : gl['get' + kind + 'Parameter'](object, a(1));
    r.write32(a(2), Number(value));
  });
  glAPI('glGet' + kind + 'InfoLog', 4, (gl, c, r, a) =>
    writeText(
      r,
      gl['get' + kind + 'InfoLog'](backend(r).object(c, a(0), method)) ?? '',
      a(1) | 0,
      a(3),
      a(2),
    ),
  );
  glAPI('glDelete' + kind, 1, (gl, c, r, a) => {
    if (!a(0)) return;
    gl['delete' + kind](backend(r).object(c, a(0), method));
    c.names.delete(a(0));
    c.sources.delete(a(0));
    if (kind === 'Program') {
      for (const [key, id] of c.uniforms ?? [])
        if (c.names.get(id)?.program === a(0)) {
          c.uniforms.delete(key);
          c.names.delete(id);
        }
    }
  });
}
const uniform = (gl, c, r, location) => {
  if (location === 0xffffffff) return null;
  const entry = c.names.get(location);
  if (!entry || entry.kind !== 'uniform' || entry.program !== c.program)
    throw Error('OpenGL uniform does not belong to the current program');
  return entry.object;
};
for (let width = 1; width <= 4; width++) {
  for (const type of ['f', 'i']) {
    glAPI('glUniform' + width + type, width + 1, (gl, c, r, a) => {
      const location = uniform(gl, c, r, a(0));
      if (location === null) return;
      gl['uniform' + width + type](
        location,
        ...Array.from({ length: width }, (_, i) => (type === 'f' ? f32(a(i + 1)) : a(i + 1) | 0)),
      );
    });
    glAPI('glUniform' + width + type + 'v', 3, (gl, c, r, a) => {
      const location = uniform(gl, c, r, a(0));
      if (location === null) return;
      const data = bytes(r, a(2), a(1) * width * 4).slice();
      gl['uniform' + width + type + 'v'](
        location,
        type === 'f' ? new Float32Array(data.buffer) : new Int32Array(data.buffer),
      );
    });
  }
}
for (const width of [2, 3, 4]) {
  glAPI('glUniformMatrix' + width + 'fv', 4, (gl, c, r, a) => {
    const location = uniform(gl, c, r, a(0));
    if (location === null) return;
    if (a(2)) throw Error('Transposed OpenGL uniform matrices are unsupported');
    const data = bytes(r, a(3), a(1) * width * width * 4).slice();
    gl['uniformMatrix' + width + 'fv'](location, false, new Float32Array(data.buffer));
  });
}
for (const [plural, kind, create, destroy, bind] of [
  ['Buffers', 'buffer', 'createBuffer', 'deleteBuffer', 'bindBuffer'],
  ['VertexArrays', 'vertexArray', 'createVertexArray', 'deleteVertexArray', 'bindVertexArray'],
  ['Textures', 'texture', 'createTexture', 'deleteTexture', 'bindTexture'],
  ['Framebuffers', 'framebuffer', 'createFramebuffer', 'deleteFramebuffer', 'bindFramebuffer'],
  ['Renderbuffers', 'renderbuffer', 'createRenderbuffer', 'deleteRenderbuffer', 'bindRenderbuffer'],
]) {
  glAPI('glGen' + plural, 2, (gl, c, r, a) => {
    if (a(0) > 4096) throw Error('OpenGL object count limit');
    bytes(r, a(1), a(0) * 4, true);
    for (let i = 0; i < a(0); i++) r.write32(a(1) + i * 4, backend(r).name(c, kind, gl[create]()));
  });
  glAPI('glDelete' + plural, 2, (gl, c, r, a) => {
    if (a(0) > 4096) throw Error('OpenGL object count limit');
    bytes(r, a(1), a(0) * 4);
    for (let i = 0; i < a(0); i++) {
      const name = r.read32(a(1) + i * 4);
      if (!name || !c.names.has(name)) continue;
      gl[destroy](backend(r).object(c, name, kind));
      c.names.delete(name);
    }
  });
  glAPI(
    'gl' + bind[0].toUpperCase() + bind.slice(1),
    kind === 'vertexArray' ? 1 : 2,
    (gl, c, r, a) => {
      const index = kind === 'vertexArray' ? 0 : 1;
      const object = backend(r).object(c, a(index), kind, true);
      if (index) gl[bind](a(0), object);
      else gl[bind](object);
    },
  );
}
glAPI('glBufferData', 4, (gl, c, r, a) => {
  const size = a(1);
  if (size > MAX_BYTES) throw Error('OpenGL buffer size limit');
  gl.bufferData(a(0), a(2) ? bytes(r, a(2), size).slice() : size, a(3));
});
glAPI('glBufferSubData', 4, (gl, c, r, a) =>
  gl.bufferSubData(a(0), a(1), bytes(r, a(3), a(2)).slice()),
);
direct('enableVertexAttribArray', 1);
direct('disableVertexAttribArray', 1);
glAPI('glVertexAttribPointer', 6, (gl, c, r, a) =>
  gl.vertexAttribPointer(a(0), a(1), a(2), !!a(3), a(4), a(5)),
);
glAPI('glVertexAttribDivisor', 2, (gl, c, r, a) => gl.vertexAttribDivisor(a(0), a(1)));
for (const [name, count] of [
  ['drawArrays', 3],
  ['drawElements', 4],
  ['drawArraysInstanced', 4],
  ['drawElementsInstanced', 5],
]) {
  glAPI('gl' + name[0].toUpperCase() + name.slice(1), count, (gl, c, r, a) => {
    if (a(name.includes('Elements') ? 1 : 2) > 1024 * 1024) throw Error('OpenGL draw count limit');
    gl[name](...Array.from({ length: count }, (_, i) => a(i)));
    backend(r).draws++;
  });
}
