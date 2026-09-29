import { Runtime } from '../../src/runtime.js';

export async function probeX87Tan(iced, { files }) {
  const runtime = new Runtime(iced, { files, exe: 'tangent.exe' });
  try {
    const result = await runtime.run();
    if (result.exitCode) {
      const code = result.exitCode - 1;
      throw Error(
        `Native FPTAN vector ${code >>> 2} failed: ${['tangent bytes', 'exceptions', 'C1/C2', 'stack top', 'pushed constant'][code & 3]}`,
      );
    }
    return {
      status: 'passed',
      exitCode: 0,
      instructions: runtime.cpu.instructions,
      scope:
        'Native PE32 FPTAN against 220 independently generated high-precision Decimal tangent vectors covering all rounding modes, tiny and subnormal arguments, exact zero, near-pi cancellation, large in-range arguments and the C2 out-of-range case; tangent bytes, exception bits, C1/C2, the pushed 1.0 and the stack top are checked.',
    };
  } catch (error) {
    return { status: 'failed', failure: error.message };
  }
}
