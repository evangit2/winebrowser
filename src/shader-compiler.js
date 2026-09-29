// Generic shader translation services. This compiles guest DXBC shader bytes,
// independently of the x86-to-Wasm translator that executes application code.
const MAX_SHADER_BYTES = 1024 * 1024;

export const LEGACY_D3D_SHADER_BINDINGS = Object.freeze({
  vertexGroup: 0,
  pixelGroup: 1,
  floatConstantsBinding: 0,
  integerConstantsBinding: 1,
  booleanConstantsBinding: 2,
  textureBindingBase: 16,
  samplerBindingBase: 17,
  samplerBindingStride: 2,
});

function validateLegacyShader(bytes, stage) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.length < 8 ||
    bytes.length > MAX_SHADER_BYTES ||
    bytes.length % 4
  )
    throw Error(`Expected bounded DWORD-aligned legacy ${stage} shader bytecode`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0, true);
  const expected = stage === 'vertex' ? 0xfffe : 0xffff;
  const major = (version >>> 8) & 0xff;
  const minor = version & 0xff;
  const supported =
    stage === 'vertex'
      ? (major === 1 && minor === 1) || ((major === 2 || major === 3) && minor === 0)
      : (major === 1 && minor <= 4) || ((major === 2 || major === 3) && minor === 0);
  if (version >>> 16 !== expected || !supported)
    throw Error(`Unsupported legacy ${stage} shader version 0x${version.toString(16)}`);
  if (view.getUint32(bytes.length - 4, true) !== 0xffff)
    throw Error(`Legacy ${stage} shader END token is missing`);
}

// Vite provides import.meta.env.BASE_URL in the browser build; plain Node
// diagnostic runs and workers without that replacement use the site root.
function defaultBaseURL() {
  const base = import.meta.env?.BASE_URL ?? '/';
  return new URL(base, globalThis.location?.origin ?? 'http://127.0.0.1/');
}

export class ShaderCompiler {
  constructor({ baseURL = defaultBaseURL() } = {}) {
    this.baseURL = baseURL;
  }

  async initialize() {
    if (!this.initializing) {
      this.initializing = (async () => {
        const dxbcURL = new URL('shaders/vkd3d-shader.js', this.baseURL).href;
        const nagaURL = new URL('shaders/naga/winebrowser_shader_wgsl.js', this.baseURL).href;
        const [dxbcModule, naga] = await Promise.all([
          import(/* @vite-ignore */ dxbcURL),
          import(/* @vite-ignore */ nagaURL),
        ]);
        const dxbc = await dxbcModule.default({
          locateFile: (path) => new URL(path, dxbcURL).href,
        });
        await naga.default();
        this.dxbc = dxbc;
        this.naga = naga;
      })().catch((error) => {
        this.initializing = null;
        throw error;
      });
    }
    await this.initializing;
  }

  diagnostic(operation) {
    const address = this.dxbc._wb_messages_ptr();
    return Error(
      operation + ': ' + (address ? this.dxbc.UTF8ToString(address) : 'compiler rejected input'),
    );
  }

  async serializeRootSignature(flags) {
    if (flags !== 0 && flags !== 1) throw Error('Unsupported root signature flags');
    await this.initialize();
    try {
      if (this.dxbc._wb_root_signature_serialize(flags) !== 1)
        throw this.diagnostic('Root signature serialization failed');
      const address = this.dxbc._wb_result_ptr(),
        size = this.dxbc._wb_result_size();
      if (
        !address ||
        size < 32 ||
        size > MAX_SHADER_BYTES ||
        address + size > this.dxbc.HEAPU8.length
      )
        throw Error('Invalid serialized root signature size');
      return this.dxbc.HEAPU8.slice(address, address + size);
    } finally {
      this.dxbc._wb_clear();
    }
  }

  async validateRootSignature(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 32 || bytes.length > MAX_SHADER_BYTES)
      throw Error('Invalid root signature size');
    const source = bytes.slice();
    await this.initialize();
    const address = this.dxbc._malloc(source.length);
    if (!address) throw Error('Root signature allocation failed');
    try {
      this.dxbc.HEAPU8.set(source, address);
      if (this.dxbc._wb_root_signature_validate(address, source.length) !== 1)
        throw this.diagnostic('Root signature validation failed');
      return this.dxbc._wb_root_signature_flags();
    } finally {
      this.dxbc._wb_clear();
      this.dxbc._free(address);
    }
  }

  /**
   * Enumerates the D3D descriptors a compiled DXBC shader declares.
   *
   * Returns `{ type, space, register, resourceType, dataType, flags, count }`
   * per descriptor, in the order vkd3d-shader reports them. `type` is the
   * vkd3d descriptor type (SRV 0, UAV 1, CBV 2, sampler 3) and `resourceType`
   * distinguishes a buffer from a texture and its dimension.
   */
  async scanDescriptors(bytes) {
    this.#requireDXBC(bytes);
    const source = bytes.slice();
    await this.initialize();
    const compiler = this.dxbc;
    const input = compiler._malloc(source.length);
    if (!input) throw Error('Descriptor scan allocation failed');
    try {
      compiler.HEAPU8.set(source, input);
      if (compiler._wb_dxbc_scan(input, source.length) !== 1)
        throw this.diagnostic('DXBC descriptor scan failed');
      const address = compiler._wb_dxbc_scan_results();
      const count = compiler._wb_dxbc_scan_count();
      if (!count) return [];
      if (!address || count > 4096 || address + count * 28 > compiler.HEAPU8.length)
        throw Error('Invalid DXBC descriptor scan result');
      const words = new Uint32Array(compiler.HEAPU8.buffer, address, count * 7);
      const descriptors = [];
      for (let i = 0; i < count; i++) {
        const at = i * 7;
        descriptors.push({
          type: words[at],
          space: words[at + 1],
          register: words[at + 2],
          resourceType: words[at + 3],
          dataType: words[at + 4],
          flags: words[at + 5],
          count: words[at + 6],
          comparison: (words[at + 5] & 0x4) !== 0,
        });
      }
      return descriptors;
    } finally {
      compiler._wb_clear();
      compiler._free(input);
    }
  }

  /**
   * Compiles a DXBC shader against an explicit (register -> group/binding)
   * table. `placements` is one record per descriptor the caller has already
   * positioned, in the same field order as `scanDescriptors`.
   */
  async compileBound(bytes, placements) {
    this.#requireDXBC(bytes);
    if (!Array.isArray(placements) || placements.length > 4096)
      throw Error('Invalid descriptor placement table');
    const records = new Uint32Array(placements.length * 7);
    for (const [index, placement] of placements.entries()) {
      const at = index * 7;
      records[at] = placement.type;
      records[at + 1] = placement.space;
      records[at + 2] = placement.register;
      records[at + 3] = placement.resourceType;
      records[at + 4] = placement.group;
      records[at + 5] = placement.binding;
      records[at + 6] = placement.count;
    }
    const source = bytes.slice();
    await this.initialize();
    const compiler = this.dxbc;
    const input = compiler._malloc(source.length);
    const table = records.length ? compiler._malloc(records.byteLength) : 0;
    if (!input || (records.length && !table)) {
      if (input) compiler._free(input);
      if (table) compiler._free(table);
      throw Error('Bound DXBC compiler allocation failed');
    }
    try {
      compiler.HEAPU8.set(source, input);
      if (records.length)
        compiler.HEAPU8.set(new Uint8Array(records.buffer, records.byteOffset, records.byteLength), table);
      if (compiler._wb_dxbc_compile_bound(input, source.length, table, placements.length) !== 1)
        throw this.diagnostic('Bound DXBC compilation failed');
      const address = compiler._wb_result_ptr(),
        length = compiler._wb_result_size();
      if (
        !address ||
        length < 20 ||
        length > 16 * MAX_SHADER_BYTES ||
        length % 4 ||
        address + length > compiler.HEAPU8.length
      )
        throw Error('Invalid bound DXBC compiler output');
      const spirv = compiler.HEAPU8.slice(address, address + length);
      let wgsl;
      try {
        wgsl = this.naga.spirv_to_wgsl(spirv);
      } catch (error) {
        throw Error('Bound SPIR-V translation failed: ' + (error.message ?? String(error)));
      }
      return { spirv, wgsl };
    } finally {
      compiler._wb_clear();
      compiler._free(input);
      if (table) compiler._free(table);
    }
  }

  /**
   * Parses a serialized root signature into its structured form (parameters,
   * descriptor ranges and static samplers) using the same word layout the
   * bridge emits for wb_root_signature_inspect.
   */
  async inspectRootSignature(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 32 || bytes.length > MAX_SHADER_BYTES)
      throw Error('Invalid root signature length');
    const source = bytes.slice();
    await this.initialize();
    const compiler = this.dxbc;
    const address = compiler._malloc(source.length);
    if (!address) throw Error('Root signature inspection allocation failed');
    try {
      compiler.HEAPU8.set(source, address);
      if (compiler._wb_root_signature_inspect(address, source.length) !== 1)
        throw this.diagnostic('Root signature inspection failed');
      const wordsAddress = compiler._wb_root_signature_words();
      const count = compiler._wb_root_signature_word_count();
      if (!wordsAddress || count < 6 || wordsAddress + count * 4 > compiler.HEAPU8.length)
        throw Error('Invalid root signature inspection result');
      return {
        flags: compiler._wb_root_signature_flags(),
        words: new Uint32Array(compiler.HEAPU8.buffer, wordsAddress, count).slice(),
      };
    } finally {
      compiler._wb_clear();
      compiler._free(address);
    }
  }

  #requireDXBC(bytes) {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length < 32 ||
      bytes.length > MAX_SHADER_BYTES ||
      bytes[0] !== 0x44 ||
      bytes[1] !== 0x58 ||
      bytes[2] !== 0x42 ||
      bytes[3] !== 0x43
    )
      throw Error('Expected a bounded DXBC shader container');
  }

  async compile(bytes) {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length < 32 ||
      bytes.length > MAX_SHADER_BYTES ||
      bytes[0] !== 0x44 ||
      bytes[1] !== 0x58 ||
      bytes[2] !== 0x42 ||
      bytes[3] !== 0x43
    )
      throw Error('Expected a bounded DXBC shader container');
    // Take ownership before awaiting module initialization; callers may reuse
    // guest storage immediately after their API call completes.
    const source = bytes.slice();
    await this.initialize();
    const compiler = this.dxbc;
    const input = compiler._malloc(source.length);
    if (!input) throw Error('Shader compiler input allocation failed');
    try {
      compiler.HEAPU8.set(source, input);
      const status = compiler._wb_dxbc_compile(input, source.length);
      if (status !== 1) {
        const address = compiler._wb_messages_ptr();
        const message = address ? compiler.UTF8ToString(address) : `error ${status}`;
        throw Error('DXBC compilation failed: ' + message);
      }
      const address = compiler._wb_result_ptr();
      const length = compiler._wb_result_size();
      if (
        !address ||
        length < 20 ||
        length > 16 * MAX_SHADER_BYTES ||
        length % 4 ||
        address + length > compiler.HEAPU8.length
      )
        throw Error('Invalid SPIR-V compiler output');
      const spirv = compiler.HEAPU8.slice(address, address + length);
      let wgsl;
      try {
        wgsl = this.naga.spirv_to_wgsl(spirv);
      } catch (error) {
        throw Error('SPIR-V translation failed: ' + (error.message ?? String(error)));
      }
      return { spirv, wgsl };
    } finally {
      compiler._wb_clear();
      compiler._free(input);
    }
  }

  async compileHLSL(bytes, entry, profile, sourceName = 'shader.hlsl') {
    if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_SHADER_BYTES)
      throw Error('Expected bounded HLSL source');
    if (!['vs_5_0', 'ps_5_0'].includes(profile)) throw Error('Unsupported HLSL profile');
    if (typeof entry !== 'string' || !entry.length || entry.length > 256 || entry.includes('\0'))
      throw Error('Invalid HLSL entry point');
    if (typeof sourceName !== 'string' || sourceName.length > 4096 || sourceName.includes('\0'))
      throw Error('Invalid HLSL source name');
    const encoder = new TextEncoder();
    const sources = [
      bytes.slice(),
      ...[entry, profile, sourceName].map((s) => encoder.encode(s + '\0')),
    ];
    await this.initialize();
    const compiler = this.dxbc;
    const pointers = [];
    try {
      for (const source of sources) {
        const pointer = compiler._malloc(source.length);
        if (!pointer) throw Error('HLSL compiler allocation failed');
        pointers.push(pointer);
        compiler.HEAPU8.set(source, pointer);
      }
      if (compiler._wb_hlsl_compile(pointers[0], sources[0].length, ...pointers.slice(1)) !== 1)
        throw this.diagnostic('HLSL compilation failed');
      const pointer = compiler._wb_result_ptr(),
        length = compiler._wb_result_size();
      if (
        !pointer ||
        length < 32 ||
        length > MAX_SHADER_BYTES ||
        pointer + length > compiler.HEAPU8.length
      )
        throw Error('Invalid HLSL compiler output');
      const messages = compiler.UTF8ToString(compiler._wb_messages_ptr());
      return { bytes: compiler.HEAPU8.slice(pointer, pointer + length), messages };
    } finally {
      compiler._wb_clear();
      for (const pointer of pointers) compiler._free(pointer);
    }
  }

  async compileLegacyPair(vertexBytes, pixelBytes) {
    validateLegacyShader(vertexBytes, 'vertex');
    validateLegacyShader(pixelBytes, 'pixel');
    const sources = [vertexBytes.slice(), pixelBytes.slice()];
    await this.initialize();
    const compiler = this.dxbc;
    const pointers = sources.map((source) => compiler._malloc(source.length));
    if (pointers.some((pointer) => !pointer)) {
      for (const pointer of pointers) if (pointer) compiler._free(pointer);
      throw Error('Legacy shader compiler input allocation failed');
    }
    try {
      for (let stage = 0; stage < 2; stage++) compiler.HEAPU8.set(sources[stage], pointers[stage]);
      if (
        compiler._wb_d3dbc_compile_pair(
          pointers[0],
          sources[0].length,
          pointers[1],
          sources[1].length,
        ) !== 1
      )
        throw this.diagnostic('Legacy D3D shader compilation failed');
      const outputs = [];
      for (let stage = 0; stage < 2; stage++) {
        const address = compiler._wb_d3dbc_result_ptr(stage);
        const length = compiler._wb_d3dbc_result_size(stage);
        if (
          !address ||
          length < 20 ||
          length > 16 * MAX_SHADER_BYTES ||
          length % 4 ||
          address + length > compiler.HEAPU8.length
        )
          throw Error('Invalid legacy SPIR-V compiler output');
        const spirv = compiler.HEAPU8.slice(address, address + length);
        let wgsl;
        try {
          wgsl = this.naga.spirv_to_wgsl(spirv);
        } catch (error) {
          throw Error('Legacy SPIR-V translation failed: ' + (error.message ?? String(error)));
        }
        outputs.push({ spirv, wgsl });
      }
      return {
        vertex: outputs[0],
        pixel: outputs[1],
        bindings: LEGACY_D3D_SHADER_BINDINGS,
      };
    } finally {
      compiler._wb_clear();
      for (const pointer of pointers) compiler._free(pointer);
    }
  }
}
