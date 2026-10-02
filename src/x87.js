// Bounded x87 state and instruction classification. Arithmetic is delegated to
// the repository's deterministic Berkeley SoftFloat ext80 module.
import { fyl2x, fpatan, sincos, f2xm1, fscale, fptan } from './x87-transcendentals.js';
import { classifyExtendedFloat } from './x87-classification.js';
import { roundedMagnitudeUp } from './x87-rounding.js';
export const X87Op = Object.freeze({
  loadFloat: 0,
  loadInt: 1,
  loadStack: 2,
  storeFloat: 3,
  storeInt: 4,
  storeStack: 5,
  exchange: 6,
  constant: 7,
  arithmetic: 8,
  compare: 9,
  sqrt: 10,
  round: 11,
  loadControl: 12,
  storeControl: 13,
  storeStatus: 14,
  initialize: 15,
  clearExceptions: 16,
  sign: 17,
  wait: 18,
  logarithm: 19,
  trigonometric: 20,
  arctangent: 23,
  examine: 21,
  free: 22,
  conditionalMove: 24,
  storeState: 25,
  loadState: 26,
  exponential: 27,
  scale: 28,
  tangent: 29,
  storeExtendedState: 30,
  loadExtendedState: 31,
});

const POP = 1,
  MEMORY = 2,
  REVERSE = 4,
  EFLAGS = 8,
  UNORDERED = 16,
  ZERO = 32,
  TRUNCATE = 64,
  INTEGER = 128,
  ENVIRONMENT = 256;

const stIndex = (register, R) => (register >= R.ST0 && register <= R.ST7 ? register - R.ST0 : -1);

export function classifyX87(i, iced) {
  const { Mnemonic: M, OpKind: K, Register: R, MemorySizeExt } = iced;
  const m = i.mnemonic,
    mem = i.opCount && i.opKind(i.opCount - 1) === K.Memory,
    width = mem ? MemorySizeExt.size(i.memorySize) : 0,
    reg = (n) => (n < i.opCount && i.opKind(n) === K.Register ? stIndex(i.opRegister(n), R) : -1),
    result = (op, a = 0, b = 0, flags = 0) => ({ op, a, b, width, flags, memory: mem });

  if (m === M.Fxsave) return result(X87Op.storeExtendedState);
  if (m === M.Fxrstor) return result(X87Op.loadExtendedState);
  if (m === M.Fld) return mem ? result(X87Op.loadFloat) : result(X87Op.loadStack, reg(0));
  if (m === M.Fild) return result(X87Op.loadInt);
  if (m === M.Fst || m === M.Fstp)
    return mem
      ? result(X87Op.storeFloat, 0, 0, m === M.Fstp ? POP : 0)
      : result(X87Op.storeStack, reg(0), 0, m === M.Fstp ? POP : 0);
  if (m === M.Fist || m === M.Fistp) return result(X87Op.storeInt, 0, 0, m === M.Fistp ? POP : 0);
  if (m === M.Fisttp) return result(X87Op.storeInt, 0, 0, POP | TRUNCATE);
  if (m === M.Fxch) return result(X87Op.exchange, reg(i.opCount > 1 ? 1 : 0));

  const constants = new Map([
    [M.Fldz, 0],
    [M.Fld1, 1],
    [M.Fldpi, 2],
    [M.Fldl2e, 3],
    [M.Fldl2t, 4],
    [M.Fldlg2, 5],
    [M.Fldln2, 6],
  ]);
  if (constants.has(m)) return result(X87Op.constant, constants.get(m));

  const arithmetic = new Map([
    [M.Fiadd, 0],
    [M.Fisub, 1],
    [M.Fisubr, 1],
    [M.Fimul, 2],
    [M.Fidiv, 3],
    [M.Fidivr, 3],
    [M.Fadd, 0],
    [M.Faddp, 0],
    [M.Fsub, 1],
    [M.Fsubp, 1],
    [M.Fsubr, 1],
    [M.Fsubrp, 1],
    [M.Fmul, 2],
    [M.Fmulp, 2],
    [M.Fdiv, 3],
    [M.Fdivp, 3],
    [M.Fdivr, 3],
    [M.Fdivrp, 3],
  ]);
  if (arithmetic.has(m)) {
    const pop = [M.Faddp, M.Fsubp, M.Fsubrp, M.Fmulp, M.Fdivp, M.Fdivrp].includes(m);
    const reverse = [M.Fsubr, M.Fsubrp, M.Fdivr, M.Fdivrp, M.Fisubr, M.Fidivr].includes(m);
    const integer = [M.Fiadd, M.Fisub, M.Fisubr, M.Fimul, M.Fidiv, M.Fidivr].includes(m);
    const dst = mem ? 0 : Math.max(0, reg(0));
    const src = mem ? -1 : i.opCount > 1 ? reg(1) : reg(0);
    return result(
      X87Op.arithmetic,
      arithmetic.get(m),
      (dst << 8) | (src & 0xff),
      (pop ? POP : 0) | (mem ? MEMORY : 0) | (reverse ? REVERSE : 0) | (integer ? INTEGER : 0),
    );
  }

  const compares = [M.Fcom, M.Fcomp, M.Fcompp, M.Fucom, M.Fucomp, M.Fucompp, M.Ficom, M.Ficomp];
  const eflagCompares = [M.Fcomi, M.Fcomip, M.Fucomi, M.Fucomip];
  if (compares.includes(m) || eflagCompares.includes(m)) {
    const pop = [M.Fcomp, M.Fcompp, M.Fucomp, M.Fucompp, M.Fcomip, M.Fucomip, M.Ficomp].includes(m);
    const popCount = [M.Fcompp, M.Fucompp].includes(m) ? 2 : pop ? 1 : 0;
    const source = mem ? -1 : i.opCount > 1 ? reg(1) : i.opCount ? reg(0) : 1;
    return result(
      X87Op.compare,
      source,
      popCount,
      (mem ? MEMORY : 0) |
        ([M.Ficom, M.Ficomp].includes(m) ? INTEGER : 0) |
        (eflagCompares.includes(m) ? EFLAGS : 0) |
        ([M.Fucom, M.Fucomp, M.Fucompp, M.Fucomi, M.Fucomip].includes(m) ? UNORDERED : 0),
    );
  }
  if (m === M.Fsqrt) return result(X87Op.sqrt);
  // F2XM1 computes 2^x - 1 for -1 <= x <= 1; ST(0) is both source and result.
  if (m === M.F2xm1) return result(X87Op.exponential);
  // FSCALE multiplies ST(0) by 2^trunc(ST(1)); ST(0) is both source and result.
  if (m === M.Fscale) return result(X87Op.scale);
  if (m === M.Frndint) return result(X87Op.round);
  if (m === M.Fyl2x) return result(X87Op.logarithm);
  // FPATAN: arctan(ST(1)/ST(0)); the density reflects two stack operands.
  if (m === M.Fpatan) return result(X87Op.arctangent);
  if (m === M.Fsin || m === M.Fcos || m === M.Fsincos)
    return result(X87Op.trigonometric, m === M.Fsin ? 0 : m === M.Fcos ? 1 : 2);
  // FPTAN: tan(ST(0)), then push 1.0 so ST(0) holds the tangent and ST(1) one.
  if (m === M.Fptan) return result(X87Op.tangent);
  if (m === M.Fxam) return result(X87Op.examine);
  // FCMOVcc moves ST(i) into ST(0) only when the matching integer condition
  // holds; otherwise the instruction is a no-op and raises no exception.
  const conditionalMoves = new Map([
    [M.Fcmovb, 0],
    [M.Fcmove, 1],
    [M.Fcmovbe, 2],
    [M.Fcmovu, 3],
    [M.Fcmovnb, 4],
    [M.Fcmovne, 5],
    [M.Fcmovnbe, 6],
    [M.Fcmovnu, 7],
  ]);
  if (conditionalMoves.has(m))
    return result(X87Op.conditionalMove, i.opCount > 1 ? reg(1) : reg(0), conditionalMoves.get(m));
  if (m === M.Ffree) return result(X87Op.free, reg(0));
  if (m === M.Fabs || m === M.Fchs) return result(X87Op.sign, m === M.Fchs ? 1 : 0);
  if (m === M.Ftst) return result(X87Op.compare, 0, 0, ZERO);
  if (m === M.Fldcw) return result(X87Op.loadControl);
  if (m === M.Fnstcw || m === M.Fstcw) return result(X87Op.storeControl);
  if (m === M.Fnstsw || m === M.Fstsw)
    return result(X87Op.storeStatus, i.opCount && i.opKind(0) === K.Register ? 1 : 0);
  // FSAVE/FNSAVE write the 28-byte environment followed by the eight 80-bit
  // registers and then reinitialize the FPU; FSTENV/FNSTENV write only the
  // environment. FRSTOR/FLDENV are their inverses.
  if (m === M.Fnsave || m === M.Fsave) return result(X87Op.storeState);
  if (m === M.Fnstenv || m === M.Fstenv) return result(X87Op.storeState, 0, 0, ENVIRONMENT);
  if (m === M.Frstor) return result(X87Op.loadState);
  if (m === M.Fldenv) return result(X87Op.loadState, 0, 0, ENVIRONMENT);
  if (m === M.Fninit || m === M.Finit) return result(X87Op.initialize);
  if (m === M.Fnclex || m === M.Fclex) return result(X87Op.clearExceptions);
  if (m === M.Wait) return result(X87Op.wait);
  return null;
}

const CONSTANTS = [
  '00000000000000000000',
  '0000000000000080ff3f',
  '35c26821a2da0fc90040',
  'bcf0175c293baab8ff3f',
  'fe8a1bcd4b789ad40040',
  '99f7cffb849a209afd3f',
  'ac79cfd1f71772b1fe3f',
].map((hex) => Uint8Array.from(hex.match(/../g), (x) => Number.parseInt(x, 16)));

const INDEFINITE = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0xc0, 0xff, 0xff]);
const SOFT_TO_X87 = [0, 5, 4, 0, 3, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0];

export class X87State {
  constructor({ memory, check, readBytes, registers, flags, moduleUrl, wasmUrl }) {
    this.memory = memory;
    this.check = check;
    this.readBytes = readBytes;
    this.registers = registers;
    this.flags = flags;
    this.moduleUrl = moduleUrl;
    this.wasmUrl = wasmUrl;
    this.values = Array.from({ length: 8 }, () => new Uint8Array(10));
    this.tags = new Uint8Array(8).fill(3);
    this.reset();
    this.ready = null;
    this.initialized = false;
    this.configuredMode = null;
    this.resultViews = null;
    this.resultHeap = null;
  }

  reset() {
    this.control = 0x037f;
    this.status = 0;
    this.top = 0;
    this.tags.fill(3);
  }

  async initialize() {
    if (!this.ready) this.ready = this.#load();
    return this.ready;
  }

  async #load() {
    const base = import.meta.env?.BASE_URL ?? '/';
    const moduleUrl =
      this.moduleUrl ??
      (typeof location === 'undefined'
        ? new URL('../public/runtime/softfloat/softfloat.js', import.meta.url).href
        : new URL(`${base}runtime/softfloat/softfloat.js`, location.origin).href);
    const wasmUrl = this.wasmUrl ?? new URL('softfloat.wasm', moduleUrl).href;
    this.sf = await loadSoftFloat(moduleUrl, wasmUrl);
    this.p = this.sf._malloc(42);
    if (!this.p) throw Error('SoftFloat scratch allocation failed');
    this.#configure();
    this.initialized = true;
  }

  snapshot() {
    return {
      control: this.control,
      status: this.status,
      top: this.top,
      tags: this.tags.slice(),
      values: this.values.map((v) => v.slice()),
    };
  }

  restore(s) {
    this.control = s.control;
    this.status = s.status;
    this.top = s.top;
    this.tags.set(s.tags);
    s.values.forEach((v, n) => this.values[n].set(v));
    if (this.sf) this.#configure();
  }

  dispose() {
    if (this.p) this.sf._free(this.p);
    this.p = 0;
    this.sf = null;
    this.ready = null;
    this.initialized = false;
    this.configuredMode = null;
    this.resultViews = null;
    this.resultHeap = null;
  }

  #configure(roundingOverride) {
    const rounding = roundingOverride ?? [0, 2, 3, 1][(this.control >>> 10) & 3];
    const precision = [24, 0, 53, 64][(this.control >>> 8) & 3];
    if (!precision) throw Error('Reserved x87 precision-control mode');
    const mode = (precision << 8) | rounding;
    if (this.configuredMode === mode) return;
    if (this.sf._wb_sf_init(this.p, 4, rounding, precision, 1))
      throw Error('SoftFloat init failed');
    this.configuredMode = mode;
  }

  #physical(st = 0) {
    return (this.top + st) & 7;
  }

  #value(st = 0) {
    const n = this.#physical(st);
    if (this.tags[n] === 3) {
      this.#exception(0x41, false);
      return INDEFINITE;
    }
    return this.values[n];
  }

  #tagFor(value) {
    const c = classifyExtendedFloat(value);
    return c & 1 ? 1 : c & (2 | 8 | 16 | 32) ? 2 : 0;
  }

  #set(st, value) {
    const n = this.#physical(st);
    this.values[n].set(value);
    this.tags[n] = this.#tagFor(value);
  }

  #push(value) {
    const next = (this.top - 1) & 7;
    if (this.tags[next] !== 3) {
      this.#exception(0x241, true);
      value = INDEFINITE;
    }
    this.top = next;
    this.#set(0, value);
  }

  #pop() {
    this.tags[this.top] = 3;
    this.top = (this.top + 1) & 7;
  }

  #put(bytes, offset = 4) {
    this.sf.HEAPU8.set(bytes, this.p + offset);
    return this.p + offset;
  }

  // These views are scratch values, consumed/copied before another helper
  // operation. Refresh them if another SoftFloat user grows its shared memory.
  #result(width) {
    const heap = this.sf.HEAPU8;
    if (this.resultHeap !== heap) {
      this.resultHeap = heap;
      this.resultViews = new Map(
        [2, 4, 8, 10].map((size) => [size, heap.subarray(this.p + 24, this.p + 24 + size)]),
      );
    }
    return this.resultViews.get(width);
  }

  #operation(call, roundingOverride) {
    this.#configure(roundingOverride);
    const rc = call();
    if (rc) throw Error(`SoftFloat operation failed (${rc})`);
    const flags = this.sf.HEAPU8[this.p + 3];
    let x = 0;
    for (let bit = 0; bit < 5; bit++) if (flags & (1 << bit)) x |= 1 << SOFT_TO_X87[1 << bit];
    if (x) this.#exception(x, false);
    return this.#result(10);
  }

  #exception(bits, stackOverflow) {
    this.status |= bits;
    if (bits & 0x40) this.status = stackOverflow ? this.status | 0x200 : this.status & ~0x200;
    const exceptions = bits & 0x3f;
    if (exceptions & ~this.control & 0x3f) {
      this.status |= 0x80;
      throw Error(`Unmasked x87 exception 0x${exceptions.toString(16)}`);
    }
  }

  #read(address, width) {
    address = this.check(address >>> 0, width, false);
    if (this.readBytes) return this.readBytes(address, width);
    return new Uint8Array(this.memory.buffer, address, width).slice();
  }

  #write(address, bytes) {
    address = this.check(address >>> 0, bytes.length, true);
    new Uint8Array(this.memory.buffer, address, bytes.length).set(bytes);
  }

  #convertFrom(bytes, kind) {
    const fn =
      kind === 'f32'
        ? '_wb_sf_from_f32'
        : kind === 'f64'
          ? '_wb_sf_from_f64'
          : kind === 'i32'
            ? '_wb_sf_from_i32'
            : '_wb_sf_from_i64';
    this.#put(bytes, 4);
    return this.#operation(() => this.sf[fn](this.p, 4, this.p + 24, 10, this.p + 4, bytes.length));
  }

  #integerOperand(address, width) {
    let bytes = this.#read(address, width);
    if (width === 2) {
      const sign = bytes[1] & 0x80 ? 0xff : 0;
      bytes = Uint8Array.of(bytes[0], bytes[1], sign, sign);
    }
    return this.#convertFrom(bytes, width === 8 ? 'i64' : 'i32');
  }

  #convertTo(value, kind, width, roundingOverride) {
    const fn =
      kind === 'f32'
        ? '_wb_sf_to_f32'
        : kind === 'f64'
          ? '_wb_sf_to_f64'
          : kind === 'i32'
            ? '_wb_sf_to_i32'
            : '_wb_sf_to_i64';
    this.#put(value, 4);
    this.#operation(() => {
      const rc = this.sf[fn](this.p, 4, this.p + 24, Math.max(4, width), this.p + 4, 10);
      if (!rc && kind === 'i32' && width === 2) {
        const view = new DataView(this.sf.HEAPU8.buffer);
        const integer = view.getInt32(this.p + 24, true);
        if (integer < -32768 || integer > 32767) {
          // Narrow integer overflow is invalid, taking priority over precision
          // from the intermediate int32 conversion before any exception fires.
          this.sf.HEAPU8[this.p + 3] = 16;
          view.setUint16(this.p + 24, 0x8000, true);
        }
      }
      return rc;
    }, roundingOverride);
    return this.#result(width);
  }

  // The CRT's _CI* intrinsics move their x87 arguments to binary64, call the
  // corresponding host math function, and push the double result back. The
  // argument order matches the st(i) numbering: the first argument is ST(0).
  doubleOperand(st) {
    const bytes = this.#value(st);
    const value = this.#convertTo(bytes, 'f64', 8);
    return new DataView(value.buffer, value.byteOffset, 8).getFloat64(0, true);
  }
  popDouble() {
    const value = this.doubleOperand(0);
    this.#pop();
    return value;
  }
  pushDouble(value) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value, true);
    return this.#push(this.#convertFrom(bytes, 'f64'));
  }

  // The CRT's _ftol intrinsic truncates ST(0) toward zero to int32 and pops
  // it, leaving the x87 stack exactly as the compiler expects. The SoftFloat
  // conversion already implements the documented out-of-range result.
  truncateToInt32() {
    if (!this.sf) throw Error('x87 SoftFloat runtime is not initialized');
    const bytes = this.#convertTo(this.#value(0), 'i32', 4, 1);
    const value = new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true);
    this.#pop();
    return value | 0;
  }

  execute(op, a, b, address, width, options) {
    if (!this.sf) throw Error('x87 SoftFloat runtime is not initialized');
    if (op === X87Op.wait || op === X87Op.free) {
      const pending = this.status & ~this.control & 0x3f;
      if (pending) {
        this.status |= 0x80;
        throw Error(
          `Pending unmasked x87 exception 0x${pending.toString(16)} delivery unsupported`,
        );
      }
      if (op === X87Op.wait) return;
      // FFREE changes only the logical register's tag. It neither pops TOP
      // nor reads/classifies the stale register bits (which may hold an sNaN).
      this.tags[this.#physical(a)] = 3;
      return;
    }
    if (op === X87Op.initialize) return this.reset();
    if (op === X87Op.clearExceptions) return (this.status &= ~0xff);
    if (op === X87Op.loadControl) {
      const bytes = this.#read(address, 2);
      this.control = bytes[0] | (bytes[1] << 8);
      return this.#configure();
    }
    if (op === X87Op.storeControl)
      return this.#write(address, Uint8Array.of(this.control & 255, this.control >>> 8));
    if (op === X87Op.storeState || op === X87Op.loadState) {
      const environment = !!(options & ENVIRONMENT);
      const size = environment ? 28 : 108;
      if (width !== size) throw Error(`Unsupported x87 state width ${width}`);
      if (op === X87Op.loadState) {
        const bytes = this.#read(address, size);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.control = view.getUint16(0, true);
        const stored = view.getUint16(4, true);
        this.status = stored & ~(7 << 11);
        this.top = (stored >>> 11) & 7;
        // The tag word restores verbatim in both forms (FLDENV historically
        // leaves register contents stale next to a fresh tag word). Registers
        // are stored in physical R0..R7 order and only reloaded by FRSTOR; an
        // empty slot keeps its undefined contents and must not be read.
        const storedTags = view.getUint16(8, true);
        for (let i = 0; i < 8; i++) {
          this.tags[i] = (storedTags >>> (i * 2)) & 3;
          if (!environment && this.tags[i] !== 3)
            this.values[i].set(bytes.subarray(28 + i * 10, 38 + i * 10));
        }
        return this.#configure();
      }
      const bytes = new Uint8Array(size);
      const view = new DataView(bytes.buffer);
      const status = (this.status & ~(7 << 11)) | (this.top << 11);
      // FSTENV/FNSTENV/FSAVE/FNSAVE store the control word with every exception
      // masked. The live control word is left untouched by FSTENV; FNSAVE
      // reinitializes the FPU afterwards, which masks anyway.
      view.setUint16(0, this.control | 0x3f, true);
      view.setUint16(4, status, true);
      let tag = 0;
      for (let i = 0; i < 8; i++) tag |= this.tags[i] << (i * 2);
      view.setUint16(8, tag, true);
      // The instruction/data pointers and last opcode are documented as not
      // meaningful on modern processors; leave them zeroed.
      if (!environment) for (let i = 0; i < 8; i++) bytes.set(this.values[i], 28 + i * 10);
      this.#write(address, bytes);
      // FSAVE/FNSAVE reinitialize the FPU after storing their state.
      if (!environment) this.reset();
      return;
    }
    if (op === X87Op.storeStatus) {
      const status = (this.status & ~(7 << 11)) | (this.top << 11);
      if (a) this.registers[0].value = (this.registers[0].value & ~0xffff) | status;
      else this.#write(address, Uint8Array.of(status & 255, status >>> 8));
      return;
    }
    if (op === X87Op.examine) {
      // Do not use #value: examining an empty register must not raise #IS.
      const value = this.values[this.top];
      const view = new DataView(value.buffer, value.byteOffset, 10);
      const significand = view.getBigUint64(0, true),
        exponent = view.getUint16(8, true) & 0x7fff;
      let condition;
      if (this.tags[this.top] === 3) condition = 0x4100;
      else if (exponent && !(significand & (1n << 63n))) condition = 0;
      else if (exponent === 0x7fff) condition = significand === 1n << 63n ? 0x500 : 0x100;
      else if (exponent === 0) condition = significand ? 0x4400 : 0x4000;
      else condition = 0x400;
      this.status = (this.status & ~0x4700) | condition | (value[9] & 0x80 ? 0x200 : 0);
      return;
    }
    if (op === X87Op.constant) {
      if (a >= 2 && ((this.control >>> 10) & 3) !== 0)
        throw Error('Directed rounding of x87 transcendental constants is unsupported');
      return this.#push(CONSTANTS[a]);
    }
    if (op === X87Op.loadStack) return this.#push(this.#value(a).slice());
    if (op === X87Op.loadFloat) {
      if (![4, 8, 10].includes(width)) throw Error(`Unsupported FLD width ${width}`);
      const bytes = this.#read(address, width);
      return this.#push(
        width === 10 ? bytes : this.#convertFrom(bytes, width === 4 ? 'f32' : 'f64'),
      );
    }
    if (op === X87Op.loadInt) {
      if (![2, 4, 8].includes(width)) throw Error(`Unsupported FILD width ${width}`);
      return this.#push(this.#integerOperand(address, width));
    }
    if (op === X87Op.storeStack) {
      this.#set(a, this.#value(0));
      if (options & POP) this.#pop();
      return;
    }
    if (op === X87Op.conditionalMove) {
      // The integer condition codes come from the shared EFLAGS register file.
      const f = this.flags.f ?? this.flags;
      const cf = f.cf ? 1 : 0,
        zf = f.zf ? 1 : 0,
        pf = f.pf ? 1 : 0;
      const condition = [
        cf, // FCMOVB  / FCMOVC
        zf, // FCMOVE  / FCMOVZ
        cf | zf, // FCMOVBE / FCMOVNA
        pf, // FCMOVU
        cf ^ 1, // FCMOVNB / FCMOVNC
        zf ^ 1, // FCMOVNE / FCMOVNZ
        (cf | zf) ^ 1, // FCMOVNBE / FCMOVNBC
        pf ^ 1, // FCMOVNU
      ][b];
      if (condition) this.#set(0, this.#value(a).slice());
      return;
    }
    if (op === X87Op.exchange) {
      const x = this.#value(0).slice(),
        y = this.#value(a).slice();
      this.#set(0, y);
      this.#set(a, x);
      return;
    }
    if (op === X87Op.sign) {
      const value = this.#value(0).slice();
      if (a) value[9] ^= 0x80;
      else value[9] &= 0x7f;
      return this.#set(0, value);
    }
    if (op === X87Op.storeFloat || op === X87Op.storeInt) {
      if (op === X87Op.storeFloat && ![4, 8, 10].includes(width))
        throw Error(`Unsupported FST width ${width}`);
      if (op === X87Op.storeInt && ![2, 4, 8].includes(width))
        throw Error(`Unsupported FIST width ${width}`);
      this.check(address >>> 0, width, true);
      if (options & TRUNCATE) this.status &= ~0x200; // FISTTP always clears C1.
      let bytes;
      if (op === X87Op.storeFloat)
        bytes =
          width === 10
            ? this.#value(0).slice()
            : this.#convertTo(this.#value(0), width === 4 ? 'f32' : 'f64', width);
      else
        bytes = this.#convertTo(
          this.#value(0),
          width === 8 ? 'i64' : 'i32',
          width,
          options & TRUNCATE ? 1 : undefined,
        );
      this.#write(address, bytes);
      if (options & POP) this.#pop();
      return;
    }
    if (op === X87Op.arithmetic) {
      const dst = b >>> 8,
        src = b & 255;
      let right;
      if (options & MEMORY) {
        if (!(options & INTEGER ? [2, 4] : [4, 8]).includes(width))
          throw Error(`Unsupported x87 arithmetic width ${width}`);
        right =
          options & INTEGER
            ? this.#integerOperand(address, width)
            : this.#convertFrom(this.#read(address, width), width === 4 ? 'f32' : 'f64');
      } else right = this.#value(src);
      // Integer arithmetic's C1 rounding test also needs the original
      // converted operand after the helper overwrites its result scratch.
      if ((options & (INTEGER | MEMORY)) === (INTEGER | MEMORY)) right = right.slice();
      let left = this.#value(dst);
      if (options & INTEGER) this.status &= ~0x200;
      if (options & REVERSE) [left, right] = [right, left];
      this.#put(left, 4);
      this.#put(right, 14);
      const value = this.#operation(() =>
        this.sf._wb_sf_binary(this.p, 4, a, this.p + 24, 10, this.p + 4, 10, this.p + 14, 10),
      );
      if (
        options & INTEGER &&
        this.sf.HEAPU8[this.p + 3] & 1 &&
        roundedMagnitudeUp(left, right, value, a)
      )
        this.status |= 0x200;
      this.#set(dst, value);
      if (options & POP) this.#pop();
      return;
    }
    if (op === X87Op.sqrt) {
      this.#put(this.#value(0), 4);
      return this.#set(
        0,
        this.#operation(() => this.sf._wb_sf_sqrt(this.p, 4, this.p + 24, 10, this.p + 4, 10)),
      );
    }
    if (op === X87Op.round) {
      this.#put(this.#value(0), 4);
      return this.#set(
        0,
        this.#operation(() => this.sf._wb_sf_round(this.p, 4, this.p + 24, 10, this.p + 4, 10)),
      );
    }
    if (op === X87Op.exponential) {
      const result = f2xm1(this.#value(0), (this.control >>> 10) & 3);
      this.status &= ~0x200;
      if (result.flags) this.#exception(result.flags, false);
      if (result.roundedUp) this.status |= 0x200;
      return this.#set(0, result.bytes);
    }
    if (op === X87Op.scale) {
      const result = fscale(this.#value(0), this.#value(1), (this.control >>> 10) & 3);
      this.status &= ~0x200;
      if (result.flags) this.#exception(result.flags, false);
      if (result.roundedUp) this.status |= 0x200;
      return this.#set(0, result.bytes);
    }
    if (op === X87Op.logarithm) {
      const result = fyl2x(this.#value(0), this.#value(1), (this.control >>> 10) & 3);
      this.status &= ~0x200;
      if (result.flags) this.#exception(result.flags, false);
      if (result.roundedUp) this.status |= 0x200;
      this.#set(1, result.bytes);
      this.#pop();
      return;
    }
    if (op === X87Op.arctangent) {
      // Result replaces ST(1); ST(0) is popped, matching FSTP ST(1).
      const result = fpatan(this.#value(1), this.#value(0), (this.control >>> 10) & 3);
      this.status &= ~0x200;
      if (result.flags) this.#exception(result.flags, false);
      if (result.roundedUp) this.status |= 0x200;
      this.#set(1, result.bytes);
      this.#pop();
      return;
    }
    if (op === X87Op.trigonometric) {
      const result = sincos(this.#value(0), (this.control >>> 10) & 3);
      if (result.outOfRange) {
        this.status |= 0x400;
        return;
      }
      this.status &= ~0x600;
      if (a === 2 && this.tags[(this.top - 1) & 7] !== 3) {
        this.#exception(0x241, true);
        this.#set(0, INDEFINITE);
        this.#push(INDEFINITE);
        return;
      }
      const selected = a === 0 ? result.sine : result.cosine;
      const flags = a === 2 ? result.sine.flags | result.cosine.flags : selected.flags;
      if (flags) this.#exception(flags, false);
      if (selected.roundedUp) this.status |= 0x200;
      if (a === 2) {
        this.#set(0, result.sine.bytes);
        this.#push(result.cosine.bytes);
      } else this.#set(0, selected.bytes);
      return;
    }
    if (op === X87Op.tangent) {
      const result = fptan(this.#value(0), (this.control >>> 10) & 3);
      if (result.outOfRange) {
        this.status = (this.status & ~0x200) | 0x400;
        return;
      }
      this.status &= ~0x600;
      if (this.tags[(this.top - 1) & 7] !== 3) {
        // The push of the trailing 1.0 overflows the stack.
        this.#exception(0x241, true);
        this.#set(0, INDEFINITE);
        this.#push(INDEFINITE);
        return;
      }
      if (result.flags) this.#exception(result.flags, false);
      if (result.roundedUp) this.status |= 0x200;
      // A NaN result (from an invalid, infinite or NaN argument) is pushed into
      // both registers; a finite tangent is followed by the exact 1.0.
      this.#set(0, result.bytes);
      this.#push(result.nan ? result.bytes.slice() : CONSTANTS[1]);
      return;
    }
    if (op === X87Op.compare) {
      let right;
      if (options & ZERO) right = CONSTANTS[0];
      else if (options & MEMORY) {
        if (!(options & INTEGER ? [2, 4] : [4, 8]).includes(width))
          throw Error(`Unsupported x87 compare width ${width}`);
        right =
          options & INTEGER
            ? this.#integerOperand(address, width)
            : this.#convertFrom(this.#read(address, width), width === 4 ? 'f32' : 'f64');
      } else right = this.#value(a);
      if (options & INTEGER) this.status &= ~0x200;
      const left = this.#value(0);
      const leftClass = classifyExtendedFloat(left);
      const rightClass = classifyExtendedFloat(right);
      const nanMask = options & UNORDERED ? 32 : 16 | 32;
      if ((leftClass | rightClass) & nanMask) this.#exception(1, false);
      this.#put(left, 4);
      this.#put(right, 14);
      this.#configure();
      const rc = this.sf._wb_sf_compare(this.p, 4, this.p + 24, 4, this.p + 4, 10, this.p + 14, 10);
      if (rc) throw Error(`SoftFloat compare failed (${rc})`);
      const result = new DataView(this.sf.HEAPU8.buffer, this.p + 24, 4).getInt32(0, true);
      const unordered = result === 2;
      if (options & EFLAGS) {
        const f = this.flags.f ?? this.flags;
        f.cf = +(result < 0 || unordered);
        f.zf = +(result === 0 || unordered);
        f.pf = +unordered;
        f.of = f.sf = 0;
        this.flags.af = 0;
      } else {
        this.status &= ~0x4500;
        if (result < 0) this.status |= 0x0100;
        else if (result === 0) this.status |= 0x4000;
        else if (unordered) this.status |= 0x4500;
      }
      for (let n = 0; n < b; n++) this.#pop();
      return;
    }
    throw Error(`Unsupported x87 operation ${op}`);
  }
}

const softFloatModules = new Map();
function loadSoftFloat(moduleUrl, wasmUrl) {
  const key = `${moduleUrl}\n${wasmUrl}`;
  if (!softFloatModules.has(key))
    softFloatModules.set(
      key,
      import(/* @vite-ignore */ moduleUrl).then(({ default: factory }) =>
        factory({ locateFile: () => wasmUrl }),
      ),
    );
  return softFloatModules.get(key);
}
