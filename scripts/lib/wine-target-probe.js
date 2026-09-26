import { Runtime, API_NAMES } from '../../src/runtime.js';
import { canonicalHostSymbol } from '../../src/host-export-ordinals.js';
import { parsePE } from '../../src/pe.js';
import { installWineNtBridge } from '../../src/wine-nt.js';
import { initializeWineProcess } from '../../src/wine-process.js';
import { WebGPURenderer } from '../../src/webgpu-renderer.js';
import { D3D12Renderer } from '../../src/d3d12-renderer.js';
import { WineLoader, wineModulePath } from '../../src/wine-loader.js';
import { resolveApiSet } from '../../src/api-sets.js';

const hex = (value) => `0x${(value >>> 0).toString(16)}`;

// Diagnostic only: missing host APIs get a trap address, never a success stub.
// The normal package loader continues rejecting unresolved imports up front.
export async function probeWineTarget(
  iced,
  { files, exe, builtinFiles, nlsFiles, testStaticTLS = false },
) {
  const report = {
    status: 'blocked-guest',
    scope:
      'Unchanged upstream PE with real Wine base DLLs and source-built loader metadata; unresolved host imports trap if reached. This is not normal harness compatibility.',
    phases: [],
    trappedImports: [],
    apiCalls: [],
    output: [],
    requests: [],
    frames: 0,
    nativeLoaderCalls: [],
    firstFailure: null,
    diagnosticLimits: { maxBlocks: 10_000_000, maxExecutionMs: 45_000 },
  };
  const restore = new Map();
  const recentBlocks = [];
  let runtime,
    graphics,
    graphics12,
    phase = 'map guest closure',
    lastIP;
  const guestModules = () => [...runtime.graph.modules.values()].filter((m) => m.mapped);
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
    const nativeNames = new Set(
      [...files.keys(), ...builtinFiles.keys()].map((path) => path.split('/').at(-1).toLowerCase()),
    );
    const imports = [];
    for (const [name, bytes] of [...files, ...builtinFiles])
      if (name === exe || name.endsWith('.dll'))
        imports.push(...parsePE(bytes, { allowDll: name !== exe }).imports);
    for (const imported of imports) {
      const dll = imported.dll.toLowerCase(),
        name = imported.name ?? `#${imported.ordinal}`;
      if (
        nativeNames.has(resolveApiSet(dll)) ||
        API_NAMES[dll]?.includes(canonicalHostSymbol(dll, name, API_NAMES[dll]))
      )
        continue;
      if (!restore.has(dll)) restore.set(dll, API_NAMES[dll]);
      API_NAMES[dll] = [...(API_NAMES[dll] ?? []), name];
      report.trappedImports.push(`${dll}!${name}`);
    }
    graphics = new WebGPURenderer({
      emit: (message) => {
        if (message.type === 'frame') report.frames++;
        message.bitmap?.close();
      },
    });
    const graphics12 = new D3D12Renderer(graphics);
    runtime = new Runtime(iced, {
      files,
      exe,
      builtinFiles,
      nlsFiles,
      hostModuleImages: true,
      graphics,
      graphics12,
      request: async (kind, detail) => {
        report.requests.push({ kind, ...detail });
        throw Error(
          `Application requested ${kind}: ${detail.title ?? ''} ${detail.text ?? ''}`.trim(),
        );
      },
      // Startup may include native timing calibration loops. Keep a bounded
      // diagnostic budget large enough to observe their eventual API calls.
      maxBlocks: report.diagnosticLimits.maxBlocks,
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
    const loaderEntries = new Map();
    for (const module of guestModules())
      for (const entry of module.pe.exports)
        if (!entry.forwarder && ['LdrLoadDll', 'LdrGetProcedureAddress'].includes(entry.name))
          loaderEntries.set(module.base + entry.rva, entry.name);
    const pendingLoaderCalls = [];
    const started = performance.now();
    let dispatches = 0;
    runtime.cpu.prepare = (ip) => {
      lastIP = ip;
      // Retain the guest's actual location if it spins, before the browser's
      // outer worker deadline discards the diagnostic state entirely.
      if (
        !(++dispatches & 255) &&
        performance.now() - started > report.diagnosticLimits.maxExecutionMs
      )
        throw Error('Wine target diagnostic execution deadline exceeded');
      const stack = runtime.cpu.r[4].value >>> 0;
      for (let i = pendingLoaderCalls.length - 1; i >= 0; i--)
        if (
          pendingLoaderCalls[i].returnAddress === ip &&
          pendingLoaderCalls[i].returnStack === stack
        ) {
          pendingLoaderCalls[i].record.status = hex(runtime.cpu.r[0].value);
          pendingLoaderCalls.splice(i, 1);
        }
      const loader = loaderEntries.get(ip);
      if (loader) {
        const record = { name: loader };
        try {
          const args = Array.from({ length: 4 }, (_, i) => runtime.read32(stack + 4 + i * 4));
          record.args = args;
          if (loader === 'LdrLoadDll') record.dll = runtime.wideString(runtime.read32(args[2] + 4));
          else {
            record.dll = [...runtime.graph.modules.values()].find((m) => m.base === args[0])?.name;
            record.symbol = args[1] ? runtime.string(runtime.read32(args[1] + 4)) : args[2];
          }
          pendingLoaderCalls.push({
            record,
            returnAddress: runtime.read32(stack),
            returnStack: stack + 20,
          });
          if (pendingLoaderCalls.length > 64) pendingLoaderCalls.shift();
        } catch (error) {
          record.traceError = error.message;
        }
        report.nativeLoaderCalls.push(record);
        if (report.nativeLoaderCalls.length > 64) report.nativeLoaderCalls.shift();
      }
      recentBlocks.push({
        threadId: runtime.threads.current?.id,
        ...locate(ip),
        registers: runtime.cpu.r.map((r) => hex(r.value)),
        flags: { ...runtime.cpu.f, af: runtime.cpu.af, df: runtime.cpu.df },
      });
      if (recentBlocks.length > 16) recentBlocks.shift();
      return prepare(ip);
    };
    const api = runtime.api.bind(runtime);
    runtime.api = async (entry) => {
      const service = entry.services?.get(runtime.cpu.r[0].value >>> 0);
      const name = service?.name ?? (entry.dll ? `${entry.dll}!${entry.name}` : entry.name);
      const sp = runtime.cpu.r[4].value >>> 0;
      const args = [];
      const count =
        service?.argc ??
        {
          'user32.dll!SetWindowPos': 7,
          'user32.dll!CreateWindowExA': 12,
          'user32.dll!CreateWindowExW': 12,
          'dinput8.dll!DirectInput8Create': 5,
          'IDirect3D8.CreateDevice': 7,
          'IDirect3D9.CreateDevice': 7,
          'IDirect3D8.CheckDepthStencilMatch': 6,
          'IDirect3D9.CheckDepthStencilMatch': 6,
        }[name] ??
        4;
      for (let i = 0; i < count; i++) {
        try {
          args.push(runtime.read32(sp + (service ? 8 : 4) + i * 4) >>> 0);
        } catch {
          // Tracing must not turn a short stack into a different guest failure.
          break;
        }
      }
      const record = { name, args, threadId: runtime.threads.current?.id };
      if (['NtQueryAttributesFile', 'NtQueryFullAttributesFile'].includes(name)) {
        try {
          const string = runtime.read32(args[0] + 8),
            length = runtime.view.getUint16(string, true),
            buffer = runtime.read32(string + 4);
          runtime.check(buffer, length);
          record.path = new TextDecoder('utf-16le').decode(
            runtime.data.subarray(buffer, buffer + length),
          );
        } catch (error) {
          record.traceError = error.message;
        }
      }
      if (/^IDirect3D[89]\.CreateDevice$/.test(name)) {
        try {
          record.presentation = Array.from(
            { length: name.startsWith('IDirect3D8.') ? 13 : 14 },
            (_, i) => runtime.read32(args[5] + i * 4),
          );
        } catch (error) {
          record.traceError = error.message;
        }
      }
      if (/^IDirect3DDevice[89]\.SetTransform$/.test(name)) {
        try {
          record.matrix = Array.from({ length: 16 }, (_, i) =>
            hex(runtime.read32(args[2] + i * 4)),
          );
        } catch (error) {
          record.traceError = error.message;
        }
      }
      report.apiCalls.push(record);
      if (report.apiCalls.length > 64) report.apiCalls.shift();
      try {
        const next = await api(entry);
        record.result = hex(runtime.cpu.r[0].value);
        return next;
      } catch (error) {
        if (runtime.threads.isExit(error)) record.threadExit = true;
        else record.error = error.message;
        throw error;
      }
    };
    const dispatch = runtime.dispatch.bind(runtime);
    runtime.dispatch = async (...args) => {
      try {
        return await dispatch(...args);
      } catch (error) {
        if (runtime.threads.isExit(error)) throw error;
        report.firstFailure ??= {
          phase,
          threadId: runtime.threads.current?.id,
          message: error.message,
          ip: locate(lastIP),
          registers: runtime.cpu.r.map((r) => hex(r.value)),
          compiledBlocks: runtime.cpu.cache.size,
          instructions: runtime.cpu.instructions,
          recentBlocks: recentBlocks.slice(),
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
    runtime.tls.prepare(runtime.graph.modules.values());
    const modules = guestModules();
    const entry = ntdll.pe.exports.find((e) => e.name === 'WineBrowserLoaderBootstrap');
    if (!entry || entry.forwarder) throw Error('Source-built loader export missing');
    const allocated = [];
    try {
      const table = runtime.allocate(modules.length * 16);
      allocated.push(table);
      modules.forEach((module, i) => {
        const name = runtime.allocString(wineModulePath(module), true);
        allocated.push(name);
        [
          16,
          module.base,
          name,
          (module === runtime.graph.main ? 1 : module === ntdll ? 2 : 0) |
            (module.initialized ? 4 : 0) |
            (runtime.tls.records.has(module) ? 8 : 0),
        ].forEach((value, n) => runtime.write32(table + i * 16 + n * 4, value));
      });
      const batch = runtime.allocate(16);
      allocated.push(batch);
      [16, 1, modules.length, table].forEach((value, n) => runtime.write32(batch + n * 4, value));
      if (testStaticTLS) {
        const index = modules.findIndex((m) => runtime.tls.records.has(m));
        if (index < 0) throw Error('Static TLS validation requires a TLS image');
        const module = modules[index],
          flag = table + index * 16 + 12;
        const value = runtime.read32(flag),
          vectorAddress = 0x2e0002c;
        const tlsIndexAddress = module.base + module.pe.tls.indexRva;
        for (const [label, address, invalid, expected] of [
          ['missing ownership flag', flag, value & ~8, 0xc00000bb],
          ['unprepared vector', vectorAddress, 0, 0xc000000d],
          ['out-of-range static slot', tlsIndexAddress, 128, 0xc000000d],
        ]) {
          const saved = runtime.read32(address);
          try {
            runtime.write32(address, invalid);
            const status = await runtime.callGuest(ntdll.base + entry.rva, [batch]);
            if (status !== expected) throw Error(`TLS ${label}: unexpected ${hex(status)}`);
            const peb = runtime.read32(0x2e00030);
            if (runtime.read32(peb + 0xc) || runtime.read32(peb + 0xa0))
              throw Error('Invalid TLS batch published Wine loader metadata');
            report.phases.push({ name: 'static TLS rejects ' + label, passed: true });
          } finally {
            runtime.write32(address, saved);
          }
        }
      }
      const status = await runtime.callGuest(ntdll.base + entry.rva, [batch]);
      if (status) throw Error(`WineBrowserLoaderBootstrap returned ${hex(status)}`);
    } finally {
      for (const pointer of allocated) runtime.free(pointer);
    }
    report.phases.push({ name: phase, passed: true });
    phase = 'source loader callbacks';
    await new WineLoader(runtime, ntdll).enable();
    report.phases.push({ name: phase, passed: true });
    phase = 'guest DLL attach';
    await runtime.initializeModules();
    report.phases.push({ name: phase, passed: true });
    phase = 'native EXE entry point';
    await runtime.tls.attach(runtime.graph.main);
    const result = await runtime.runEntryPoint();
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
    report.threadsAtStop =
      runtime &&
      [...runtime.threads.records.values()].map((t) => ({
        id: t.id,
        teb: hex(t.teb),
        started: !!t.started,
        attached: !!t.attached,
        suspended: t.suspend,
        exited: t.done,
        exitCode: t.code,
      }));
    for (const [dll, previous] of restore) {
      if (previous) API_NAMES[dll] = previous;
      else delete API_NAMES[dll];
    }
    await runtime?.threads.stopOthers();
    runtime?.directSound?.dispose();
    runtime?.syncObjects?.dispose();
    runtime?.windows.dispose();
    runtime?.cpu.dispose();
    graphics12?.dispose();
    graphics?.dispose();
  }
  return report;
}
