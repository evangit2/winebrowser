import { SIMDFloat } from './simd-float.js';

// Selected legacy SSE/SSE2 operations. AVX remains unsupported.
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
  PEXTRW_GPR_XMM: 21,
  PADDW_XMM_XMM: 22,
  PADDW_XMM_MEM: 23,
  MOVSS_XMM_XMM: 24,
  MOVSD_XMM_XMM: 25,
  CVTSI2SD_XMM_GPR: 26,
  CVTSI2SD_XMM_MEM: 27,
  FLOAT_SCALAR: 28,
  LDMXCSR: 29,
  STMXCSR: 30,
  PCMPEQD_XMM_XMM: 31,
  PCMPEQD_XMM_MEM: 32,
  AND_XMM_XMM: 33,
  AND_XMM_MEM: 34,
  ANDNOT_XMM_XMM: 35,
  ANDNOT_XMM_MEM: 36,
  OR_XMM_XMM: 37,
  OR_XMM_MEM: 38,
  MOVHALF_XMM_MEM: 39,
  MOVHALF_MEM_XMM: 40,
  MOVHALF_XMM_XMM: 41,
  DWORD_ARITH_XMM_XMM: 42,
  DWORD_ARITH_XMM_MEM: 43,
  SHIFT_BYTES_XMM: 44,
  FLOAT_PACKED: 45,
});

const floatingCodes = new WeakMap();
function scalarCodes(C) {
  if (!floatingCodes.has(C)) {
    const codes = new Map();
    for (const [format, suffix, width] of [
      [0, 'ss', 32],
      [1, 'sd', 64],
    ]) {
      for (const [op, name] of ['Add', 'Sub', 'Mul', 'Div', 'Sqrt'].entries())
        codes.set(C[`${name}${suffix}_xmm_xmmm${width}`], { op, format });
      for (const [op, name] of ['Add', 'Sub', 'Mul', 'Div', 'Sqrt'].entries())
        codes.set(C[`${name}${format ? 'pd' : 'ps'}_xmm_xmmm128`], { op, format, packed: true });
      codes.set(C[`Cvtsi2${suffix}_xmm_rm32`], { op: 5, format });
      codes.set(C[`Cvt${suffix}2si_r32_xmmm${width}`], { op: 6, format });
      codes.set(C[`Cvtt${suffix}2si_r32_xmmm${width}`], { op: 7, format });
      codes.set(C[`Cvt${format ? 'ss2sd' : 'sd2ss'}_xmm_xmmm${format ? 32 : 64}`], {
        op: 8,
        format,
      });
      codes.set(C[`Ucomi${suffix}_xmm_xmmm${width}`], { op: 9, format });
      codes.set(C[`Comi${suffix}_xmm_xmmm${width}`], { op: 10, format });
    }
    // This exact conversion already has a cheap integer-to-binary64 path.
    codes.delete(C.Cvtsi2sd_xmm_rm32);
    floatingCodes.set(C, codes);
  }
  return floatingCodes.get(C);
}

const ALIGNED_MOVES = new Set(['Movdqa', 'Movaps', 'Movapd']);

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

  const floating = scalarCodes(C).get(instruction.code);
  if (floating) {
    const { op, format, packed } = floating;
    const dst = op === 6 || op === 7 ? gpr(0) : xmm(0);
    const src = op === 5 ? gpr(1) : xmm(1);
    const width = packed ? mem128 : op === 5 || (op === 8 ? format : !format) ? mem32 : mem64;
    if (dst === null || (src === null && !width(1))) return null;
    return {
      op: packed ? SIMD_OP.FLOAT_PACKED : SIMD_OP.FLOAT_SCALAR,
      dst,
      src: src ?? 0,
      immediate: op | (format << 4) | (src === null ? 32 : 0),
      addressOperand: src === null ? 1 : -1,
      floating: true,
      aligned: !!packed && src === null,
    };
  }

  switch (instruction.code) {
    case C.Ldmxcsr_m32:
    case C.Stmxcsr_m32:
      if (!mem32(0)) return null;
      return {
        op: instruction.code === C.Ldmxcsr_m32 ? SIMD_OP.LDMXCSR : SIMD_OP.STMXCSR,
        dst: 0,
        src: 0,
        addressOperand: 0,
      };
    case C.Cvtsi2sd_xmm_rm32: {
      const dst = xmm(0),
        src = gpr(1);
      if (dst === null) return null;
      if (src !== null) return { op: SIMD_OP.CVTSI2SD_XMM_GPR, dst, src, addressOperand: -1 };
      if (mem32(1)) return { op: SIMD_OP.CVTSI2SD_XMM_MEM, dst, src: 0, addressOperand: 1 };
      return null;
    }
    case C.Movlps_xmm_m64:
    case C.Movlpd_xmm_m64:
    case C.Movhps_xmm_m64:
    case C.Movhpd_xmm_m64: {
      const dst = xmm(0);
      if (dst === null || !mem64(1)) return null;
      return {
        op: SIMD_OP.MOVHALF_XMM_MEM,
        dst,
        src: 0,
        addressOperand: 1,
        immediate: [C.Movhps_xmm_m64, C.Movhpd_xmm_m64].includes(instruction.code) ? 2 : 0,
      };
    }
    case C.Movlps_m64_xmm:
    case C.Movlpd_m64_xmm:
    case C.Movhps_m64_xmm:
    case C.Movhpd_m64_xmm: {
      const src = xmm(1);
      if (src === null || !mem64(0)) return null;
      return {
        op: SIMD_OP.MOVHALF_MEM_XMM,
        dst: 0,
        src,
        addressOperand: 0,
        immediate: [C.Movhps_m64_xmm, C.Movhpd_m64_xmm].includes(instruction.code) ? 2 : 0,
      };
    }
    case C.Movhlps_xmm_xmm:
    case C.Movlhps_xmm_xmm: {
      const dst = xmm(0),
        src = xmm(1);
      if (dst === null || src === null) return null;
      return {
        op: SIMD_OP.MOVHALF_XMM_XMM,
        dst,
        src,
        addressOperand: -1,
        immediate: instruction.code === C.Movhlps_xmm_xmm ? 0 : 2,
      };
    }
    case C.Movss_xmm_xmmm32:
    case C.Movss_xmmm32_xmm:
    case C.Movsd_xmm_xmmm64:
    case C.Movsd_xmmm64_xmm: {
      const double = instruction.mnemonic === iced.Mnemonic.Movsd;
      const width = double ? mem64 : mem32;
      const dst = destination(0, width),
        src = source(1, width);
      if (!dst || !src || (dst.memory && src.memory)) return null;
      if (dst.memory)
        return {
          op: double ? SIMD_OP.MOVQ_MEM_XMM : SIMD_OP.MOVD_MEM_XMM,
          dst: 0,
          src: src.reg,
          addressOperand: 0,
        };
      if (src.memory)
        return {
          op: double ? SIMD_OP.MOVQ_XMM_MEM : SIMD_OP.MOVD_XMM_MEM,
          dst: dst.reg,
          src: 0,
          addressOperand: 1,
        };
      return {
        op: double ? SIMD_OP.MOVSD_XMM_XMM : SIMD_OP.MOVSS_XMM_XMM,
        dst: dst.reg,
        src: src.reg,
        addressOperand: -1,
      };
    }
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
    case C.Movupd_xmm_xmmm128:
    case C.Movapd_xmm_xmmm128:
    case C.Movaps_xmm_xmmm128: {
      const move = vector(SIMD_OP.MOV128_XMM_XMM, SIMD_OP.MOV128_XMM_MEM);
      if (!move) return null;
      move.aligned = ALIGNED_MOVES.has(iced.Mnemonic[instruction.mnemonic]);
      return move;
    }
    case C.Movdqa_xmmm128_xmm:
    case C.Movdqu_xmmm128_xmm:
    case C.Movups_xmmm128_xmm:
    case C.Movupd_xmmm128_xmm:
    case C.Movapd_xmmm128_xmm:
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
    case C.Pxor_xmm_xmmm128:
    case C.Xorps_xmm_xmmm128:
    case C.Xorpd_xmm_xmmm128:
    case C.Paddw_xmm_xmmm128: {
      const dst = xmm(0);
      if (dst === null) return null;
      const src = source(1, mem128);
      if (!src) return null;
      const operation =
        instruction.mnemonic === iced.Mnemonic.Punpckldq
          ? [SIMD_OP.PUNPCKLDQ_XMM_XMM, SIMD_OP.PUNPCKLDQ_XMM_MEM]
          : instruction.mnemonic === iced.Mnemonic.Punpcklqdq
            ? [SIMD_OP.PUNPCKLQDQ_XMM_XMM, SIMD_OP.PUNPCKLQDQ_XMM_MEM]
            : [iced.Mnemonic.Pxor, iced.Mnemonic.Xorps, iced.Mnemonic.Xorpd].includes(
                  instruction.mnemonic,
                )
              ? [SIMD_OP.PXOR_XMM_XMM, SIMD_OP.PXOR_XMM_MEM]
              : [SIMD_OP.PADDW_XMM_XMM, SIMD_OP.PADDW_XMM_MEM];
      return {
        op: src.memory ? operation[1] : operation[0],
        dst,
        src: src.reg,
        addressOperand: src.memory ? 1 : -1,
        aligned: src.memory,
      };
    }
    case C.Paddd_xmm_xmmm128:
    case C.Psubd_xmm_xmmm128: {
      const dst = xmm(0),
        src = source(1, mem128);
      if (dst === null || !src) return null;
      return {
        op: src.memory ? SIMD_OP.DWORD_ARITH_XMM_MEM : SIMD_OP.DWORD_ARITH_XMM_XMM,
        dst,
        src: src.reg,
        addressOperand: src.memory ? 1 : -1,
        aligned: src.memory,
        immediate: instruction.code === C.Psubd_xmm_xmmm128 ? 1 : 0,
      };
    }
    case C.Psrldq_xmm_imm8:
    case C.Pslldq_xmm_imm8: {
      const dst = xmm(0);
      if (dst === null || instruction.opKind(1) !== K.Immediate8) return null;
      return {
        op: SIMD_OP.SHIFT_BYTES_XMM,
        dst,
        src: 0,
        addressOperand: -1,
        immediate:
          Math.min(instruction.immediate8, 16) | (instruction.code === C.Pslldq_xmm_imm8 ? 32 : 0),
      };
    }
    case C.Pcmpeqd_xmm_xmmm128: {
      const dst = xmm(0),
        src = source(1, mem128);
      if (dst === null || !src) return null;
      return {
        op: src.memory ? SIMD_OP.PCMPEQD_XMM_MEM : SIMD_OP.PCMPEQD_XMM_XMM,
        dst,
        src: src.reg,
        addressOperand: src.memory ? 1 : -1,
        aligned: src.memory,
      };
    }
    case C.Andps_xmm_xmmm128:
    case C.Andpd_xmm_xmmm128:
    case C.Pand_xmm_xmmm128:
    case C.Andnps_xmm_xmmm128:
    case C.Andnpd_xmm_xmmm128:
    case C.Pandn_xmm_xmmm128:
    case C.Orps_xmm_xmmm128:
    case C.Orpd_xmm_xmmm128:
    case C.Por_xmm_xmmm128: {
      const dst = xmm(0),
        src = source(1, mem128);
      if (dst === null || !src) return null;
      const name = iced.Mnemonic[instruction.mnemonic];
      const op = ['Andps', 'Andpd', 'Pand'].includes(name)
        ? SIMD_OP.AND_XMM_XMM
        : ['Andnps', 'Andnpd', 'Pandn'].includes(name)
          ? SIMD_OP.ANDNOT_XMM_XMM
          : SIMD_OP.OR_XMM_XMM;
      return {
        op: op + (src.memory ? 1 : 0),
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
    case C.Pextrw_r32_xmm_imm8: {
      const dst = gpr(0);
      const src = xmm(1);
      if (dst === null || src === null || instruction.opKind(2) !== K.Immediate8) return null;
      return {
        op: SIMD_OP.PEXTRW_GPR_XMM,
        dst,
        src,
        addressOperand: -1,
        immediate: instruction.immediate8,
      };
    }
    default:
      return null;
  }
}

/** Mutable eight-register SSE state plus the explicit supported operation set. */
export class SIMDState {
  constructor(generalRegisters, { read, write, check, getModule, flags }) {
    this.registers = Array.from({ length: 8 }, () => new Uint32Array(4));
    this.generalRegisters = generalRegisters;
    this.read = read;
    this.write = write;
    this.check = check;
    this.scalar64 = new DataView(new ArrayBuffer(8));
    this.float = new SIMDFloat(getModule);
    this.flags = flags;
  }

  get mxcsr() {
    return this.float.mxcsr;
  }
  set mxcsr(value) {
    this.float.mxcsr = value;
  }
  dispose() {
    this.float.dispose();
  }

  snapshot() {
    return { registers: this.registers.map((register) => register.slice()), mxcsr: this.mxcsr };
  }

  restore(snapshot) {
    if (
      !Number.isInteger(snapshot?.mxcsr) ||
      snapshot.mxcsr < 0 ||
      snapshot.mxcsr > 0xffff ||
      !Array.isArray(snapshot.registers) ||
      snapshot.registers.length !== 8
    )
      throw Error('Invalid SIMD snapshot: expected eight XMM registers');
    const restored = snapshot.registers.map((register) => {
      if ((!Array.isArray(register) && !(register instanceof Uint32Array)) || register.length !== 4)
        throw Error('Invalid SIMD snapshot: each XMM register must contain four dwords');
      return Uint32Array.from(register, (value) => value >>> 0);
    });
    this.registers = restored;
    this.mxcsr = snapshot.mxcsr;
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
      case SIMD_OP.AND_XMM_XMM:
      case SIMD_OP.AND_XMM_MEM:
      case SIMD_OP.ANDNOT_XMM_XMM:
      case SIMD_OP.ANDNOT_XMM_MEM:
      case SIMD_OP.OR_XMM_XMM:
      case SIMD_OP.OR_XMM_MEM: {
        const value = [SIMD_OP.AND_XMM_MEM, SIMD_OP.ANDNOT_XMM_MEM, SIMD_OP.OR_XMM_MEM].includes(op)
          ? load(16)
          : s;
        for (let i = 0; i < 4; i++)
          d[i] =
            op <= SIMD_OP.AND_XMM_MEM
              ? d[i] & value[i]
              : op <= SIMD_OP.ANDNOT_XMM_MEM
                ? ~d[i] & value[i]
                : d[i] | value[i];
        return;
      }
      case SIMD_OP.PCMPEQD_XMM_XMM:
      case SIMD_OP.PCMPEQD_XMM_MEM: {
        const value = op === SIMD_OP.PCMPEQD_XMM_MEM ? load(16) : s;
        for (let i = 0; i < 4; i++) d[i] = d[i] === value[i] ? 0xffffffff : 0;
        return;
      }
      case SIMD_OP.LDMXCSR: {
        const value = load(4)[0];
        if (value & 0xffff0000)
          throw Error('LDMXCSR reserved bits cause a general-protection fault');
        this.mxcsr = value;
        return;
      }
      case SIMD_OP.STMXCSR:
        store([this.mxcsr], 4);
        return;
      case SIMD_OP.FLOAT_SCALAR: {
        const operation = immediate & 15,
          double = !!(immediate & 16);
        const sourceDouble = operation === 8 ? !double : double;
        const value =
          immediate & 32
            ? load(operation === 5 || !sourceDouble ? 4 : 8)
            : operation === 5
              ? [this.generalRegisters[src].value, 0]
              : s;
        const binary = operation <= 3 || operation >= 9;
        const result = this.float.execute(operation, double, binary ? d : value, value);
        if (operation === 6 || operation === 7) this.generalRegisters[dst].value = result[0] | 0;
        else if (operation >= 9) {
          const comparison = result[0] | 0;
          Object.assign(this.flags.f, {
            cf: comparison === -1 || comparison === 2 ? 1 : 0,
            zf: comparison === 0 || comparison === 2 ? 1 : 0,
            pf: comparison === 2 ? 1 : 0,
            sf: 0,
            of: 0,
          });
          this.flags.af = 0;
        } else {
          d[0] = result[0];
          if (double) d[1] = result[1];
        }
        return;
      }
      case SIMD_OP.FLOAT_PACKED: {
        const value = immediate & 32 ? load(16) : s;
        d.set(this.float.executePacked(immediate & 15, !!(immediate & 16), d, value));
        return;
      }
      case SIMD_OP.CVTSI2SD_XMM_GPR:
      case SIMD_OP.CVTSI2SD_XMM_MEM: {
        // Every signed 32-bit integer is exactly representable in binary64:
        // this conversion is independent of MXCSR rounding/exception state.
        const integer =
          op === SIMD_OP.CVTSI2SD_XMM_MEM ? load(4)[0] | 0 : this.generalRegisters[src].value | 0;
        this.scalar64.setFloat64(0, integer, true);
        d[0] = this.scalar64.getUint32(0, true);
        d[1] = this.scalar64.getUint32(4, true);
        return;
      }
      case SIMD_OP.DWORD_ARITH_XMM_XMM:
      case SIMD_OP.DWORD_ARITH_XMM_MEM: {
        const value = op === SIMD_OP.DWORD_ARITH_XMM_MEM ? load(16) : s;
        for (let lane = 0; lane < 4; lane++)
          d[lane] = (immediate ? d[lane] - value[lane] : d[lane] + value[lane]) >>> 0;
        return;
      }
      case SIMD_OP.SHIFT_BYTES_XMM: {
        const count = immediate & 31,
          left = !!(immediate & 32),
          original = d.slice();
        d.fill(0);
        for (let byte = 0; byte < 16; byte++) {
          const source = left ? byte - count : byte + count;
          if (source >= 0 && source < 16)
            d[byte >>> 2] |=
              ((original[source >>> 2] >>> ((source & 3) * 8)) & 255) << ((byte & 3) * 8);
        }
        return;
      }
      case SIMD_OP.MOVHALF_XMM_MEM:
        // Legacy half-vector loads preserve the other 64 bits. Unlike MOVSD
        // memory loads, they never zero the upper half or interpret FP bits.
        d.set(load(8), immediate);
        return;
      case SIMD_OP.MOVHALF_MEM_XMM:
        store(s.subarray(immediate, immediate + 2), 8);
        return;
      case SIMD_OP.MOVHALF_XMM_XMM:
        // Copy before writing so source/destination register aliasing works.
        d.set(s.slice(2 - immediate, 4 - immediate), immediate);
        return;
      case SIMD_OP.MOVSS_XMM_XMM:
        d[0] = s[0];
        return;
      case SIMD_OP.MOVSD_XMM_XMM:
        d[0] = s[0];
        d[1] = s[1];
        return;
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
      case SIMD_OP.PADDW_XMM_XMM:
      case SIMD_OP.PADDW_XMM_MEM: {
        const value = op === SIMD_OP.PADDW_XMM_MEM ? load(16) : s;
        for (let lane = 0; lane < 4; lane++) {
          const left = d[lane],
            right = value[lane];
          d[lane] =
            (((left + right) & 0xffff) | ((((left >>> 16) + (right >>> 16)) & 0xffff) << 16)) >>> 0;
        }
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
      case SIMD_OP.PEXTRW_GPR_XMM: {
        const lane = immediate & 7;
        this.generalRegisters[dst].value = (s[lane >>> 1] >>> ((lane & 1) * 16)) & 0xffff;
        return;
      }
      default:
        throw Error(`Unsupported SIMD operation ${op}`);
    }
  }
}
