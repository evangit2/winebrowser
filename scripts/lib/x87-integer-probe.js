import { Runtime } from '../../src/runtime.js';
export async function probeX87Integer(iced, { files }) {
  const runtime = new Runtime(iced, { files, exe: 'x87-integer.exe' });
  try {
    const result = await runtime.run();
    if (result.exitCode)
      throw Error(`Native x87 integer fixture failed at C source line ${result.exitCode}`);
    return {
      status: 'passed',
      exitCode: result.exitCode,
      instructions: result.instructions,
      linearMemoryBytes: runtime.memory.buffer.byteLength,
      scope:
        'Native FIADD/FIMUL/FISUB/FISUBR/FIDIV/FIDIVR/FICOM/FICOMP with signed int16/int32 memory, result and stack checks, four rounding modes and C1; no pretranslated application code.',
    };
  } catch (error) {
    return { status: 'failed', failure: error.message };
  }
}
