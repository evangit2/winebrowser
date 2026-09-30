import { createBlob } from './com-blob.js';
import { resolveGuestPath } from './guest-paths.js';
import { ShaderCompiler } from './shader-compiler.js';

const INVALID = 0x80070057,
  FAIL = 0x80004005,
  NOT_IMPLEMENTED = 0x80004001;
const MAX_BYTES = 1024 * 1024;

// The three entry points differ only in where their arguments sit: D3DCompile
// takes a source name and a second flags word, D3DCompileFromFile reads the
// source from disk, and D3D10CompileShader has neither the second flags word
// nor the source-name slot (its file name is a plain ANSI string). `indexes`
// names the slot of each argument so one implementation serves all three.
export async function compile(runtime, argument, indexes) {
  const a = (i) => argument(i) >>> 0;
  const { argc, fromFile } = indexes;
  const output = a(indexes.output),
    errors = a(indexes.errors);
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
  // Flags2 describes effects and is ignored for the supported vertex and pixel
  // profiles, so only the first flags word is rejected.
  if (a(indexes.defines) || a(indexes.include) || a(indexes.flags1))
    return fail(
      NOT_IMPLEMENTED,
      'HLSL macros, include handlers and nonzero compiler flags are not implemented',
    );
  let source, sourceName, entry, profile;
  try {
    entry = runtime.string(a(indexes.entry));
    profile = runtime.string(a(indexes.profile));
    if (!a(indexes.entry) || !a(indexes.profile) || !entry || entry.length > 256)
      return fail(INVALID, 'Invalid HLSL entry point or profile');
    if (!indexes.profiles.includes(profile))
      return fail(
        NOT_IMPLEMENTED,
        'Only the HLSL profiles ' + indexes.profiles.join(', ') + ' are implemented',
      );
    if (fromFile) {
      sourceName = runtime.wideString(a(indexes.name));
      const path = resolveGuestPath(sourceName, runtime.cwd);
      source = runtime.files.get(path);
      if (!source) return fail(0x80070002, 'HLSL source file not found: ' + sourceName);
    } else {
      if (!a(indexes.source) || !a(indexes.size) || a(indexes.size) > MAX_BYTES)
        return fail(INVALID, 'Invalid HLSL source size');
      runtime.check(a(indexes.source), a(indexes.size));
      source = runtime.data.subarray(a(indexes.source), a(indexes.source) + a(indexes.size));
      sourceName = a(indexes.name) ? runtime.string(a(indexes.name)) : 'shader.hlsl';
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

const D3DCOMPILE_LAYOUT = {
  argc: 11,
  fromFile: false,
  source: 0,
  size: 1,
  name: 2,
  defines: 3,
  include: 4,
  entry: 5,
  profile: 6,
  flags1: 7,
  output: 9,
  errors: 10,
  profiles: ['vs_5_0', 'ps_5_0'],
};
const COMPILE_FROM_FILE_LAYOUT = {
  ...D3DCOMPILE_LAYOUT,
  argc: 9,
  fromFile: true,
  source: 0,
  size: 1,
  name: 0,
  defines: 1,
  include: 2,
  entry: 3,
  profile: 4,
  flags1: 5,
  output: 7,
  errors: 8,
};
// D3D10CompileShader(const char *pSrcData, SIZE_T SrcDataSize,
//                    const char *pFileName, const D3D10_SHADER_MACRO *pDefines,
//                    ID3D10Include *pInclude, const char *pEntrypoint,
//                    const char *pTarget, UINT Flags, ID3D10Blob **ppShader,
//                    ID3D10Blob **ppErrorMsgs) — no second flags word.
export const COMPILE_SHADER_10_LAYOUT = {
  argc: 10,
  fromFile: false,
  source: 0,
  size: 1,
  name: 2,
  defines: 3,
  include: 4,
  entry: 5,
  profile: 6,
  flags1: 7,
  output: 8,
  errors: 9,
  profiles: ['vs_4_0', 'ps_4_0', 'gs_4_0'],
};

export const d3dCompilerApis = {
  'd3dcompiler_47.dll!D3DCompile': (r, a) => compile(r, a, D3DCOMPILE_LAYOUT),
  'd3dcompiler_47.dll!D3DCompileFromFile': (r, a) => compile(r, a, COMPILE_FROM_FILE_LAYOUT),
};
