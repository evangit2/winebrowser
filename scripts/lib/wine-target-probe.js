import { Runtime, API_NAMES } from '../../src/runtime.js';
import { canonicalHostSymbol } from '../../src/host-export-ordinals.js';
import { parsePE } from '../../src/pe.js';
import { installWineNtBridge } from '../../src/wine-nt.js';
import { initializeWineProcess } from '../../src/wine-process.js';
import { WebGPURenderer } from '../../src/webgpu-renderer.js';
import { D3D12Renderer } from '../../src/d3d12-renderer.js';
import { WineLoader, wineModulePath } from '../../src/wine-loader.js';
import { resolveApiSet } from '../../src/api-sets.js';

const silentIterator = (iterable) =>
  iterable && typeof iterable[Symbol.iterator] === 'function' ? iterable : [];
const hex = (value) => `0x${(value >>> 0).toString(16)}`;

// Diagnostic only: missing host APIs get a trap address, never a success stub.
// The normal package loader continues rejecting unresolved imports up front.
export async function probeWineTarget(
  iced,
  { files, exe, builtinFiles, nlsFiles, testStaticTLS = false, limits = {} },
) {
  const report = {
    status: 'blocked-guest',
    scope:
      'Unchanged upstream PE with real Wine base DLLs and source-built loader metadata; unresolved host imports trap if reached. This is not normal harness compatibility.',
    phases: [],
    trappedImports: [],
    apiCalls: [],
    apiHistogram: {},
    blockHistogram: {},
    memorySamples: [],
    memorySampleKeys: new Set(),
    output: [],
    requests: [],
    frames: 0,
    nativeLoaderCalls: [],
    firstFailure: null,
    frameSamples: [],
    pendingSamples: [],
    diagnosticLimits: {
      maxBlocks: limits.maxBlocks ?? 10_000_000,
      maxExecutionMs: limits.maxExecutionMs ?? 45_000,
    },
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
    // A builtin guest DLL only satisfies imports it actually exports; anything
    // else still needs a host API (or an explicit trap) like any other module.
    const guestExports = new Map();
    for (const [name, bytes] of builtinFiles) {
      const base = name.split('/').at(-1).toLowerCase();
      if (!base.endsWith('.dll')) continue;
      const pe = parsePE(bytes, { allowDll: true });
      guestExports.set(
        base,
        new Map([
          ...pe.exports.filter((e) => e.name).map((e) => [e.name, true]),
          ...pe.exports.map((e) => [`#${e.ordinal}`, true]),
        ]),
      );
    }
    for (const imported of imports) {
      const dll = imported.dll.toLowerCase(),
        name = imported.name ?? `#${imported.ordinal}`;
      if (
        guestExports.get(resolveApiSet(dll))?.has(name) ||
        (nativeNames.has(resolveApiSet(dll)) && !guestExports.has(resolveApiSet(dll))) ||
        API_NAMES[dll]?.includes(canonicalHostSymbol(dll, name, API_NAMES[dll]))
      )
        continue;
      if (!restore.has(dll)) restore.set(dll, API_NAMES[dll]);
      API_NAMES[dll] = [...(API_NAMES[dll] ?? []), name];
      report.trappedImports.push(`${dll}!${name}`);
    }
    // Capture the pixels of the first few presented frames so the report
    // proves the guest actually rendered content, not just presented.
    const sampleFrame = async (message) => {
      if (report.frameSamples.length >= 3) return;
      const { bitmap } = message;
      if (!bitmap) return;
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set();
      let nonBackground = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const key = `${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`;
        if (colors.size < 64) colors.add(key);
        if (pixels[i] || pixels[i + 1] || pixels[i + 2]) nonBackground++;
      }
      const digest = new Uint8Array(
        await crypto.subtle.digest(
          'SHA-256',
          pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength),
        ),
      );
      report.frameSamples.push({
        windowId: message.windowId,
        width: canvas.width,
        height: canvas.height,
        graphicsApi: message.graphicsApi,
        graphicsFrames: message.graphicsFrames,
        graphicsDraws: message.graphicsDraws,
        corner: [...pixels.slice(0, 4)],
        colors: [...colors].sort().slice(0, 8),
        nonBackground,
        hash: [...digest].map((value) => value.toString(16).padStart(2, '0')).join(''),
      });
    };
    graphics = new WebGPURenderer({
      emit: (message) => {
        if (message.type === 'frame') {
          report.frames++;
          const pending = sampleFrame(message).catch((error) => {
            report.requests.push({ kind: 'frame-sample-error', text: error.message });
          });
          report.pendingSamples.push(pending);
        }
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
      const dispatch = ++dispatches;
      // Retain the guest's actual location if it spins, before the browser's
      // outer worker deadline discards the diagnostic state entirely.
      if (
        dispatch % 256 === 0 &&
        performance.now() - started > report.diagnosticLimits.maxExecutionMs
      )
        throw Error('Wine target diagnostic execution deadline exceeded');
      const stack = runtime.cpu.r[4].value >>> 0;
      // Loader-call records must never be missed: a program's dynamic imports
      // are the evidence for what it needed, even mid-startup.
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
      // Sampling the block histograms keeps the probe's own overhead far below
      // the guest work it measures while still locating hot blocks.
      if (dispatch % 8 === 0) {
        const hot = locate(ip);
        const hotKey = `${runtime.threads.current?.id ?? 0}:${hot.module ? `${hot.module}+${hot.offset}` : hot.address}`;
        report.blockHistogram[hotKey] = (report.blockHistogram[hotKey] ?? 0) + 1;
        if (report.blockHistogram.size > 200000) report.blockHistogram.clear();
        // Snapshot the runtime bytes of very hot blocks. Packed images
        // self-modify, so static disassembly of those regions is unusable.
        const HOT_SAMPLE_THRESHOLD = 20000;
        const sampled = report.blockHistogram[hotKey];
        if (
          hot.module &&
          sampled >= HOT_SAMPLE_THRESHOLD &&
          !report.memorySamples.some((entry) => entry.key.startsWith(hotKey + '@')) &&
          report.memorySamples.length < 16
        ) {
          try {
            const module = guestModules().find((m) => m.name === hot.module);
            const address = module.base + Number(BigInt(hot.offset));
            report.memorySamples.push({
              key: `${hotKey}@${sampled}`,
              bytes: [...runtime.data.slice(address, address + 64)].map((b) =>
                b.toString(16).padStart(2, '0'),
              ),
            });
          } catch {
            // Ignore samples outside mapped memory.
          }
        }
        recentBlocks.push({
          threadId: runtime.threads.current?.id,
          ...hot,
          registers: runtime.cpu.r.map((r) => hex(r.value)),
          flags: { ...runtime.cpu.f, af: runtime.cpu.af, df: runtime.cpu.df },
        });
        if (recentBlocks.length > 16) recentBlocks.shift();
      }
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
          'IDirect3DDevice8.DrawPrimitiveUP': 5,
          'IDirect3D9.DrawPrimitiveUP': 5,
          'IDirect3DVertexBuffer8.Lock': 5,
          'IDirect3DVertexBuffer9.Lock': 5,
          'IDirect3DIndexBuffer8.Lock': 5,
          'IDirect3DIndexBuffer9.Lock': 5,
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
      // Record the guest's virtual-memory requests so an allocator failure or
      // an uncommitted-page fault can be traced to the exact call sequence.
      if (name === 'NtAllocateVirtualMemory' || name === 'NtFreeVirtualMemory') {
        try {
          const allocate = name === 'NtAllocateVirtualMemory';
          const basePointer = args[1],
            sizePointer = allocate ? args[3] : args[2];
          report.vmCalls ??= [];
          if (report.vmCalls.length > 4096) report.vmCalls.shift();
          report.vmCalls.push({
            op: allocate ? 'alloc' : 'free',
            base: hex(runtime.read32(basePointer)),
            size: hex(runtime.read32(sizePointer)),
            type: allocate ? hex(args[4]) : hex(args[3]),
            sizeDwords: allocate ? [runtime.read32(sizePointer), runtime.read32(args[5])] : null,
          });
        } catch (error) {
          // Never let tracing change the guest's failure.
        }
      }
      if (/DrawPrimitiveUP$/.test(name) && args.length >= 5) {
        try {
          const primitive = args[1],
            count = args[2],
            pointer = args[3],
            stride = args[4];
          const vertices = primitive === 4 ? count * 3 : count + 2;
          record.draw = { primitive, count, pointer: hex(pointer), stride };
          if (stride > 0 && stride <= 256 && vertices * stride <= 4096) {
            record.draw.bytes = [...runtime.data.slice(pointer, pointer + vertices * stride)].map(
              (b) => b.toString(16).padStart(2, '0'),
            );
          }
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
      // A bounded histogram keeps every distinct call visible even when the
      // recent-call window saturates during a long render loop.
      const key = record.name + (record.error ? '!' + record.error : '');
      report.apiHistogram[key] = (report.apiHistogram[key] ?? 0) + 1;
      try {
        const next = await api(entry);
        record.result = hex(runtime.cpu.r[0].value);
        // Attach the status to the matching virtual-memory trace entry.
        if (
          (name === 'NtAllocateVirtualMemory' || name === 'NtFreeVirtualMemory') &&
          report.vmCalls?.length
        )
          report.vmCalls.at(-1).status = record.result;
        return next;
      } catch (error) {
        if (runtime.threads.isExit(error)) record.threadExit = true;
        else record.error = error.message;
        throw error;
      }
    };
    // Resolve a guest memory-violation address against the allocator's live
    // reservations so a fault can be classified without guesswork.
    const faultContext = (target, message) => {
      const match = /at 0x([0-9a-f]+)/i.exec(message ?? '');
      if (!match || !target?.virtualMemory) return null;
      const address = parseInt(match[1], 16);
      for (const reservation of target.virtualMemory.reservations.values())
        if (address >= reservation.base && address < reservation.end)
          return {
            address: hex(address),
            reservationBase: hex(reservation.base),
            reservationEnd: hex(reservation.end),
            committed: reservation.pages.get(address & ~0xfff) !== null,
          };
      return { address: hex(address), reservation: null };
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
          faultContext: faultContext(runtime, error.message),
          registers: runtime.cpu.r.map((r) => hex(r.value)),
          compiledBlocks: runtime.cpu.cache.size,
          compilations: runtime.cpu.compilations,
          instructions: runtime.cpu.instructions,
          recentBlocks: recentBlocks.slice(),
          blockHistogram: report.blockHistogram,
          memorySamples: report.memorySamples,
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
    const modules = guestModules().filter((module) => !module.proxy);
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
    // Let the bounded frame samplers finish before the graphics backend closes.
    await Promise.allSettled(report.pendingSamples);
    delete report.pendingSamples;
    delete report.memorySampleKeys;
    if (runtime?.virtualMemory?.stats) {
      try {
        report.virtualMemory = runtime.virtualMemory.stats();
        report.vmOps = runtime.virtualMemory.ops ?? [];
        // If the run failed on a memory violation, report the allocator history
        // for the reservation that contains the fault address.
        const message = report.firstFailure?.message ?? '';
        const match = /at 0x([0-9a-f]+)/i.exec(message);
        if (match) {
          const address = parseInt(match[1], 16),
            range = runtime.virtualMemory.rangeFor(address);
          report.faultRange = range && {
            base: hex(range.base),
            end: hex(range.end),
            committed: range.committed.map((r) => [hex(r.base), hex(r.end)]),
          };
          // Keep the last 80 guest virtual-memory calls; together with the
          // allocator history they identify the whole sequence for the run.
          report.vmCalls = report.vmCalls ?? [];
          report.vmHistory = (runtime.virtualMemory.history ?? []).filter(
            (entry) =>
              !range ||
              (parseInt(entry.end, 16) > range.base && parseInt(entry.base, 16) < range.end) ||
              (parseInt(entry.base, 16) <= address && parseInt(entry.end, 16) > address),
          );
        }
      } catch (error) {
        report.virtualMemory = { error: error.message };
      }
    }
    // Dump live kernel-sync objects and their handles. A thread parked on a
    // never-signaled object is a real hang, not a slow path.
    if (runtime?.syncObjects) {
      const sync = runtime.syncObjects;
      report.syncObjects = [...silentIterator(sync.handles)].map((handle) => {
        const entry = runtime.handles?.get(handle);
        return {
          handle: hex(handle),
          kind: entry?.kind ?? null,
          name: entry?.object?.name ?? null,
          manual: entry?.object?.manual ?? null,
          signaled: entry?.object?.signaled ?? null,
          count: entry?.object?.count ?? null,
          refs: entry?.object?.refs ?? null,
          waiters: [...silentIterator(sync.waiters)].filter((w) => w.handles.includes(handle))
            .length,
        };
      });
      report.parkedThreads = [...silentIterator(runtime.threads.records.values())].map((t) => ({
        id: t.id,
        parked: !!t.resume,
        waitingOn: t.cancel ? 'blocked' : 'running',
      }));
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
