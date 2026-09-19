// Bounded x87 state and instruction classification. Arithmetic is delegated to
// the repository's deterministic Berkeley SoftFloat ext80 module.
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
});

const POP = 1,
  MEMORY = 2,
  REVERSE = 4,
  EFLAGS = 8,
  UNORDERED = 16,
  ZERO = 32;

const stIndex = (register, R) => (register >= R.ST0 && register <= R.ST7 ? register - R.ST0 : -1);

export function classifyX87(i, iced) {
  const { Mnemonic: M, OpKind: K, Register: R, MemorySizeExt } = iced;
  const m = i.mnemonic,
    mem = i.opCount && i.opKind(i.opCount - 1) === K.Memory,
    width = mem ? MemorySizeExt.size(i.memorySize) : 0,
    reg = (n) => (n < i.opCount && i.opKind(n) === K.Register ? stIndex(i.opRegister(n), R) : -1),
    result = (op, a = 0, b = 0, flags = 0) => ({ op, a, b, width, flags, memory: mem });

  if (m === M.Fld) return mem ? result(X87Op.loadFloat) : result(X87Op.loadStack, reg(0));
  if (m === M.Fild) return result(X87Op.loadInt);
  if (m === M.Fst || m === M.Fstp)
    return mem
      ? result(X87Op.storeFloat, 0, 0, m === M.Fstp ? POP : 0)
      : result(X87Op.storeStack, reg(0), 0, m === M.Fstp ? POP : 0);
  if (m === M.Fist || m === M.Fistp) return result(X87Op.storeInt, 0, 0, m === M.Fistp ? POP : 0);
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
    const reverse = [M.Fsubr, M.Fsubrp, M.Fdivr, M.Fdivrp].includes(m);
    const dst = mem ? 0 : Math.max(0, reg(0));
    const src = mem ? -1 : i.opCount > 1 ? reg(1) : reg(0);
    return result(
      X87Op.arithmetic,
      arithmetic.get(m),
      (dst << 8) | (src & 0xff),
      (pop ? POP : 0) | (mem ? MEMORY : 0) | (reverse ? REVERSE : 0),
    );
  }

  const compares = [M.Fcom, M.Fcomp, M.Fcompp, M.Fucom, M.Fucomp, M.Fucompp];
  const eflagCompares = [M.Fcomi, M.Fcomip, M.Fucomi, M.Fucomip];
  if (compares.includes(m) || eflagCompares.includes(m)) {
    const pop = [M.Fcomp, M.Fcompp, M.Fucomp, M.Fucompp, M.Fcomip, M.Fucomip].includes(m);
    const popCount = [M.Fcompp, M.Fucompp].includes(m) ? 2 : pop ? 1 : 0;
    const source = mem ? -1 : i.opCount > 1 ? reg(1) : i.opCount ? reg(0) : 1;
    return result(
      X87Op.compare,
      source,
      popCount,
      (mem ? MEMORY : 0) |
        (eflagCompares.includes(m) ? EFLAGS : 0) |
        ([M.Fucom, M.Fucomp, M.Fucompp, M.Fucomi, M.Fucomip].includes(m) ? UNORDERED : 0),
    );
  }
  if (m === M.Fsqrt) return result(X87Op.sqrt);
  if (m === M.Frndint) return result(X87Op.round);
  if (m === M.Fabs || m === M.Fchs) return result(X87Op.sign, m === M.Fchs ? 1 : 0);
  if (m === M.Ftst) return result(X87Op.compare, 0, 0, ZERO);
  if (m === M.Fldcw) return result(X87Op.loadControl);
  if (m === M.Fnstcw || m === M.Fstcw) return result(X87Op.storeControl);
  if (m === M.Fnstsw || m === M.Fstsw)
    return result(X87Op.storeStatus, i.opCount && i.opKind(0) === K.Register ? 1 : 0);
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
  constructor({ memory, check, registers, flags, moduleUrl, wasmUrl }) {
    this.memory = memory;
    this.check = check;
    this.registers = registers;
    this.flags = flags;
    this.moduleUrl = moduleUrl;
    this.wasmUrl = wasmUrl;
    this.values = Array.from({ length: 8 }, () => new Uint8Array(10));
    this.tags = new Uint8Array(8).fill(3);
    this.reset();
    this.ready = null;
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
        : new URL(`${base}runtime/softfloat/softfloat.js`, location.href).href);
    const wasmUrl = this.wasmUrl ?? new URL('softfloat.wasm', moduleUrl).href;
    this.sf = await loadSoftFloat(moduleUrl, wasmUrl);
    this.p = this.sf._malloc(42);
    if (!this.p) throw Error('SoftFloat scratch allocation failed');
    this.#configure();
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
  }

  #configure() {
    const rounding = [0, 2, 3, 1][(this.control >>> 10) & 3];
    const precision = [24, 0, 53, 64][(this.control >>> 8) & 3];
    if (!precision) throw Error('Reserved x87 precision-control mode');
    if (this.sf._wb_sf_init(this.p, 4, rounding, precision, 1))
      throw Error('SoftFloat init failed');
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

  #set(st, value) {
    const n = this.#physical(st);
    this.values[n].set(value);
    const c = this.sf._wb_sf_classify(this.#put(value), 10);
    this.tags[n] = c & 1 ? 1 : c & (2 | 8 | 16 | 32) ? 2 : 0;
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

  #operation(call) {
    this.#configure();
    const rc = call();
    if (rc) throw Error(`SoftFloat operation failed (${rc})`);
    const flags = this.sf.HEAPU8[this.p + 3];
    let x = 0;
    for (let bit = 0; bit < 5; bit++) if (flags & (1 << bit)) x |= 1 << SOFT_TO_X87[1 << bit];
    if (x) this.#exception(x, false);
    return this.sf.HEAPU8.slice(this.p + 24, this.p + 34);
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

  #convertTo(value, kind, width) {
    const fn =
      kind === 'f32'
        ? '_wb_sf_to_f32'
        : kind === 'f64'
          ? '_wb_sf_to_f64'
          : kind === 'i32'
            ? '_wb_sf_to_i32'
            : '_wb_sf_to_i64';
    this.#put(value, 4);
    this.#operation(() => this.sf[fn](this.p, 4, this.p + 24, width, this.p + 4, 10));
    return this.sf.HEAPU8.slice(this.p + 24, this.p + 24 + width);
  }

  execute(op, a, b, address, width, options) {
    if (!this.sf) throw Error('x87 SoftFloat runtime is not initialized');
    if (op === X87Op.wait) {
      const pending = this.status & ~this.control & 0x3f;
      if (pending) {
        this.status |= 0x80;
        throw Error(
          `Pending unmasked x87 exception 0x${pending.toString(16)} delivery unsupported`,
        );
      }
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
    if (op === X87Op.storeStatus) {
      const status = (this.status & ~(7 << 11)) | (this.top << 11);
      if (a) this.registers[0].value = (this.registers[0].value & ~0xffff) | status;
      else this.#write(address, Uint8Array.of(status & 255, status >>> 8));
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
      let bytes = this.#read(address, width);
      if (width === 2) {
        const sign = bytes[1] & 0x80 ? 0xff : 0;
        bytes = Uint8Array.of(bytes[0], bytes[1], sign, sign);
      }
      return this.#push(this.#convertFrom(bytes, width === 8 ? 'i64' : 'i32'));
    }
    if (op === X87Op.storeStack) {
      this.#set(a, this.#value(0));
      if (options & POP) this.#pop();
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
      let bytes;
      if (op === X87Op.storeFloat)
        bytes =
          width === 10
            ? this.#value(0).slice()
            : this.#convertTo(this.#value(0), width === 4 ? 'f32' : 'f64', width);
      else if (width === 2) {
        const full = this.#convertTo(this.#value(0), 'i32', 4),
          value = new DataView(full.buffer, full.byteOffset, 4).getInt32(0, true);
        if (value < -32768 || value > 32767) {
          this.#exception(1, false);
          bytes = Uint8Array.of(0, 0x80);
        } else bytes = full.slice(0, 2);
      } else bytes = this.#convertTo(this.#value(0), width === 4 ? 'i32' : 'i64', width);
      this.#write(address, bytes);
      if (options & POP) this.#pop();
      return;
    }
    if (op === X87Op.arithmetic) {
      const dst = b >>> 8,
        src = b & 255;
      let right;
      if (options & MEMORY) {
        if (![4, 8].includes(width)) throw Error(`Unsupported x87 arithmetic width ${width}`);
        right = this.#convertFrom(this.#read(address, width), width === 4 ? 'f32' : 'f64');
      } else right = this.#value(src);
      let left = this.#value(dst);
      if (options & REVERSE) [left, right] = [right, left];
      this.#put(left, 4);
      this.#put(right, 14);
      const value = this.#operation(() =>
        this.sf._wb_sf_binary(this.p, 4, a, this.p + 24, 10, this.p + 4, 10, this.p + 14, 10),
      );
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
    if (op === X87Op.compare) {
      let right;
      if (options & ZERO) right = CONSTANTS[0];
      else if (options & MEMORY) {
        if (![4, 8].includes(width)) throw Error(`Unsupported x87 compare width ${width}`);
        right = this.#convertFrom(this.#read(address, width), width === 4 ? 'f32' : 'f64');
      } else right = this.#value(a);
      const left = this.#value(0);
      const leftClass = this.sf._wb_sf_classify(this.#put(left), 10);
      const rightClass = this.sf._wb_sf_classify(this.#put(right), 10);
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
