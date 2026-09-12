// Selected SSE data movement and integer-lane operations used by Wine's heap.
export const SIMD_OP = Object.freeze({
  MOVD_XMM_GPR: 1,
  MOVD_XMM_MEM: 2,
  MOVD_GPR_XMM: 3,
  MOVD_MEM_XMM: 4,
  MOVQ_XMM_XMM: 5,
  MOVQ_XMM_MEM: 6,
  MOVQ_MEM_XMM: 7,
  MOV128_XMM_XMM: 8,
  MOV128_XMM_MEM: 9,
  MOV128_MEM_XMM: 10,
  PUNPCKLDQ_XMM_XMM: 11,
  PUNPCKLDQ_XMM_MEM: 12,
  PUNPCKLQDQ_XMM_XMM: 13,
  PUNPCKLQDQ_XMM_MEM: 14,
  PXOR_XMM_XMM: 15,
  PXOR_XMM_MEM: 16,
  PSHUFD_XMM_XMM: 17,
  PSHUFD_XMM_MEM: 18,
  MOVDDUP_XMM_XMM: 19,
  MOVDDUP_XMM_MEM: 20,
});

const ALIGNED_MOVES = new Set(['Movdqa', 'Movaps']);

const xmmIndex = (instruction, operand, kind, register) => {
  if (instruction.opKind(operand) !== kind.Register) return null;
  const value = instruction.opRegister(operand);
  return value >= register.XMM0 && value <= register.XMM7 ? value - register.XMM0 : null;
};

const gprIndex = (instruction, operand, kind, register) => {
  if (instruction.opKind(operand) !== kind.Register) return null;
  const value = instruction.opRegister(operand);
  return value >= register.EAX && value <= register.EDI ? value - register.EAX : null;
};

const memoryBits = (instruction, operand, kind, MemorySizeExt) =>
  instruction.opKind(operand) === kind.Memory ? MemorySizeExt.size(instruction.memorySize) * 8 : 0;

/** Return a verified host-operation descriptor for supported SSE encodings. */
export function classifySse(instruction, iced) {
  const { Code: C, OpKind: K, Register: R, MemorySizeExt } = iced;
  const xmm = (n) => xmmIndex(instruction, n, K, R);
  const gpr = (n) => gprIndex(instruction, n, K, R);
  const mem32 = (n) => memoryBits(instruction, n, K, MemorySizeExt) === 32;
  const mem64 = (n) => memoryBits(instruction, n, K, MemorySizeExt) === 64;
  const mem128 = (n) => memoryBits(instruction, n, K, MemorySizeExt) === 128;
  const source = (n, memoryWidth) => {
    const reg = xmm(n);
    if (reg !== null) return { reg, memory: false };
    if (memoryWidth(n)) return { reg: 0, memory: true };
    return null;
  };
  const destination = (n, memoryWidth) => {
    const reg = xmm(n);
    if (reg !== null) return { reg, memory: false };
    if (memoryWidth(n)) return { reg: 0, memory: true };
    return null;
  };
  const vector = (opReg, opMem, dstOperand = 0, srcOperand = 1) => {
    const dst = destination(dstOperand, mem128);
    const src = source(srcOperand, mem128);
    if (!dst || !src || (dst.memory && src.memory)) return null;
    if (dst.memory)
      return { op: opMem, dst: 0, src: src.reg, addressOperand: dstOperand, aligned: true };
    if (src.memory)
      return { op: opMem, dst: dst.reg, src: 0, addressOperand: srcOperand, aligned: true };
    return { op: opReg, dst: dst.reg, src: src.reg, addressOperand: -1, aligned: true };
  };

  switch (instruction.code) {
    case C.Movd_xmm_rm32: {
      const dst = xmm(0);
      if (dst === null) return null;
      const src = gpr(1);
      if (src !== null) return { op: SIMD_OP.MOVD_XMM_GPR, dst, src, addressOperand: -1 };
      if (mem32(1)) return { op: SIMD_OP.MOVD_XMM_MEM, dst, src: 0, addressOperand: 1 };
      return null;
    }
    case C.Movd_rm32_xmm: {
      const src = xmm(1);
      if (src === null) return null;
      const dst = gpr(0);
      if (dst !== null) return { op: SIMD_OP.MOVD_GPR_XMM, dst, src, addressOperand: -1 };
      if (mem32(0)) return { op: SIMD_OP.MOVD_MEM_XMM, dst: 0, src, addressOperand: 0 };
      return null;
    }
    case C.Movq_xmm_xmmm64: {
      const dst = xmm(0);
      if (dst === null) return null;
      const src = xmm(1);
      if (src !== null) return { op: SIMD_OP.MOVQ_XMM_XMM, dst, src, addressOperand: -1 };
      if (mem64(1)) return { op: SIMD_OP.MOVQ_XMM_MEM, dst, src: 0, addressOperand: 1 };
      return null;
    }
    case C.Movq_xmmm64_xmm: {
      const src = xmm(1);
      if (src === null) return null;
      const dst = xmm(0);
      if (dst !== null) return { op: SIMD_OP.MOVQ_XMM_XMM, dst, src, addressOperand: -1 };
      if (mem64(0)) return { op: SIMD_OP.MOVQ_MEM_XMM, dst: 0, src, addressOperand: 0 };
      return null;
    }
    case C.Movddup_xmm_xmmm64: {
      const dst = xmm(0);
      if (dst === null) return null;
      const src = xmm(1);
      if (src !== null) return { op: SIMD_OP.MOVDDUP_XMM_XMM, dst, src, addressOperand: -1 };
      if (mem64(1)) return { op: SIMD_OP.MOVDDUP_XMM_MEM, dst, src: 0, addressOperand: 1 };
      return null;
    }
    case C.Movdqa_xmm_xmmm128:
    case C.Movdqu_xmm_xmmm128:
    case C.Movups_xmm_xmmm128:
    case C.Movaps_xmm_xmmm128: {
      const move = vector(SIMD_OP.MOV128_XMM_XMM, SIMD_OP.MOV128_XMM_MEM);
      if (!move) return null;
      move.aligned = ALIGNED_MOVES.has(iced.Mnemonic[instruction.mnemonic]);
      return move;
    }
    case C.Movdqa_xmmm128_xmm:
    case C.Movdqu_xmmm128_xmm:
    case C.Movups_xmmm128_xmm:
    case C.Movaps_xmmm128_xmm: {
      const dst = destination(0, mem128);
      const src = source(1, mem128);
      if (!dst || dst.memory === false) {
        if (!dst || !src || src.memory) return null;
        return {
          op: SIMD_OP.MOV128_XMM_XMM,
          dst: dst.reg,
          src: src.reg,
          addressOperand: -1,
          aligned: ALIGNED_MOVES.has(iced.Mnemonic[instruction.mnemonic]),
        };
      }
      if (!src || src.memory) return null;
      return {
        op: SIMD_OP.MOV128_MEM_XMM,
        dst: 0,
        src: src.reg,
        addressOperand: 0,
        aligned: ALIGNED_MOVES.has(iced.Mnemonic[instruction.mnemonic]),
      };
    }
    case C.Punpckldq_xmm_xmmm128:
    case C.Punpcklqdq_xmm_xmmm128:
    case C.Pxor_xmm_xmmm128: {
      const dst = xmm(0);
      if (dst === null) return null;
      const src = source(1, mem128);
      if (!src) return null;
      const operation =
        instruction.mnemonic === iced.Mnemonic.Punpckldq
          ? [SIMD_OP.PUNPCKLDQ_XMM_XMM, SIMD_OP.PUNPCKLDQ_XMM_MEM]
          : instruction.mnemonic === iced.Mnemonic.Punpcklqdq
            ? [SIMD_OP.PUNPCKLQDQ_XMM_XMM, SIMD_OP.PUNPCKLQDQ_XMM_MEM]
            : [SIMD_OP.PXOR_XMM_XMM, SIMD_OP.PXOR_XMM_MEM];
      return {
        op: src.memory ? operation[1] : operation[0],
        dst,
        src: src.reg,
        addressOperand: src.memory ? 1 : -1,
        aligned: src.memory,
      };
    }
    case C.Pshufd_xmm_xmmm128_imm8: {
      const dst = xmm(0);
      if (dst === null || instruction.opKind(2) !== K.Immediate8) return null;
      const src = source(1, mem128);
      if (!src) return null;
      return {
        op: src.memory ? SIMD_OP.PSHUFD_XMM_MEM : SIMD_OP.PSHUFD_XMM_XMM,
        dst,
        src: src.reg,
        addressOperand: src.memory ? 1 : -1,
        immediate: instruction.immediate8,
        aligned: src.memory,
      };
    }
    default:
      return null;
  }
}

/** Mutable eight-register SSE state plus the explicit supported operation set. */
export class SIMDState {
  constructor(generalRegisters, { read, write, check }) {
    this.registers = Array.from({ length: 8 }, () => new Uint32Array(4));
    this.generalRegisters = generalRegisters;
    this.read = read;
    this.write = write;
    this.check = check;
  }

  snapshot() {
    return this.registers.map((register) => register.slice());
  }

  restore(snapshot) {
    if (!Array.isArray(snapshot) || snapshot.length !== 8)
      throw Error('Invalid SIMD snapshot: expected eight XMM registers');
    const restored = snapshot.map((register) => {
      if ((!Array.isArray(register) && !(register instanceof Uint32Array)) || register.length !== 4)
        throw Error('Invalid SIMD snapshot: each XMM register must contain four dwords');
      return Uint32Array.from(register, (value) => value >>> 0);
    });
    this.registers = restored;
  }

  readMemory(address, size) {
    address >>>= 0;
    this.check(address, size, false);
    const result = new Uint32Array(Math.ceil(size / 4));
    for (let offset = 0; offset < size; offset += 4)
      result[offset >>> 2] = this.read(address + offset, Math.min(4, size - offset)) >>> 0;
    return result;
  }

  writeMemory(address, values, size) {
    address >>>= 0;
    this.check(address, size, true);
    for (let offset = 0; offset < size; offset += 4)
      this.write(address + offset, values[offset >>> 2], Math.min(4, size - offset));
  }

  execute(op, dst, src, address, immediate) {
    const mustAlign = !!(op & 0x100);
    op &= 0xff;
    if (mustAlign && (address >>> 0) % 16)
      throw Error('Aligned SIMD memory access requires 16-byte alignment');
    const d = this.registers[dst];
    const s = this.registers[src];
    const load = (size) => this.readMemory(address, size);
    const store = (values, size) => this.writeMemory(address, values, size);
    switch (op) {
      case SIMD_OP.MOVD_XMM_GPR:
        d.set([this.generalRegisters[src].value >>> 0, 0, 0, 0]);
        return;
      case SIMD_OP.MOVD_XMM_MEM:
        d.set([load(4)[0], 0, 0, 0]);
        return;
      case SIMD_OP.MOVD_GPR_XMM:
        this.generalRegisters[dst].value = s[0] | 0;
        return;
      case SIMD_OP.MOVD_MEM_XMM:
        store(s, 4);
        return;
      case SIMD_OP.MOVQ_XMM_XMM:
        d.set([s[0], s[1], 0, 0]);
        return;
      case SIMD_OP.MOVQ_XMM_MEM: {
        const value = load(8);
        d.set([value[0], value[1], 0, 0]);
        return;
      }
      case SIMD_OP.MOVQ_MEM_XMM:
        store(s, 8);
        return;
      case SIMD_OP.MOV128_XMM_XMM:
        d.set(s);
        return;
      case SIMD_OP.MOV128_XMM_MEM:
        d.set(load(16));
        return;
      case SIMD_OP.MOV128_MEM_XMM:
        store(s, 16);
        return;
      case SIMD_OP.PUNPCKLDQ_XMM_XMM:
        d.set([d[0], s[0], d[1], s[1]]);
        return;
      case SIMD_OP.PUNPCKLDQ_XMM_MEM: {
        const value = load(16);
        d.set([d[0], value[0], d[1], value[1]]);
        return;
      }
      case SIMD_OP.PUNPCKLQDQ_XMM_XMM:
        d.set([d[0], d[1], s[0], s[1]]);
        return;
      case SIMD_OP.PUNPCKLQDQ_XMM_MEM: {
        const value = load(16);
        d.set([d[0], d[1], value[0], value[1]]);
        return;
      }
      case SIMD_OP.PXOR_XMM_XMM:
        for (let lane = 0; lane < 4; lane++) d[lane] ^= s[lane];
        return;
      case SIMD_OP.PXOR_XMM_MEM: {
        const value = load(16);
        for (let lane = 0; lane < 4; lane++) d[lane] ^= value[lane];
        return;
      }
      case SIMD_OP.PSHUFD_XMM_XMM:
        d.set(Array.from({ length: 4 }, (_, lane) => s[(immediate >>> (lane * 2)) & 3]));
        return;
      case SIMD_OP.PSHUFD_XMM_MEM: {
        const value = load(16);
        d.set(Array.from({ length: 4 }, (_, lane) => value[(immediate >>> (lane * 2)) & 3]));
        return;
      }
      case SIMD_OP.MOVDDUP_XMM_XMM:
        d.set([s[0], s[1], s[0], s[1]]);
        return;
      case SIMD_OP.MOVDDUP_XMM_MEM: {
        const value = load(8);
        d.set([value[0], value[1], value[0], value[1]]);
        return;
      }
      default:
        throw Error(`Unsupported SIMD operation ${op}`);
    }
  }
}
