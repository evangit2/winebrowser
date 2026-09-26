import { Runtime } from '../../src/runtime.js';

export async function probeX87Log(iced, { files }) {
  const runtime = new Runtime(iced, { files, exe: 'logarithm.exe' });
  try {
    const result = await runtime.run();
    if (result.exitCode) {
      const code = result.exitCode - 1;
      throw Error(
        `Native FYL2X vector ${code >>> 2} failed: ${['ext80 result', 'exceptions', 'C1 rounding', 'stack top'][code & 3]}`,
      );
    }
    return {
      status: 'passed',
      exitCode: 0,
      instructions: runtime.cpu.instructions,
      scope:
        'Native PE32 FYL2X execution against 204 independently generated 320-digit Decimal vectors, including all rounding modes, extended range, subnormals and overflow; exact ext80 bytes, exception bits, C1 and stack pop checked.',
    };
  } catch (error) {
    return { status: 'failed', failure: error.message };
  }
}
