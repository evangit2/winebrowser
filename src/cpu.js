// Direct x86 basic-block -> WebAssembly emitter. iced decodes; it does not execute.
import { moduleBytes, constant, get, set, local, call, Host } from './wasm.js';
import { classifySse, SIMDState } from './simd.js';
import { classifyX87, X87State } from './x87.js';
import { guestCpuid } from './processor-features.js';
import { GuestPerformanceClock, splitGuestCounter } from './guest-clock.js';
export class CPU {
  constructor(
    iced,
    {
      memory,
      read32,
      write32,
      read,
      write,
      check,
      executableRanges,
      stackTop = 0x3fff000,
      fsBase = 0,
      x87ModuleUrl,
      x87WasmUrl,
      performanceCounter,
    },
  ) {
    if (typeof SharedArrayBuffer !== 'undefined' && memory.buffer instanceof SharedArrayBuffer)
      throw Error('Shared WebAssembly.Memory is unsupported until host atomics are implemented');
    this.iced = iced;
    this.memory = memory;
    this.fsBase = fsBase;
    this.df = 0;
    this.read32 = read32;
    this.write32 = write32;
    this.r = Array.from(
      { length: 8 },
      () => new WebAssembly.Global({ value: 'i32', mutable: true }, 0),
    );
    this.r[4].value = stackTop;
    this.ranges = executableRanges;
    this.checkMemory =
      check ??
      ((address, size) => {
        address >>>= 0;
        if (!Number.isSafeInteger(size) || size < 0 || address + size > memory.buffer.byteLength)
          throw Error(`SIMD memory range violation at 0x${address.toString(16)} (${size} bytes)`);
        return address;
      });
    this.simd = new SIMDState(this.r, {
      read: (address, width) => (read ? read(address, width) : read32(address)),
      write: (address, value, width) =>
        write ? write(address, value, width) : write32(address, value),
      check: (address, size, isWrite) => this.checkMemory(address, size, isWrite),
    });
    this.x87 = new X87State({
      memory,
      check: (address, size, isWrite) => this.checkMemory(address, size, isWrite),
      registers: this.r,
      flags: this,
      moduleUrl: x87ModuleUrl,
      wasmUrl: x87WasmUrl,
    });
    this.cache = new Map();
    this.x87Blocks = new Set();
    this.compiledBytes = 0;
    this.instructions = 0;
    this.f = { cf: 0, zf: 0, sf: 0, of: 0, pf: 0 };
    this.af = 0;
    const localClock = performanceCounter ? null : new GuestPerformanceClock();
    this.performanceCounter = performanceCounter ?? (() => localClock.read());
    if (typeof this.performanceCounter !== 'function')
      throw new TypeError('CPU performance counter must be a function');
    this.host = {
      load: (a, width) =>
        read
          ? read(a >>> 0, width)
          : width === 4
            ? read32(a >>> 0)
            : (() => {
                throw Error('Narrow memory reader missing');
              })(),
      store: (a, v, width) =>
        write
          ? write(a >>> 0, v, width)
          : width === 4
            ? write32(a >>> 0, v)
            : (() => {
                throw Error('Narrow memory writer missing');
              })(),
      push: (v) => this.push(v),
      pop: () => this.pop(),
      popStore: (address, width) => {
        const stack = this.r[4].value >>> 0;
        const value = this.host.load(stack, width);
        this.checkMemory(address, width, true);
        this.host.store(address, value, width);
        this.r[4].value = (stack + width) | 0;
      },
      flags: (a, b, r, k, width) => this.flags(a, b, r, k, width),
      shift: (value, count, kind, width) => this.shift(value, count, kind, width),
      rotateCarry: (value, count, kind, width) => this.rotateCarry(value, count, kind, width),
      rotateCarryStore: (address, value, count, kind, width) => {
        this.checkMemory(address >>> 0, width >>> 3, true);
        this.host.store(address >>> 0, this.rotateCarry(value, count, kind, width), width >>> 3);
      },
      wideMath: (operand, kind, width) => this.wideMath(operand, kind, width),
      condition: (c) => this.condition(c),
      bitTest: (value, index, width) => {
        this.f.cf = (value >>> (index & (width - 1))) & 1;
      },
      simd: (op, dst, src, address, immediate) =>
        this.simd.execute(op, dst, src, address, immediate),
      x87: (op, a, b, address, width, options) =>
        this.x87.execute(op, a, b, address, width, options),
      flagByte: (value, write) => {
        if (write) {
          this.f.sf = (value >>> 7) & 1;
          this.f.zf = (value >>> 6) & 1;
          this.af = (value >>> 4) & 1;
          this.f.pf = (value >>> 2) & 1;
          this.f.cf = value & 1;
          return 0;
        }
        return (
          (this.f.sf << 7) | (this.f.zf << 6) | (this.af << 4) | (this.f.pf << 2) | 2 | this.f.cf
        );
      },
      cpuid: (leaf, subleaf) => {
        const value = guestCpuid(leaf, subleaf);
        this.r[0].value = value.eax | 0;
        this.r[1].value = value.ecx | 0;
        this.r[2].value = value.edx | 0;
        this.r[3].value = value.ebx | 0;
      },
      timestamp: () => {
        const value = splitGuestCounter(this.performanceCounter());
        this.r[0].value = value.low | 0;
        this.r[2].value = value.high | 0;
      },
      bitScan: (value, previous, reverse) => {
        this.f.zf = Number(value === 0);
        // The zero-input destination and non-ZF flags are architecturally undefined;
        // preserve them deterministically. Narrow sources are masked by operand().
        if (!value) return previous;
        return reverse ? 31 - Math.clz32(value) : 31 - Math.clz32(value & -value);
      },
      cmpxchg: (oldDestination, source, accumulator, bits, destinationRegister, shift, address) => {
        const bytes = bits >>> 3;
        if (![1, 2, 4].includes(bytes)) throw Error('CMPXCHG requires an 8/16/32-bit operand');
        const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1;
        const oldValue = (oldDestination >>> 0) & mask;
        const accValue = (accumulator >>> 0) & mask;
        const srcValue = (source >>> 0) & mask;
        const matched = accValue === oldValue;

        if (destinationRegister < 0) {
          // CMPXCHG is a write-cycle RMW operation even when comparison fails.
          // Check first so a protection fault cannot partially update flags/regs.
          this.checkMemory(address, bytes, true);
          this.host.store(address >>> 0, matched ? srcValue : oldValue, bytes);
        } else {
          const fieldMask = (mask << shift) >>> 0;
          const destination = this.r[destinationRegister].value >>> 0;
          const result = matched ? srcValue : oldValue;
          this.r[destinationRegister].value =
            (destination & ~fieldMask) | ((result << shift) & fieldMask) | 0;
        }

        if (!matched) {
          const wholeAccumulator = this.r[0].value >>> 0;
          const fieldMask = (mask << 0) >>> 0;
          this.r[0].value = (wholeAccumulator & ~fieldMask) | oldValue | 0;
        }
        this.flags(accValue, oldValue, (accValue - oldValue) & mask, 1, bits);
      },
      direction: (value) => {
        this.df = value ? 1 : 0;
      },
      string: (kind, bytes, repeat, sourceBase, at, next) => {
        if (![1, 2, 4].includes(bytes))
          throw Error('Unsupported string instruction width or operation');
        if (![0, 1, 2].includes(kind) || ![0, 1, 2, 3].includes(repeat))
          throw Error('Invalid string operation or repeat mode');
        let remaining = repeat ? this.r[1].value >>> 0 : 1;
        const count = Math.min(remaining, 1024);
        const delta = this.df ? -bytes : bytes;
        let completed = 0,
          terminated = false;
        for (; completed < count; completed++) {
          const source = (this.r[6].value + sourceBase) >>> 0;
          const destination = this.r[7].value >>> 0;
          if (kind === 0) this.checkMemory(source, bytes, false);
          if (kind === 2) {
            this.checkMemory(destination, bytes, false);
            const bits = bytes * 8;
            const mask = bits === 32 ? 0xffffffff : (1 << bits) - 1;
            const accumulator = (this.r[0].value & mask) >>> 0;
            const value = this.host.load(destination, bytes) >>> 0;
            this.flags(accumulator, value, (accumulator - value) & mask, 1, bits);
          } else {
            const value = kind === 0 ? this.host.load(source, bytes) : this.r[0].value;
            this.checkMemory(destination, bytes, true);
            this.host.store(destination, value, bytes);
          }
          if (kind === 0) this.r[6].value = (this.r[6].value + delta) | 0;
          this.r[7].value = (this.r[7].value + delta) | 0;
          if (repeat) this.r[1].value = ((this.r[1].value >>> 0) - 1) | 0;
          if (kind === 2 && ((repeat === 2 && !this.f.zf) || (repeat === 3 && this.f.zf))) {
            completed++;
            terminated = true;
            break;
          }
        }
        if (completed > 1) this.instructions += completed - 1;
        remaining -= completed;
        return repeat && remaining && !terminated ? at : next;
      },
    };
    this.r.forEach((r, i) => (this.host['r' + i] = r));
  }
  initialize() {
    return this.x87.initialize();
  }
  push(v) {
    const sp = (this.r[4].value - 4) >>> 0;
    this.write32(sp, v);
    this.r[4].value = sp;
  }
  pop() {
    const sp = this.r[4].value >>> 0,
      v = this.read32(sp);
    this.r[4].value = sp + 4;
    return v;
  }
  flags(a, b, r, k, width = 32) {
    const mask = width === 32 ? 0xffffffff : (1 << width) - 1;
    const au = (a & mask) >>> 0,
      bu = (b & mask) >>> 0,
      ru = (r & mask) >>> 0;
    const sign = width === 32 ? 0x80000000 : 1 << (width - 1),
      carry = this.f.cf;
    const originalKind = k,
      previousAf = this.af;
    if (k === 6) k = 0;
    if (k === 7) k = 1;
    this.f = {
      zf: +(ru === 0),
      sf: +!!(ru & sign),
      pf: +(((0x6996 >> ((ru ^ (ru >>> 4)) & 15)) & 1) === 0),
      cf: k === 0 || k === 3 ? +(au + bu > mask >>> 0) : k === 1 || k === 4 ? +(au < bu) : 0,
      of:
        k === 0 || k === 3
          ? +!!(~(au ^ bu) & (au ^ ru) & sign)
          : k === 1 || k === 4
            ? +!!((au ^ bu) & (au ^ ru) & sign)
            : 0,
    };
    if (k === 3 || k === 4) this.f.cf = carry;
    if (originalKind === 6 || originalKind === 7) {
      const signed = (x) => (width === 32 ? x | 0 : (x << (32 - width)) >> (32 - width));
      const exact =
        originalKind === 6 ? signed(au) + signed(bu) + carry : signed(au) - signed(bu) - carry;
      this.f.cf = originalKind === 6 ? +(au + bu + carry > mask >>> 0) : +(au < bu + carry);
      this.f.of = +(exact < -(2 ** (width - 1)) || exact >= 2 ** (width - 1));
    }
    // ADD/SUB/ADC/SBB/CMP/INC/DEC/NEG define AF as the carry or borrow
    // across bit 3. Logical, shift, and multiply instructions leave AF
    // undefined, so retain its prior internal value without promising it.
    this.af = [0, 1, 3, 4, 6, 7].includes(originalKind) ? +!!((au ^ bu ^ ru) & 0x10) : previousAf;
    if (k === 5) {
      const signed = (x) => BigInt(width === 32 ? x | 0 : (x << (32 - width)) >> (32 - width));
      const product = signed(a) * signed(b);
      this.f.cf = this.f.of = +(product !== BigInt.asIntN(width, product));
    }
  }
  shift(value, count, kind, width) {
    count &= 31;
    if (!count) return value;
    const mask = width === 32 ? 0xffffffff : (1 << width) - 1,
      v = (value & mask) >>> 0;
    let result, carry;
    if (kind === 0) {
      result = v << count;
      carry = count <= width ? (v >>> (width - count)) & 1 : 0;
    } else if (kind === 1) {
      result = v >>> count;
      carry = (v >>> (count - 1)) & 1;
    } else {
      const signed = width === 32 ? v | 0 : (v << (32 - width)) >> (32 - width);
      result = signed >> count;
      carry = (signed >> (count - 1)) & 1;
    }
    this.flags(v, count, result, 2, width);
    this.f.cf = carry;
    if (count === 1)
      this.f.of = kind === 0 ? this.f.sf ^ carry : kind === 1 ? (v >>> (width - 1)) & 1 : 0;
    return result & mask;
  }
  rotateCarry(value, count, kind, width) {
    if (![8, 16, 32].includes(width) || ![0, 1].includes(kind))
      throw Error('Invalid rotate-through-carry operation');
    count &= 31;
    if (width < 32) count %= width + 1;
    const mask = width === 32 ? 0xffffffff : (1 << width) - 1;
    const operand = (value & mask) >>> 0;
    if (!count) return operand;
    const bits = BigInt(width + 1);
    const combinedMask = (1n << bits) - 1n;
    let combined = (BigInt(operand) << 1n) | BigInt(this.f.cf);
    const rotation = BigInt(count);
    combined =
      kind === 0
        ? ((combined << rotation) | (combined >> (bits - rotation))) & combinedMask
        : ((combined >> rotation) | (combined << (bits - rotation))) & combinedMask;
    const result = Number((combined >> 1n) & BigInt(mask)) >>> 0;
    this.f.cf = Number(combined & 1n);
    if (count === 1) {
      const msb = (result >>> (width - 1)) & 1;
      this.f.of = kind === 0 ? msb ^ this.f.cf : msb ^ ((result >>> (width - 2)) & 1);
    }
    return result;
  }
  wideMath(operand, kind, width) {
    if (width !== 32) throw Error('Wide multiply/divide currently requires 32-bit operands');
    const a = this.r[0].value >>> 0,
      d = this.r[2].value >>> 0,
      b = operand >>> 0;
    if (kind <= 1) {
      const signed = kind === 1;
      const product = (signed ? BigInt(a | 0) : BigInt(a)) * (signed ? BigInt(b | 0) : BigInt(b));
      const raw = BigInt.asUintN(64, product);
      this.r[2].value = Number(raw >> 32n) | 0;
      this.f.cf = this.f.of = +(signed
        ? product !== BigInt.asIntN(32, product)
        : product > 0xffffffffn);
      return Number(raw & 0xffffffffn) | 0;
    }
    if (!b) throw Error('Guest integer divide by zero');
    const signed = kind === 3;
    const raw = (BigInt(d) << 32n) | BigInt(a),
      dividend = signed ? BigInt.asIntN(64, raw) : raw,
      divisor = signed ? BigInt(b | 0) : BigInt(b);
    const quotient = dividend / divisor,
      remainder = dividend % divisor;
    if (quotient < (signed ? -0x80000000n : 0n) || quotient > (signed ? 0x7fffffffn : 0xffffffffn))
      throw Error('Guest integer divide overflow');
    this.r[2].value = Number(BigInt.asIntN(32, remainder));
    return Number(BigInt.asIntN(32, quotient));
  }
  condition(c) {
    const { cf, zf, sf, of, pf } = this.f;
    return +[
      of,
      !of,
      cf,
      !cf,
      zf,
      !zf,
      cf || zf,
      !cf && !zf,
      sf,
      !sf,
      pf,
      !pf,
      sf !== of,
      sf === of,
      zf || sf !== of,
      !zf && sf === of,
    ][c];
  }
  compile(ip) {
    const {
      Decoder,
      DecoderOptions,
      Register: R,
      OpKind: K,
      Mnemonic: M,
      MemorySizeExt,
    } = this.iced;
    const range = this.ranges.find(([a, b]) => ip >= a && ip < b);
    if (!range) throw Error(`Execute outside code at 0x${ip.toString(16)}`);
    const bytes = new Uint8Array(this.memory.buffer, ip, Math.min(1024, range[1] - ip));
    const d = new Decoder(32, bytes, DecoderOptions.None);
    d.ip = BigInt(ip);
    let code = [],
      count = 0,
      end = ip,
      usesX87 = false;
    const regInfo = (r) => {
      if (r >= R.EAX && r <= R.EDI) return { index: r - R.EAX, width: 32, shift: 0 };
      if (r >= R.AX && r <= R.DI) return { index: r - R.AX, width: 16, shift: 0 };
      if (r >= R.AL && r <= R.BL) return { index: r - R.AL, width: 8, shift: 0 };
      if (r >= R.AH && r <= R.BH) return { index: r - R.AH, width: 8, shift: 8 };
      throw Error(`Unsupported register ${r}`);
    };
    const reg = (r) => {
      const info = regInfo(r);
      if (info.width !== 32) throw Error('16-bit address mode unsupported');
      return info.index;
    };
    const readReg = (r) => {
      const info = regInfo(r);
      let code = get(info.index);
      if (info.shift) code.push(...constant(info.shift), 0x76);
      if (info.width < 32) code.push(...constant((1 << info.width) - 1), 0x71);
      return code;
    };
    const width = (i, n) =>
      i.opKind(n) === K.Register
        ? regInfo(i.opRegister(n)).width
        : i.opKind(n) === K.Memory
          ? MemorySizeExt.size(i.memorySize) * 8
          : 32;
    const addr = (i, applySegment = true, popEspBase = false) => {
      if (
        i.segmentPrefix !== R.None &&
        i.segmentPrefix !== R.DS &&
        i.segmentPrefix !== R.SS &&
        i.segmentPrefix !== R.CS &&
        i.segmentPrefix !== R.ES &&
        i.segmentPrefix !== R.FS
      )
        throw Error('Unsupported segment override');
      let a = constant(Number(i.memoryDisplacement));
      if (applySegment && i.segmentPrefix === R.FS) {
        if (!this.fsBase) throw Error('FS requires guest TEB');
        a.push(...constant(this.fsBase), 0x6a);
      }
      if (i.memoryBase !== R.None) {
        a.push(...get(reg(i.memoryBase)));
        if (popEspBase && i.memoryBase === R.ESP) a.push(...constant(4), 0x6a);
        a.push(0x6a);
      }
      if (i.memoryIndex !== R.None)
        a.push(...get(reg(i.memoryIndex)), ...constant(i.memoryIndexScale), 0x6c, 0x6a);
      return a;
    };
    const operand = (i, n) => {
      const k = i.opKind(n);
      if (k === K.Register) return readReg(i.opRegister(n));
      if (k === K.Immediate32) return constant(i.immediate32);
      if (k === K.Immediate16) return constant(i.immediate16);
      if (k === K.Immediate8) return constant(i.immediate8);
      if (k === K.Immediate8to32) return constant(i.immediate8to32);
      if (k === K.Immediate8to16) return constant(i.immediate8to16);
      if (k === K.NearBranch32) return constant(i.nearBranch32);
      if (k === K.Memory) {
        const bytes = width(i, n) / 8;
        if (![1, 2, 4].includes(bytes)) throw Error('Unsupported memory width');
        return [...addr(i), ...constant(bytes), ...call(Host.load)];
      }
      throw Error(`Unsupported operand kind ${k}`);
    };
    const write = (i, n, value) => {
      if (i.opKind(n) === K.Register) {
        const info = regInfo(i.opRegister(n));
        if (info.width === 32) return [...value, ...set(info.index)];
        const mask = (1 << info.width) - 1;
        return [
          ...get(info.index),
          ...constant(~(mask << info.shift)),
          0x71,
          ...value,
          ...constant(mask),
          0x71,
          ...constant(info.shift),
          0x74,
          0x72,
          ...set(info.index),
        ];
      }
      if (i.opKind(n) === K.Memory) {
        const bytes = width(i, n) / 8;
        if (![1, 2, 4].includes(bytes)) throw Error('Unsupported store width');
        return [...addr(i), ...value, ...constant(bytes), ...call(Host.store)];
      }
      throw Error('Unsupported destination');
    };
    try {
      while (d.canDecode && count < 64) {
        const i = d.decode();
        try {
          const at = Number(i.ip),
            next = Number(i.nextIP);
          end = next;
          count++;
          if (i.isInvalid || next > range[1]) throw Error('Invalid or truncated x86 instruction');
          const m = i.mnemonic;
          const simd = classifySse(i, this.iced);
          const x87 = classifyX87(i, this.iced);
          if (i.hasLockPrefix) {
            const lockable = [
              M.Add,
              M.Adc,
              M.And,
              M.Or,
              M.Sbb,
              M.Sub,
              M.Xor,
              M.Inc,
              M.Dec,
              M.Neg,
              M.Not,
              M.Cmpxchg,
            ].includes(m);
            const memoryDestination = i.opCount > 0 && i.opKind(0) === K.Memory;
            const memoryXchg =
              m === M.Xchg &&
              (i.opKind(0) === K.Memory || (i.opCount > 1 && i.opKind(1) === K.Memory));
            if (!(memoryDestination && lockable) && !memoryXchg)
              throw Error('LOCK prefix requires a supported memory-destination RMW instruction');
          }
          const stringMov = [M.Movsb, M.Movsw, M.Movsd].includes(m);
          const stringStos = [M.Stosb, M.Stosw, M.Stosd].includes(m);
          const stringScas = [M.Scasb, M.Scasw, M.Scasd].includes(m);
          const stringOp = stringMov || stringStos || stringScas;
          if ((i.hasRepPrefix || i.hasRepnePrefix) && !simd && !stringOp)
            throw Error('Repeat prefix unsupported');
          if (stringOp) {
            if (i.hasRepnePrefix && !stringScas)
              throw Error('REPNE string operations are unsupported');
            const raw = new Uint8Array(this.memory.buffer, at, next - at);
            if (raw.includes(0x67)) throw Error('16-bit string address mode unsupported');
            if (i.opCount !== 2) throw Error('Unexpected string instruction operands');
            if (!stringScas && i.opKind(0) !== K.MemoryESEDI)
              throw Error('Unexpected string destination operand');
            if (stringMov && i.opKind(1) !== K.MemorySegESI)
              throw Error('Unexpected MOVS source operand');
            if (stringStos && i.opKind(1) !== K.Register)
              throw Error('Unexpected STOS accumulator operand');
            if (stringScas && (i.opKind(0) !== K.Register || i.opKind(1) !== K.MemoryESEDI))
              throw Error('Unexpected SCAS operands');
            if (
              !stringScas &&
              i.segmentPrefix !== R.None &&
              i.segmentPrefix !== R.DS &&
              i.segmentPrefix !== R.FS
            )
              throw Error('Unsupported string source segment override');
            if (stringScas && i.segmentPrefix !== R.None && i.segmentPrefix !== R.ES)
              throw Error('Unsupported SCAS segment override');
            if (i.segmentPrefix === R.FS && !this.fsBase)
              throw Error('FS string source requires guest TEB');
            const bytes = MemorySizeExt.size(i.memorySize);
            if (![1, 2, 4].includes(bytes)) throw Error('Unsupported string operand width');
            const sourceBase = stringMov && i.segmentPrefix === R.FS ? this.fsBase : 0;
            const repeat = stringScas
              ? i.hasRepnePrefix
                ? 3
                : i.hasRepPrefix
                  ? 2
                  : 0
              : i.hasRepPrefix
                ? 1
                : 0;
            code.push(
              ...constant(stringMov ? 0 : stringStos ? 1 : 2),
              ...constant(bytes),
              ...constant(repeat),
              ...constant(sourceBase),
              ...constant(at),
              ...constant(next),
              ...call(Host.string),
              0x0f,
            );
            break;
          } else if (m === M.Cld || m === M.Std) {
            if (i.hasRepPrefix || i.hasRepnePrefix) throw Error('Repeat prefix unsupported');
            code.push(...constant(m === M.Std ? 1 : 0), ...call(Host.direction));
          } else if (simd) {
            code.push(
              ...constant(simd.op | (simd.aligned ? 0x100 : 0)),
              ...constant(simd.dst),
              ...constant(simd.src),
              ...(simd.addressOperand < 0 ? constant(0) : addr(i)),
              ...constant(simd.immediate ?? 0),
              ...call(Host.simd),
            );
          } else if (x87) {
            if (i.hasLockPrefix || i.hasRepPrefix || i.hasRepnePrefix)
              throw Error('Unsupported prefix on x87 instruction');
            code.push(
              ...constant(x87.op),
              ...constant(x87.a),
              ...constant(x87.b),
              ...(x87.memory ? addr(i) : constant(0)),
              ...constant(x87.width),
              ...constant(x87.flags),
              ...call(Host.x87),
            );
            usesX87 = true;
          } else if (m === M.Mov) code.push(...write(i, 0, operand(i, 1)));
          else if (m === M.Sahf) {
            code.push(
              ...get(0),
              ...constant(8),
              0x76,
              ...constant(1),
              ...call(Host.flagByte),
              0x1a,
            );
          } else if (m === M.Lahf) {
            code.push(
              ...get(0),
              ...constant(~0xff00),
              0x71,
              ...constant(0),
              ...constant(0),
              ...call(Host.flagByte),
              ...constant(8),
              0x74,
              0x72,
              ...set(0),
            );
          } else if (m === M.Cpuid) {
            if (i.opCount !== 0) throw Error('Unexpected CPUID operands');
            code.push(...get(0), ...get(1), ...call(Host.cpuid));
          } else if (m === M.Rdtsc) {
            if (i.opCount !== 0) throw Error('Unexpected RDTSC operands');
            code.push(...call(Host.timestamp));
          } else if (m === M.Movzx || m === M.Movsx) {
            let value = operand(i, 1);
            if (m === M.Movsx) {
              const shift = 32 - width(i, 1);
              value.push(...constant(shift), 0x74, ...constant(shift), 0x75);
            }
            code.push(...write(i, 0, value));
          } else if (m === M.Not)
            code.push(...write(i, 0, [...operand(i, 0), ...constant(-1), 0x73]));
          else if (m === M.Neg) {
            code.push(
              ...operand(i, 0),
              0x21,
              1,
              ...constant(0),
              ...local(1),
              0x6b,
              0x21,
              2,
              ...write(i, 0, local(2)),
              ...constant(0),
              ...local(1),
              ...local(2),
              ...constant(1),
              ...constant(width(i, 0)),
              ...call(Host.flags),
            );
          } else if ([M.Shl, M.Shr, M.Sar].includes(m)) {
            code.push(
              ...write(i, 0, [
                ...operand(i, 0),
                ...operand(i, 1),
                ...constant(m === M.Shl ? 0 : m === M.Shr ? 1 : 2),
                ...constant(width(i, 0)),
                ...call(Host.shift),
              ]),
            );
          } else if ([M.Rcl, M.Rcr].includes(m)) {
            const bits = width(i, 0);
            if (![8, 16, 32].includes(bits)) throw Error('RCL/RCR require an 8/16/32-bit operand');
            const rotated = [
              ...operand(i, 0),
              ...operand(i, 1),
              ...constant(m === M.Rcl ? 0 : 1),
              ...constant(bits),
              ...call(Host.rotateCarry),
            ];
            if (i.opKind(0) === K.Memory) {
              code.push(
                ...addr(i),
                0x21,
                2,
                ...local(2),
                ...operand(i, 0),
                ...operand(i, 1),
                ...constant(m === M.Rcl ? 0 : 1),
                ...constant(bits),
                ...call(Host.rotateCarryStore),
              );
            } else code.push(...write(i, 0, rotated));
          } else if (m === M.Imul && i.opCount >= 2) {
            code.push(
              ...operand(i, i.opCount === 3 ? 1 : 0),
              0x21,
              0,
              ...operand(i, i.opCount === 3 ? 2 : 1),
              0x21,
              1,
              ...local(0),
              ...local(1),
              0x6c,
              0x21,
              2,
              ...write(i, 0, local(2)),
              ...local(0),
              ...local(1),
              ...local(2),
              ...constant(5),
              ...constant(width(i, 0)),
              ...call(Host.flags),
            );
          } else if ([M.Mul, M.Imul, M.Div, M.Idiv].includes(m) && i.opCount === 1)
            code.push(
              ...operand(i, 0),
              ...constant(m === M.Mul ? 0 : m === M.Imul ? 1 : m === M.Div ? 2 : 3),
              ...constant(width(i, 0)),
              ...call(Host.wideMath),
              ...set(0),
            );
          else if (i.conditionCode && i.flowControl === this.iced.FlowControl.Next) {
            if (i.opCount === 1 && width(i, 0) === 8)
              code.push(
                ...write(i, 0, [...constant(i.conditionCode - 1), ...call(Host.condition)]),
              );
            else if (i.opCount === 2 && i.opKind(0) === K.Register) {
              code.push(
                ...operand(i, 1),
                0x21,
                1,
                ...write(i, 0, [
                  ...constant(i.conditionCode - 1),
                  ...call(Host.condition),
                  0x04,
                  0x7f,
                  ...local(1),
                  0x05,
                  ...operand(i, 0),
                  0x0b,
                ]),
              );
            } else throw Error('Unsupported conditional instruction');
          } else if (m === M.Cdq) code.push(...get(0), ...constant(31), 0x75, ...set(2));
          else if (m === M.Cwde)
            code.push(...get(0), ...constant(16), 0x74, ...constant(16), 0x75, ...set(0));
          else if (m === M.Bsf || m === M.Bsr) {
            const bits = width(i, 0);
            if (i.opKind(0) !== K.Register || ![16, 32].includes(bits) || width(i, 1) !== bits)
              throw Error('Bit scan requires a 16/32-bit register destination and matching source');
            code.push(
              ...write(i, 0, [
                ...operand(i, 1),
                ...operand(i, 0),
                ...constant(Number(m === M.Bsr)),
                ...call(Host.bitScan),
              ]),
            );
          } else if (m === M.Bswap) {
            if (i.opCount !== 1 || i.opKind(0) !== K.Register || width(i, 0) !== 32)
              throw Error('BSWAP requires a 32-bit register (16-bit form is undefined)');
            // Swap bytes within each word, then exchange the two words. Flags are unchanged.
            code.push(
              ...operand(i, 0),
              0x21,
              0,
              ...write(i, 0, [
                ...local(0),
                ...constant(0x00ff00ff),
                0x71,
                ...constant(8),
                0x74,
                ...local(0),
                ...constant(8),
                0x76,
                ...constant(0x00ff00ff),
                0x71,
                0x72,
                ...constant(16),
                0x77,
              ]),
            );
          } else if ([M.Bt, M.Bts, M.Btr, M.Btc].includes(m)) {
            if (i.opCount !== 2 || i.opKind(0) !== K.Register)
              throw Error('Memory bitstring operations unsupported');
            const bits = width(i, 0);
            if (![16, 32].includes(bits)) throw Error('BT register operand must be 16 or 32 bits');
            const indexKind = i.opKind(1);
            if (!((indexKind === K.Register && width(i, 1) === bits) || indexKind === K.Immediate8))
              throw Error('BT bit index must be a same-width register or imm8');
            code.push(...operand(i, 0), ...operand(i, 1), ...constant(bits), ...call(Host.bitTest));
            if (m !== M.Bt) {
              const mask = [...constant(1), ...operand(i, 1), ...constant(bits - 1), 0x71, 0x74];
              const value =
                m === M.Bts
                  ? [...operand(i, 0), ...mask, 0x72]
                  : m === M.Btr
                    ? [...operand(i, 0), ...mask, ...constant(-1), 0x73, 0x71]
                    : [...operand(i, 0), ...mask, 0x73];
              code.push(...write(i, 0, value));
            }
          } else if (m === M.Xchg) {
            const memoryIndex = i.opKind(0) === K.Memory ? 0 : i.opKind(1) === K.Memory ? 1 : -1;
            if (memoryIndex !== -1) code.push(...addr(i), 0x21, 2);
            code.push(...operand(i, 0), 0x21, 0, ...operand(i, 1), 0x21, 1);
            const swapWrite = (n, val) =>
              memoryIndex === n
                ? [...local(2), ...val, ...constant(width(i, n) / 8), ...call(Host.store)]
                : write(i, n, val);
            code.push(...swapWrite(0, local(1)), ...swapWrite(1, local(0)));
          } else if (m === M.Cmpxchg) {
            if (
              i.opCount !== 2 ||
              ![K.Register, K.Memory].includes(i.opKind(0)) ||
              i.opKind(1) !== K.Register
            )
              throw Error('CMPXCHG requires a register or memory destination and register source');
            const bits = width(i, 0);
            if (![8, 16, 32].includes(bits) || width(i, 1) !== bits)
              throw Error('CMPXCHG operands must have matching 8/16/32-bit widths');
            const destination = i.opKind(0) === K.Register ? regInfo(i.opRegister(0)) : null;
            code.push(
              ...operand(i, 0),
              ...operand(i, 1),
              ...get(0),
              ...constant(bits),
              ...constant(destination?.index ?? -1),
              ...constant(destination?.shift ?? 0),
              ...(destination ? constant(0) : addr(i)),
              ...call(Host.cmpxchg),
            );
          } else if (m === M.Lea) code.push(...write(i, 0, addr(i, false)));
          else if (m === M.Push) {
            if (i.stackPointerIncrement !== -4) throw Error('16-bit PUSH unsupported');
            code.push(...operand(i, 0), ...call(2));
          } else if (m === M.Pop) {
            if (i.stackPointerIncrement !== 4) throw Error('16-bit POP unsupported');
            if (i.opKind(0) === K.Register) code.push(...write(i, 0, call(Host.pop)));
            else if (i.opKind(0) === K.Memory) {
              if (width(i, 0) !== 32) throw Error('16-bit POP unsupported');
              // The memory EA uses ESP+4 when ESP is its base. Preflight and
              // perform the store before committing ESP so a write fault leaves
              // the architectural register state restartable.
              code.push(...addr(i, true, true), ...constant(4), ...call(Host.popStore));
            } else throw Error('Unsupported POP destination');
          } else if (
            [M.Add, M.Sub, M.Adc, M.Sbb, M.Xor, M.And, M.Or, M.Cmp, M.Test, M.Inc, M.Dec].includes(
              m,
            )
          ) {
            const unary = m === M.Inc || m === M.Dec;
            const op =
              m === M.Add || m === M.Inc || m === M.Adc
                ? 0x6a
                : m === M.Sub || m === M.Cmp || m === M.Dec || m === M.Sbb
                  ? 0x6b
                  : m === M.Xor
                    ? 0x73
                    : m === M.Or
                      ? 0x72
                      : 0x71;
            const kind =
              m === M.Adc
                ? 6
                : m === M.Sbb
                  ? 7
                  : m === M.Inc
                    ? 3
                    : m === M.Dec
                      ? 4
                      : op === 0x6a
                        ? 0
                        : op === 0x6b
                          ? 1
                          : 2;
            code.push(
              ...operand(i, 0),
              0x21,
              0,
              ...(unary ? constant(1) : operand(i, 1)),
              0x21,
              1,
              ...local(0),
              ...local(1),
              op,
              ...(m === M.Adc || m === M.Sbb ? [...constant(2), ...call(Host.condition), op] : []),
              0x21,
              2,
            );
            if (m !== M.Cmp && m !== M.Test) code.push(...write(i, 0, local(2)));
            code.push(
              ...local(0),
              ...local(1),
              ...local(2),
              ...constant(kind),
              ...constant(width(i, 0)),
              ...call(4),
            );
          } else if (m === M.Call) {
            code.push(...operand(i, 0), 0x21, 0, ...constant(next), ...call(2), ...local(0), 0x0f);
            break;
          } else if (m === M.Jmp) {
            code.push(...operand(i, 0), 0x0f);
            break;
          } else if (i.flowControl === this.iced.FlowControl.ConditionalBranch && i.conditionCode) {
            code.push(
              ...constant(i.conditionCode - 1),
              ...call(5),
              0x04,
              0x7f,
              ...operand(i, 0),
              0x05,
              ...constant(next),
              0x0b,
              0x0f,
            );
            break;
          } else if (m === M.Loop) {
            code.push(
              ...get(1),
              ...constant(1),
              0x6b,
              ...set(1),
              ...get(1),
              0x04,
              0x7f,
              ...operand(i, 0),
              0x05,
              ...constant(next),
              0x0b,
              0x0f,
            );
            break;
          } else if (m === M.Ret) {
            if (i.stackPointerIncrement !== 4 + (i.opCount ? i.immediate16 : 0))
              throw Error('16-bit RET unsupported');
            code.push(...call(3), 0x21, 0);
            if (i.opCount) code.push(...get(4), ...constant(i.immediate16), 0x6a, ...set(4));
            code.push(...local(0), 0x0f);
            break;
          } else if (m === M.Leave) {
            if (i.code !== this.iced.Code.Leaved) throw Error('16-bit LEAVE unsupported');
            code.push(...get(5), ...set(4), ...call(3), ...set(5));
          } else if (m !== M.Nop && m !== M.Pause)
            throw Error(`Unsupported instruction ${i.toString()} at 0x${at.toString(16)}`);
        } finally {
          i.free();
        }
      }
      code.push(...constant(end));
      const binary = moduleBytes(code);
      const run = new WebAssembly.Instance(new WebAssembly.Module(binary), { h: this.host }).exports
        .run;
      if (this.cache.size >= 4096) throw Error('Compiled block cache limit exceeded');
      this.compiledBytes += binary.length;
      const block = { run, count, bytes: binary.length };
      this.cache.set(ip, block);
      if (usesX87) this.x87Blocks.add(ip);
      return block;
    } catch (error) {
      throw Error(`x86 block 0x${ip.toString(16)}: ${error.message}`);
    } finally {
      d.free();
    }
  }
  step(ip) {
    const block = this.cache.get(ip) || this.compile(ip);
    this.instructions += block.count;
    return block.run() >>> 0;
  }
  prepare(ip) {
    if (!this.cache.has(ip)) this.compile(ip);
    return this.x87Blocks.has(ip) ? this.initialize() : null;
  }
  clearCache() {
    this.cache.clear();
    this.x87Blocks.clear();
  }
  dispose() {
    this.x87.dispose();
  }
}
