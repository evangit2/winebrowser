import { Runtime } from '../../src/runtime.js';
export async function probeSharedData(iced, { files }) {
  const runtime = new Runtime(iced, { files, exe: 'shared-data.exe' });
  try {
    const result = await runtime.run();
    if (result.exitCode)
      throw Error(`Native shared-data fixture failed at C source line ${result.exitCode}`);
    return {
      status: 'passed',
      exitCode: result.exitCode,
      instructions: result.instructions,
      linearMemoryBytes: runtime.memory.buffer.byteLength,
      scope:
        'Native high-address clock/processor reads, GetTickCount/GetTickCount64/WinMM agreement and clean exit; no pretranslated application code.',
    };
  } catch (error) {
    return { status: 'failed', failure: error.message };
  }
}
