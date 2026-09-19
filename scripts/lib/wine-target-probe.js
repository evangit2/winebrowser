import { Runtime, API_NAMES } from '../../src/runtime.js';
import { parsePE } from '../../src/pe.js';
import { installWineNtBridge } from '../../src/wine-nt.js';
import { initializeWineProcess } from '../../src/wine-process.js';

const hex = (value) => `0x${(value >>> 0).toString(16)}`;

// Diagnostic only: missing host APIs get a trap address, never a success stub.
// The normal package loader continues rejecting unresolved imports up front.
export async function probeWineTarget(iced, { files, exe, builtinFiles, nlsFiles }) {
  const report = {
    status: 'blocked-guest',
    scope:
      'Unchanged upstream PE with real Wine base DLLs and source-built loader metadata; unresolved host imports trap if reached. This is not normal harness compatibility.',
    phases: [],
    trappedImports: [],
    apiCalls: [],
    output: [],
    firstFailure: null,
  };
  const restore = new Map();
  let runtime,
    phase = 'map guest closure',
    lastIP;
  const guestModules = () => [...runtime.graph.modules.values()].filter((m) => !m.host);
  const locate = (address) => {
    const module =
      runtime && guestModules().find((m) => address >= m.base && address < m.base + m.pe.imageSize);
    return {
      address: hex(address),
      module: module?.name ?? null,
      offset: module ? hex(address - module.base) : null,
    };
  };
  try {
    const hostBoundary = new Set([
      'user32.dll',
      'gdi32.dll',
      'advapi32.dll',
      'shell32.dll',
      'd3d9.dll',
    ]);
    for (const imported of parsePE(files.get(exe)).imports) {
      const dll = imported.dll.toLowerCase(),
        name = imported.name;
      if (!hostBoundary.has(dll) || API_NAMES[dll]?.includes(name)) continue;
      if (!name) throw Error(`Unsupported diagnostic ordinal import ${dll}!#${imported.ordinal}`);
      if (!restore.has(dll)) restore.set(dll, API_NAMES[dll]);
      API_NAMES[dll] = [...(API_NAMES[dll] ?? []), name];
      report.trappedImports.push(`${dll}!${name}`);
    }
    runtime = new Runtime(iced, {
      files,
      exe,
      builtinFiles,
      nlsFiles,
      // Startup may include native timing calibration loops. Keep a bounded
      // diagnostic budget large enough to observe their eventual API calls.
      maxBlocks: 10_000_000,
      emit: (message) => {
        if (message.type === 'stdout') report.output.push(message.text);
        if (message.type === 'window' && message.operation === 'create') {
          const { id, title, width, height, icon } = message.window;
          report.phases.push({
            name: 'window created',
            window: {
              id,
              title,
              width,
              height,
              icon: icon && { width: icon.width, height: icon.height },
            },
          });
        }
      },
    });
    const prepare = runtime.cpu.prepare.bind(runtime.cpu);
    runtime.cpu.prepare = (ip) => {
      lastIP = ip;
      return prepare(ip);
    };
    const api = runtime.api.bind(runtime);
    runtime.api = async (entry) => {
      const service = entry.services?.get(runtime.cpu.r[0].value >>> 0);
      const name = service?.name ?? (entry.dll ? `${entry.dll}!${entry.name}` : entry.name);
      const sp = runtime.cpu.r[4].value >>> 0;
      const args = [];
      for (let i = 0; i < (service?.argc ?? 4); i++) {
        try {
          args.push(runtime.read32(sp + (service ? 8 : 4) + i * 4) >>> 0);
        } catch {
          // Tracing must not turn a short stack into a different guest failure.
          break;
        }
      }
      const record = { name, args };
      report.apiCalls.push(record);
      if (report.apiCalls.length > 64) report.apiCalls.shift();
      try {
        const next = await api(entry);
        record.result = hex(runtime.cpu.r[0].value);
        return next;
      } catch (error) {
        record.error = error.message;
        throw error;
      }
    };
    const dispatch = runtime.dispatch.bind(runtime);
    runtime.dispatch = async (...args) => {
      try {
        return await dispatch(...args);
      } catch (error) {
        report.firstFailure ??= {
          phase,
          message: error.message,
          ip: locate(lastIP),
          registers: runtime.cpu.r.map((r) => hex(r.value)),
          compiledBlocks: runtime.cpu.cache.size,
          instructions: runtime.cpu.instructions,
        };
        throw error;
      }
    };
    report.phases.push({ name: phase, passed: true, modules: runtime.graph.describe() });
    phase = 'Wine process bootstrap';
    const ntdll = runtime.graph.modules.get('ntdll.dll');
    installWineNtBridge(runtime, ntdll);
    await initializeWineProcess(runtime, ntdll);
    report.phases.push({ name: phase, passed: true });
    phase = 'source loader registration';
    const modules = guestModules();
    const entry = ntdll.pe.exports.find((e) => e.name === 'WineBrowserLoaderBootstrap');
    if (!entry || entry.forwarder) throw Error('Source-built loader export missing');
    const allocated = [];
    try {
      const table = runtime.allocate(modules.length * 16);
      allocated.push(table);
      modules.forEach((module, i) => {
        const name = runtime.allocString(
          `\\??\\C:\\winebrowser\\${(module.path.startsWith('@runtime/') ? module.name : module.path).replaceAll('/', '\\')}`,
          true,
        );
        allocated.push(name);
        [
          16,
          module.base,
          name,
          module === runtime.graph.main ? 1 : module === ntdll ? 2 : 0,
        ].forEach((value, n) => runtime.write32(table + i * 16 + n * 4, value));
      });
      const batch = runtime.allocate(16);
      allocated.push(batch);
      [16, 1, modules.length, table].forEach((value, n) => runtime.write32(batch + n * 4, value));
      const status = await runtime.callGuest(ntdll.base + entry.rva, [batch]);
      if (status) throw Error(`WineBrowserLoaderBootstrap returned ${hex(status)}`);
    } finally {
      for (const pointer of allocated) runtime.free(pointer);
    }
    report.phases.push({ name: phase, passed: true });
    phase = 'guest DLL attach';
    await runtime.initializeModules();
    report.phases.push({ name: phase, passed: true });
    phase = 'native EXE entry point';
    await runtime.tls.attach(runtime.graph.main);
    const result = await runtime.callGuest(runtime.pe.entryPoint);
    report.exitCode = runtime.exitCode ?? result;
    report.status = 'entry-returned';
    report.phases.push({ name: phase, passed: true });
  } catch (error) {
    report.firstFailure ??= {
      phase,
      message: error.message,
      ...(runtime
        ? {
            ip: locate(lastIP),
            registers: runtime.cpu.r.map((r) => hex(r.value)),
            compiledBlocks: runtime.cpu.cache.size,
            instructions: runtime.cpu.instructions,
          }
        : {}),
    };
  } finally {
    for (const [dll, previous] of restore) {
      if (previous) API_NAMES[dll] = previous;
      else delete API_NAMES[dll];
    }
    runtime?.windows.dispose();
    runtime?.cpu.dispose();
  }
  return report;
}
