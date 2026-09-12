// Direct x86 basic-block -> WebAssembly emitter. iced decodes; it does not execute.
import { moduleBytes, constant, get, set, local, call, Host } from './wasm.js';
export class CPU {
  constructor(
    iced,
    { memory, read32, write32, read, write, executableRanges, stackTop = 0x3fff000, fsBase = 0 },
  ) {
    if (typeof SharedArrayBuffer !== 'undefined' && memory.buffer instanceof SharedArrayBuffer)
      throw Error('Shared WebAssembly.Memory is unsupported until host atomics are implemented');
    this.iced = iced;
    this.memory = memory;
    this.fsBase = fsBase;
    this.read32 = read32;
    this.write32 = write32;
    this.r = Array.from(
      { length: 8 },
      () => new WebAssembly.Global({ value: 'i32', mutable: true }, 0),
    );
    this.r[4].value = stackTop;
    this.ranges = executableRanges;
    this.cache = new Map();
    this.compiledBytes = 0;
    this.instructions = 0;
    this.f = { cf: 0, zf: 0, sf: 0, of: 0, pf: 0 };
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
      flags: (a, b, r, k, width) => this.flags(a, b, r, k, width),
      shift: (value, count, kind, width) => this.shift(value, count, kind, width),
      wideMath: (operand, kind, width) => this.wideMath(operand, kind, width),
      condition: (c) => this.condition(c),
      bitTest: (value, index, width) => {
        this.f.cf = (value >>> (index & (width - 1))) & 1;
      },
    };
    this.r.forEach((r, i) => (this.host['r' + i] = r));
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
    const originalKind = k;
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
      end = ip;
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
    const addr = (i, applySegment = true) => {
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
      if (i.memoryBase !== R.None) a.push(...get(reg(i.memoryBase)), 0x6a);
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
            ].includes(m);
            const memoryDestination = i.opCount > 0 && i.opKind(0) === K.Memory;
            const memoryXchg =
              m === M.Xchg &&
              (i.opKind(0) === K.Memory || (i.opCount > 1 && i.opKind(1) === K.Memory));
            if (!(memoryDestination && lockable) && !memoryXchg)
              throw Error('LOCK prefix requires a supported memory-destination RMW instruction');
          }
          if (i.hasRepPrefix || i.hasRepnePrefix) throw Error('Repeat prefix unsupported');
          if (m === M.Mov) code.push(...write(i, 0, operand(i, 1)));
          else if (m === M.Movzx || m === M.Movsx) {
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
          else if ([M.Bt, M.Bts, M.Btr, M.Btc].includes(m)) {
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
          } else if (m === M.Lea) code.push(...write(i, 0, addr(i, false)));
          else if (m === M.Push) {
            if (i.stackPointerIncrement !== -4) throw Error('16-bit PUSH unsupported');
            code.push(...operand(i, 0), ...call(2));
          } else if (m === M.Pop) {
            if (i.stackPointerIncrement !== 4) throw Error('16-bit POP unsupported');
            if (i.opKind(0) !== K.Register) throw Error('Memory pop unsupported');
            code.push(...write(i, 0, call(3)));
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
}
