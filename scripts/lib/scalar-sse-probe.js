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
        'Native PE32 scalar MOVSD/MOVSS, signed conversions, binary32/binary64 arithmetic and square roots, float-width conversion, COMI/UCOMI flags, MXCSR rounding, DAZ and FTZ. Packed arithmetic has a separate native fixture; AVX and guest #XM delivery remain unsupported.',
    };
  } catch (error) {
    return { status: 'failed', failure: error.message };
  }
}
