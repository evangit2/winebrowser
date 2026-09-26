import { Runtime } from '../../src/runtime.js';

export async function probeScalarSse(iced, { files }) {
  const runtime = new Runtime(iced, { files, exe: 'scalar.exe' });
  try {
    const result = await runtime.run();
    if (result.exitCode)
      throw Error(`Native scalar SSE fixture failed at C source line ${result.exitCode}`);
    return {
      status: 'passed',
      exitCode: 0,
      instructions: runtime.cpu.instructions,
      scope:
        'Native PE32 scalar MOVSD/MOVSS register preservation, unaligned memory loads/stores and exact signed-int32 CVTSI2SD. This does not establish SSE floating-point arithmetic or MXCSR support.',
    };
  } catch (error) {
    return { status: 'failed', failure: error.message };
  }
}
