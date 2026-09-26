import { createBlob } from './com-blob.js';
import { resolveGuestPath } from './guest-paths.js';
import { ShaderCompiler } from './shader-compiler.js';

const INVALID = 0x80070057,
  FAIL = 0x80004005,
  NOT_IMPLEMENTED = 0x80004001;
const MAX_BYTES = 1024 * 1024;

async function compile(runtime, argument, fromFile) {
  const a = (i) => argument(i) >>> 0;
  const shift = fromFile ? 0 : 2;
  const argc = fromFile ? 9 : 11;
  const output = a(7 + shift),
    errors = a(8 + shift);
  const result = (value) => ({ result: value, argc });
  if (!output || output === errors) return result(INVALID);
  // Validate both outputs before changing either; optional errors are independent.
  try {
    runtime.check(output, 4, true);
    if (errors) runtime.check(errors, 4, true);
  } catch {
    return result(INVALID);
  }
  runtime.write32(output, 0);
  if (errors) runtime.write32(errors, 0);
  const fail = (code, message) => {
    if (errors)
      runtime.write32(
        errors,
        createBlob(runtime, new TextEncoder().encode(message.slice(0, 8192) + '\0')).pointer,
      );
    return result(code);
  };
  if (a(1 + shift) || a(2 + shift) || a(5 + shift))
    return fail(
      NOT_IMPLEMENTED,
      'HLSL macros, include handlers and nonzero compiler flags are not implemented',
    );
  // Flags2 describes effects and is ignored for the supported vertex/pixel profiles.
  let source, sourceName, entry, profile;
  try {
    entry = runtime.string(a(3 + shift));
    profile = runtime.string(a(4 + shift));
    if (!a(3 + shift) || !a(4 + shift) || !entry || entry.length > 256)
      return fail(INVALID, 'Invalid HLSL entry point or profile');
    if (!['vs_5_0', 'ps_5_0'].includes(profile))
      return fail(NOT_IMPLEMENTED, 'Only HLSL vs_5_0 and ps_5_0 profiles are implemented');
    if (fromFile) {
      sourceName = runtime.wideString(a(0));
      const path = resolveGuestPath(sourceName, runtime.cwd);
      source = runtime.files.get(path);
      if (!source) return fail(0x80070002, 'HLSL source file not found: ' + sourceName);
    } else {
      if (!a(0) || !a(1) || a(1) > MAX_BYTES) return fail(INVALID, 'Invalid HLSL source size');
      runtime.check(a(0), a(1));
      source = runtime.data.subarray(a(0), a(0) + a(1));
      sourceName = a(2) ? runtime.string(a(2)) : 'shader.hlsl';
    }
    if (!source.length || source.length > MAX_BYTES || sourceName.length > 4096)
      return fail(INVALID, 'Invalid HLSL source size or name');
    source = source.slice();
  } catch (error) {
    return fail(INVALID, error.message);
  }
  const compiler = (runtime.shaderCompiler ??=
    runtime.graphics12?.compiler ?? new ShaderCompiler());
  let compiled;
  try {
    compiled = await compiler.compileHLSL(source, entry, profile, sourceName);
  } catch (error) {
    return fail(FAIL, error.message);
  }
  const code = createBlob(runtime, compiled.bytes);
  try {
    if (errors && compiled.messages)
      runtime.write32(
        errors,
        createBlob(runtime, new TextEncoder().encode(compiled.messages.slice(0, 8192) + '\0'))
          .pointer,
      );
    runtime.write32(output, code.pointer);
  } catch (error) {
    code.refs = 0;
    await code.onRelease();
    throw error;
  }
  return result(0);
}

export const d3dCompilerApis = {
  'd3dcompiler_47.dll!D3DCompile': (r, a) => compile(r, a, false),
  'd3dcompiler_47.dll!D3DCompileFromFile': (r, a) => compile(r, a, true),
};
