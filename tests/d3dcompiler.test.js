import test from 'node:test';
import assert from 'node:assert/strict';
import { d3dCompilerApis } from '../src/d3dcompiler.js';
function fixture() {
  const data = new Uint8Array(65536),
    view = new DataView(data.buffer);
  let next = 0x1000;
  const calls = [],
    freed = [];
  const r = {
    data,
    view,
    files: new Map(),
    cwd: 'app/',
    thunks: new Map(),
    check(p, n, w) {
      if (!p || p + n > data.length || p < 0 || n < 1 || (w && p === 0x800)) throw Error('memory');
      return p;
    },
    allocate(n) {
      const p = next;
      next = (next + n + 3) & ~3;
      return p;
    },
    free(p) {
      freed.push(p);
    },
    read32(p) {
      return view.getUint32(this.check(p, 4), true);
    },
    write32(p, v) {
      view.setUint32(this.check(p, 4, true), v >>> 0, true);
    },
    string(p) {
      this.check(p, 1);
      let s = '';
      while (data[p]) s += String.fromCharCode(data[p++]);
      return s;
    },
    wideString(p) {
      this.check(p, 2);
      let s = '';
      while (view.getUint16(p, true)) {
        s += String.fromCharCode(view.getUint16(p, true));
        p += 2;
      }
      return s;
    },
    shaderCompiler: {
      async compileHLSL(...args) {
        calls.push(args);
        return { bytes: Uint8Array.of(68, 88, 66, 67, 1), messages: '' };
      },
    },
  };
  const string = (s, wide = false) => {
    const p = r.allocate((s.length + 1) * (wide ? 2 : 1));
    for (let i = 0; i < s.length; i++)
      wide ? view.setUint16(p + 2 * i, s.charCodeAt(i), true) : (data[p + i] = s.charCodeAt(i));
    return p;
  };
  const api = (name, args) => d3dCompilerApis['d3dcompiler_47.dll!' + name](r, (i) => args[i] ?? 0);
  const method = (p, slot) =>
    r.thunks.get(r.read32(r.read32(p) + 4 * slot)).invoke(r, (i) => (i === 0 ? p : 0));
  return { r, calls, freed, string, api, method };
}
test('D3DCompile snapshots exact source bytes, ignores effect flags, and owns independent blobs', async () => {
  const { r, calls, freed, string, api, method } = fixture();
  const source = string('some source trailing'),
    entry = string('main'),
    profile = string('ps_5_0'),
    out = r.allocate(4);
  let finish;
  r.shaderCompiler.compileHLSL = (...args) => {
    calls.push(args);
    return new Promise((resolve) => (finish = resolve));
  };
  const pending = api('D3DCompile', [source, 11, 0, 0, 0, entry, profile, 0, 99, out, 0]);
  r.data.fill(0, source, source + 11);
  const raw = Uint8Array.of(68, 88, 66, 67, 9);
  finish({ bytes: raw, messages: '' });
  assert.deepEqual(await pending, { result: 0, argc: 11 });
  assert.equal(new TextDecoder().decode(calls[0][0]), 'some source');
  assert.deepEqual(calls[0].slice(1), ['main', 'ps_5_0', 'shader.hlsl']);
  const blob = r.read32(out),
    ptr = (await method(blob, 3)).result;
  raw.fill(0);
  assert.deepEqual([...r.data.slice(ptr, ptr + 5)], [68, 88, 66, 67, 9]);
  assert.equal((await method(blob, 4)).result, 5);
  assert.equal((await method(blob, 1)).result, 2);
  assert.equal((await method(blob, 2)).result, 1);
  assert.equal(freed.length, 0);
  assert.equal((await method(blob, 2)).result, 0);
  assert.deepEqual(freed, [ptr]);
  await assert.rejects(method(blob, 3), /Released COM/);
});
test('D3DCompileFromFile resolves package paths and keeps null-terminated compiler diagnostics', async () => {
  const { r, calls, string, api, method } = fixture();
  r.files.set('app/shaders.hlsl', Uint8Array.of(1, 2, 3));
  const path = string('C:\\winebrowser\\app\\SHADERS.HLSL', true),
    entry = string('VSMain'),
    profile = string('vs_5_0'),
    out = r.allocate(4),
    errors = r.allocate(4);
  const args = [path, 0, 0, entry, profile, 0, 0, out, errors];
  r.write32(errors, 0xdead);
  assert.deepEqual(await api('D3DCompileFromFile', args), { result: 0, argc: 9 });
  assert.equal(r.read32(errors), 0);
  assert.deepEqual([...calls[0][0]], [1, 2, 3]);
  r.shaderCompiler.compileHLSL = async () => {
    throw Error('shader.hlsl:2: syntax error');
  };
  assert.equal((await api('D3DCompileFromFile', args)).result, 0x80004005);
  assert.equal(r.read32(out), 0);
  const error = r.read32(errors),
    p = (await method(error, 3)).result,
    n = (await method(error, 4)).result;
  assert.equal(r.string(p), 'shader.hlsl:2: syntax error');
  assert.equal(r.data[p + n - 1], 0);
  r.files.clear();
  assert.equal((await api('D3DCompileFromFile', args)).result, 0x80070002);
});
test('HLSL API validates outputs atomically and rejects unsupported arguments before compilation', async () => {
  const { r, calls, string, api } = fixture();
  const source = string('a'),
    entry = string('main'),
    profile = string('ps_5_0'),
    out = r.allocate(4),
    errors = r.allocate(4);
  const args = [source, 1, 0, 0, 0, entry, profile, 0, 0, out, errors];
  for (const [p, e] of [
    [0, errors],
    [out, 0x800],
    [65535, errors],
    [out, out],
  ]) {
    r.write32(out, 0x1234);
    r.write32(errors, 0x5678);
    assert.equal((await api('D3DCompile', [...args.slice(0, 9), p, e])).result, 0x80070057);
    assert.equal(r.read32(out), 0x1234);
    assert.equal(r.read32(errors), 0x5678);
  }
  // Macros and include handlers change what the compiler is asked to build, so
  // they are still refused.
  for (const i of [3, 4]) {
    const a = args.slice();
    a[i] = 1;
    assert.equal((await api('D3DCompile', a)).result, 0x80004001);
    assert.equal(r.read32(out), 0);
  }
  // The flags word is a set of packaging, precision, flow-control and
  // optimization hints, and the shared compiler already produces correct code
  // without them. Refusing the word itself refused every shader a game
  // compiles: D3D_SHADER_DEBUG is 0x1 and a framework passes
  // PACK_MATRIX_ROW_MAJOR and PREFER_FLOW_CONTROL as a matter of course.
  for (const flags of [0x1, 0x8, 0x400, 0x1 | 0x8 | 0x400]) {
    const a = args.slice();
    a[7] = flags;
    assert.equal((await api('D3DCompile', a)).result, 0, `flags 0x${flags.toString(16)}`);
    assert.ok(r.read32(out) !== 0, 'an accepted compile hands back a blob');
  }
  assert.equal(calls.length, 4, 'each accepted call reached the compiler');
  // A bit the header does not define is still refused rather than guessed at.
  const unknown = args.slice();
  unknown[7] = 0x80000;
  assert.equal((await api('D3DCompile', unknown)).result, 0x80004001);
  const bad = args.slice();
  bad[1] = 1024 * 1024 + 1;
  assert.equal((await api('D3DCompile', bad)).result, 0x80070057);
  assert.equal(calls.length, 4);
});
