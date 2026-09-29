import { Runtime } from '../../src/runtime.js';

export async function probeX87Scale(iced, { files }) {
  const runtime = new Runtime(iced, { files, exe: 'scale.exe' });
  try {
    const result = await runtime.run();
    if (result.exitCode) {
      const code = result.exitCode - 1;
      throw Error(
        `Native FSCALE vector ${code >>> 2} failed: ${['ext80 result', 'exceptions', 'C1 rounding', 'stack top'][code & 3]}`,
      );
    }
    return {
      status: 'passed',
      exitCode: 0,
      instructions: runtime.cpu.instructions,
      scope:
        'Native PE32 FSCALE execution against 161 independently generated exact-rational vectors covering both scale directions, ST(1) truncation toward zero, directed rounding, gradual underflow, overflow, subnormal operands, precision-control independence, NaN propagation, unsupported encodings and exact low-bit preservation; ext80 bytes, exception bits, C1 and stack top are checked.',
    };
  } catch (error) {
    return { status: 'failed', failure: error.message };
  }
}
