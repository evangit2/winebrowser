import { Runtime } from '../../src/runtime.js';

export async function probeX87Trig(iced, { files }) {
  const runtime = new Runtime(iced, { files, exe: 'trigonometry.exe' });
  try {
    const result = await runtime.run();
    if (result.exitCode) {
      const code = result.exitCode - 1;
      throw Error(
        `Native trig vector ${code >>> 4}, ${['FSIN', 'FCOS', 'FSINCOS cosine', 'FSINCOS sine'][(code >>> 2) & 3]} failed: ${['ext80 result', 'exceptions', 'C1/C2', 'stack top'][code & 3]}`,
      );
    }
    return {
      status: 'passed',
      exitCode: 0,
      instructions: runtime.cpu.instructions,
      scope:
        'Native PE32 FSIN/FCOS/FSINCOS against 224 independent high-precision Decimal/Chudnovsky mathematical sine/cosine vectors; all rounding modes, ext80 low bits, tiny inputs, near-pi cancellation, large in-range arguments, exception flags and stack order. Does not reproduce physical x87 finite-pi reduction errors.',
    };
  } catch (error) {
    return { status: 'failed', failure: error.message };
  }
}
