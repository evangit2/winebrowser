import { Runtime } from '../../src/runtime.js';

export async function probeDrivers(iced, { files }) {
  const runtime = new Runtime(iced, { files, exe: 'client.exe' });
  try {
    const result = await runtime.run();
    if (result.exitCode)
      throw Error(`Native installable-driver fixture failed at C source line ${result.exitCode}`);
    if ([...runtime.graph.modules.values()].some((m) => ['codec.dll', 'bad.dll'].includes(m.name)))
      throw Error('A closed or rejected driver DLL remained loaded');
    return {
      status: 'passed',
      exitCode: result.exitCode,
      instructions: result.instructions,
      scope:
        'Native DriverProc callbacks, distinct instances and IDs, DLL path and registry lookup, ANSI entry, hidden descriptor sessions, exact message order, failure cleanup and unload. No system device or codec emulation.',
    };
  } catch (error) {
    return { status: 'failed', failure: error.message };
  }
}
