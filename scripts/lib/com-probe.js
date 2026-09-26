import { Runtime } from '../../src/runtime.js';

export async function probeCom(iced, { files }) {
  const runtime = new Runtime(iced, { files, exe: 'client.exe' });
  try {
    const result = await runtime.run();
    if (result.exitCode)
      throw Error(`Native COM fixture failed at C source line ${result.exitCode}`);
    if ([...runtime.graph.modules.values()].some((module) => module.name === 'counter.dll'))
      throw Error('Unused native COM DLL remained loaded');
    return {
      status: 'passed',
      exitCode: result.exitCode,
      instructions: runtime.cpu.instructions,
      scope:
        'Native PE32 in-process class factory, object calls, failure HRESULTs, reference counts, locks, unload/reload and balanced single-thread COM initialization; no cross-apartment or remote COM.',
    };
  } catch (error) {
    return { status: 'failed', failure: error.message };
  }
}
