import { Runtime } from '../../src/runtime.js';

export async function probeX87Exp(iced, { files }) {
  const runtime = new Runtime(iced, { files, exe: 'exponential.exe' });
  try {
    const result = await runtime.run();
    if (result.exitCode) {
      const code = result.exitCode - 1;
      throw Error(
        `Native F2XM1 vector ${code >>> 2} failed: ${['ext80 result', 'exceptions', 'C1 rounding', 'stack top'][code & 3]}`,
      );
    }
    return {
      status: 'passed',
      exitCode: 0,
      instructions: runtime.cpu.instructions,
      scope:
        'Native PE32 F2XM1 execution against 208 independently generated high-precision Decimal vectors covering |x| < 1, all rounding modes, sign of zero, tiny subnormal arguments, exact endpoints and rational/irrational cases; exact ext80 bytes, exception bits, C1 and stack top checked.',
    };
  } catch (error) {
    return { status: 'failed', failure: error.message };
  }
}
