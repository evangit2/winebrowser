// Direct x86 basic-block -> WebAssembly emitter. iced decodes; it does not execute.
import { moduleBytes, constant, get, set, local, call } from './wasm.js';
export class CPU {
  constructor(iced, { memory, read32, write32, executableRanges, stackTop = 0x3fff000 }) {
    this.iced = iced;
    this.memory = memory;
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
      load: (a) => read32(a >>> 0),
      store: (a, v) => write32(a >>> 0, v),
      push: (v) => this.push(v),
      pop: () => this.pop(),
      flags: (a, b, r, k) => this.flags(a, b, r, k),
      condition: (c) => this.condition(c),
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
  flags(a, b, r, k) {
    const au = a >>> 0,
      bu = b >>> 0,
      ru = r >>> 0;
    const cf = this.f.cf;
    this.f = {
      zf: +(ru === 0),
      sf: ru >>> 31,
      pf: +(((0x6996 >> ((ru ^ (ru >>> 4)) & 15)) & 1) === 0),
      cf: k === 0 || k === 3 ? +(au + bu > 0xffffffff) : k === 1 || k === 4 ? +(au < bu) : 0,
      of:
        k === 0 || k === 3
          ? (~(a ^ b) & (a ^ r)) >>> 31
          : k === 1 || k === 4
            ? ((a ^ b) & (a ^ r)) >>> 31
            : 0,
    };
    if (k === 3 || k === 4) this.f.cf = cf;
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
    const reg = (r) => {
      if (r < R.EAX || r > R.EDI) throw Error('Only 32-bit general registers are supported');
      return r - R.EAX;
    };
    const addr = (i) => {
      if (i.segmentPrefix !== R.None && i.segmentPrefix !== R.DS && i.segmentPrefix !== R.SS)
        throw Error('Segment override requires guest TEB/segment support');
      let a = constant(Number(i.memoryDisplacement));
      if (i.memoryBase !== R.None) a.push(...get(reg(i.memoryBase)), 0x6a);
      if (i.memoryIndex !== R.None)
        a.push(...get(reg(i.memoryIndex)), ...constant(i.memoryIndexScale), 0x6c, 0x6a);
      return a;
    };
    const operand = (i, n) => {
      const k = i.opKind(n);
      if (k === K.Register) return get(reg(i.opRegister(n)));
      if (k === K.Immediate32) return constant(i.immediate32);
      if (k === K.Immediate8to32) return constant(i.immediate8to32);
      if (k === K.NearBranch32) return constant(i.nearBranch32);
      if (k === K.Memory) {
        if (MemorySizeExt.size(i.memorySize) !== 4)
          throw Error('Only 32-bit memory operands supported');
        return [...addr(i), ...call(0)];
      }
      throw Error(`Unsupported operand kind ${k}`);
    };
    const write = (i, n, value) => {
      if (i.opKind(n) === K.Register) return [...value, ...set(reg(i.opRegister(n)))];
      if (i.opKind(n) === K.Memory) {
        if (MemorySizeExt.size(i.memorySize) !== 4) throw Error('Only 32-bit stores supported');
        return [...addr(i), ...value, ...call(1)];
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
          if (i.hasLockPrefix || i.hasRepPrefix || i.hasRepnePrefix)
            throw Error('Atomic/repeat prefix unsupported');
          const m = i.mnemonic;
          if (m === M.Mov) code.push(...write(i, 0, operand(i, 1)));
          else if (m === M.Lea) code.push(...write(i, 0, addr(i)));
          else if (m === M.Push) code.push(...operand(i, 0), ...call(2));
          else if (m === M.Pop) {
            if (i.opKind(0) !== K.Register) throw Error('Memory pop unsupported');
            code.push(...write(i, 0, call(3)));
          } else if ([M.Add, M.Sub, M.Xor, M.And, M.Or, M.Cmp, M.Test, M.Inc, M.Dec].includes(m)) {
            const unary = m === M.Inc || m === M.Dec;
            const op =
              m === M.Add || m === M.Inc
                ? 0x6a
                : m === M.Sub || m === M.Cmp || m === M.Dec
                  ? 0x6b
                  : m === M.Xor
                    ? 0x73
                    : m === M.Or
                      ? 0x72
                      : 0x71;
            const kind = m === M.Inc ? 3 : m === M.Dec ? 4 : op === 0x6a ? 0 : op === 0x6b ? 1 : 2;
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
              0x21,
              2,
            );
            if (m !== M.Cmp && m !== M.Test) code.push(...write(i, 0, local(2)));
            code.push(...local(0), ...local(1), ...local(2), ...constant(kind), ...call(4));
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
          } else if (m !== M.Nop)
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
