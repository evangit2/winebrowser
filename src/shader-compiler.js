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

export class ShaderCompiler {
  constructor({ baseURL = new URL(import.meta.env.BASE_URL, globalThis.location?.origin) } = {}) {
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
