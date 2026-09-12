import { GuestHeap } from './heap.js';
import { VirtualMemory } from './virtual-memory.js';
import { installWineNtBridge, dispatchWineNt } from './wine-nt.js';
import { initializeWineProcess, PEB_PROCESS_HEAP } from './wine-process.js';
import { StaticTLS } from './tls.js';
import { flushGdi } from './win32-gdi.js';
import { CPU } from './cpu.js';
import { parsePE } from './pe.js';
import { ModuleGraph } from './modules.js';
import { GuestMemory } from './memory.js';
import { API_NAMES, createWin32ApiProvider, importKey } from './win32.js';

export { API_NAMES };

export function inspect(bytes, files, exe, builtinFiles) {
  const pe = parsePE(bytes);
  let unsupported;
  if (files && exe) {
    const graph = new ModuleGraph(files, exe, API_NAMES, builtinFiles);
    unsupported = graph.unresolved.map((u) => u.error);
  } else
    unsupported = pe.imports
      .filter((i) => !API_NAMES[i.dll.toLowerCase()]?.includes(i.name))
      .map((i) => importKey(i.dll, i.name ?? `#${i.ordinal}`));
  return { ...pe, unsupported };
}

export class Runtime {
  constructor(
    iced,
    {
      files,
      exe,
      emit = () => {},
      request = async (kind) => {
        throw Error(`Browser host request is unavailable: ${kind}`);
      },
      maxBlocks = 1_000_000,
      args = [],
      builtinFiles = new Map(),
    },
  ) {
    this.files = new Map([...files].map(([path, bytes]) => [path, bytes.slice()]));
    this.exe = exe;
    this.cwd = exe.includes('/') ? exe.slice(0, exe.lastIndexOf('/') + 1) : '';
    this.emit = emit;
    this.request = (kind, detail) => {
      flushGdi(this);
      return request(kind, detail);
    };
    this.maxBlocks = maxBlocks;

    this.args = args;
    this.graph = new ModuleGraph(this.files, exe, API_NAMES, builtinFiles);
    this.memory = new WebAssembly.Memory({ initial: 1024, maximum: 1024 });
    this.regions = [{ start: 0x2e00000, end: 0x4000000, write: true, exec: false }];
    this.graph.map(this.memory, this.regions);
    this.pe = this.graph.main.pe;
    this.guestMemory = new GuestMemory(this.memory, this.regions);
    this.virtualMemory = new VirtualMemory(this.memory, this.regions);
    this.view = this.guestMemory.view;
    this.data = this.guestMemory.data;
    this.cpu = new CPU(iced, {
      memory: this.memory,
      read32: (a) => this.read32(a),
      write32: (a, v) => this.write32(a, v),
      read: (a, w) => this.guestMemory.read(a, w),
      write: (a, v, w) => this.guestMemory.write(a, v, w),
      check: (address, size, write) => this.check(address, size, write),
      executableRanges: [],
      fsBase: 0x2e00000,
    });
    this.refreshCodeRanges();
    this.thunks = this.graph.thunks;
    this.heap = new GuestHeap(this.memory);
    this.tls = new StaticTLS(this);
    this.allocations = this.heap.allocations;
    this.callDepth = 0;
    this.write32(0x2e00000, 0xffffffff);
    this.write32(0x2e00018, 0x2e00000); // Exception chain and TEB self.
    this.write32(0x2e00004, 0x4000000); // TEB StackBase and StackLimit.
    this.write32(0x2e00008, 0x3c00000);
    this.write32(0x2e00020, 1); // CLIENT_ID: one guest process and one guest thread.
    this.write32(0x2e00024, 1);
    this.write32(0x2e00030, 0x2e01000); // PEB; more fields supplied by future NT host support.
    this.write32(0x2e01008, this.pe.imageBase);
    this.write32(0x2e01064, 1); // PEB.NumberOfProcessors: one logical guest processor.
    this.handles = new Map();
    this.nextHandle = 256;
    this.lastError = 0;
    this.exitCode = null;
    this.dirty = new Set();
    this.calls = 0;
    this.apiTrace = [];
    this.blocks = 0;
    this.apiProvider = createWin32ApiProvider();
  }

  check(address, size, write = false) {
    return this.guestMemory.check(address, size, write);
  }

  read32(address) {
    return this.guestMemory.read32(address);
  }

  write32(address, value) {
    return this.guestMemory.write32(address, value);
  }

  string(address) {
    return this.guestMemory.string(address);
  }

  async api(entry) {
    // PE import thunks use x86 stdcall: the guest leaves arguments on its
    // stack, so the host shim pops the return address and removes arguments.
    const stackPointer = this.cpu.r[4].value >>> 0;
    const argument = (index) => this.read32(stackPointer + 4 + index * 4);
    let response;
    if (entry.kind === 'wine-nt') response = await dispatchWineNt(this, entry);
    else {
      const handler = this.apiProvider.get(importKey(entry.dll, entry.name));
      if (!handler) throw Error(`Unimplemented import ${importKey(entry.dll, entry.name)}`);
      this.calls++;
      if (this.apiTrace.length < 2048) this.apiTrace.push(importKey(entry.dll, entry.name));
      response = await handler(this, argument);
    }
    const { result, argc } = response;
    const returnAddress = this.cpu.pop() >>> 0;
    this.cpu.r[4].value = (this.cpu.r[4].value + argc * 4) | 0;
    this.cpu.r[0].value = result | 0;
    return returnAddress;
  }

  refreshCodeRanges() {
    this.cpu.ranges = this.regions.filter((r) => r.exec).map((r) => [r.start, r.end]);
  }
  allocate(size, zero = true) {
    return this.heap.allocate(size, zero);
  }
  free(address) {
    return this.heap.free(address);
  }
  wideString(address) {
    if (!address) return '';
    let value = '';
    for (let n = 0; n < 32768; n++) {
      const c = this.guestMemory.read(address + n * 2, 2);
      if (!c) return value;
      value += String.fromCharCode(c);
    }
    throw Error('Unterminated UTF-16 string');
  }
  allocString(value, wide = false) {
    const address = this.allocate((value.length + 1) * (wide ? 2 : 1));
    for (let n = 0; n < value.length; n++)
      this.guestMemory.write(address + n * (wide ? 2 : 1), value.charCodeAt(n), wide ? 2 : 1);
    return address;
  }
  async dispatch(ip, until) {
    while (this.exitCode === null && ip !== until) {
      if (++this.blocks > this.maxBlocks) throw Error('Execution block budget exceeded');
      const thunk = this.thunks.get(ip);
      ip = thunk ? await this.api(thunk) : this.cpu.step(ip);
      if (this.blocks % 2048 === 0) {
        flushGdi(this);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return ip;
  }
  async callGuest(address, args = [], convention = 'stdcall') {
    if (++this.callDepth > 32) throw Error('Guest callback depth exceeded');
    const saved = this.cpu.r.map((r) => r.value),
      flags = { ...this.cpu.f },
      simd = this.cpu.simd.snapshot(),
      sentinel = 0xffff0000 + this.callDepth * 16;
    try {
      for (const arg of [...args].reverse()) this.cpu.push(arg);
      this.cpu.push(sentinel);
      await this.dispatch(address, sentinel);
      const result = this.cpu.r[0].value >>> 0;
      if (this.exitCode === null) {
        if (convention === 'cdecl') this.cpu.r[4].value += args.length * 4;
        if (this.cpu.r[4].value !== saved[4]) throw Error('Guest callback stack imbalance');
      }
      return result;
    } finally {
      saved.forEach((value, n) => (this.cpu.r[n].value = value));
      this.cpu.f = flags;
      this.cpu.simd.restore(simd);
      this.callDepth--;
    }
  }
  async initializeModules() {
    this.tls.prepare(this.graph.modules.values());
    for (const module of this.graph.modules.values()) installWineNtBridge(this, module);
    const ntdll = this.graph.modules.get('ntdll.dll');
    if (ntdll) await initializeWineProcess(this, ntdll);
    for (const module of this.graph.initializationOrder()) {
      if (module.initialized || module.initializing) continue;
      module.initializing = true;
      try {
        await this.tls.attach(module);
        if (this.exitCode !== null) return;
        if (
          module.pe.entryPoint &&
          !(await this.callGuest(module.pe.entryPoint, [module.base, 1, 0])) &&
          this.exitCode === null
        ) {
          const error = Error(`DllMain rejected process attach: ${module.name}`);
          error.win32Error = 1114; // ERROR_DLL_INIT_FAILED
          throw error;
        }
        module.initialized = true;
        if (this.exitCode !== null) return;
      } finally {
        module.initializing = false;
      }
    }
  }
  async withModuleLoad(resolve, missingError = 126) {
    const checkpoint = this.graph.checkpoint();
    const tlsCheckpoint = this.tls.checkpoint();
    const wineProcess = this.wineProcess,
      processHeap = this.read32(PEB_PROCESS_HEAP);
    const existingNtdll = checkpoint.modules.get('ntdll.dll')?.module;
    const ntdllBeforeBootstrap =
      !wineProcess && existingNtdll?.mapped
        ? this.data.slice(existingNtdll.base, existingNtdll.base + existingNtdll.pe.imageSize)
        : null;
    let guestStarted = false;
    try {
      const value = resolve();
      this.graph.map(this.memory, this.regions);
      this.refreshCodeRanges();
      guestStarted = true;
      await this.initializeModules();
      return value;
    } catch (error) {
      // Detach only dependencies whose attach succeeded during this load. A
      // rejected DLL itself must never become observable as initialized.
      for (const module of this.graph.initializationOrder().reverse()) {
        const beforeTLS = tlsCheckpoint.records.get(module),
          currentTLS = this.tls.records.get(module);
        if (
          currentTLS &&
          !beforeTLS?.attached &&
          (currentTLS.attached || currentTLS.callbacksRun > (beforeTLS?.callbacksRun ?? 0))
        ) {
          try {
            await this.tls.detach(module);
          } catch (detachError) {
            this.emit({ type: 'log', text: `TLS cleanup failed: ${detachError.message}` });
          }
        }
        if (
          module.initialized &&
          !checkpoint.modules.get(module.name)?.state.initialized &&
          module.pe.entryPoint
        ) {
          try {
            await this.callGuest(module.pe.entryPoint, [module.base, 0, 0]);
          } catch (detachError) {
            this.emit({ type: 'log', text: `DLL cleanup failed: ${detachError.message}` });
          }
        }
      }
      this.tls.restore(tlsCheckpoint);
      for (const module of this.graph.modules.values()) {
        if (module.ntBridge?.tebSlot && !checkpoint.modules.get(module.name)?.state.ntBridge)
          this.write32(module.ntBridge.tebSlot, 0);
        if (module.mapped && !checkpoint.modules.get(module.name)?.state.mapped)
          this.data.fill(0, module.base, module.base + module.pe.imageSize);
        else if (module.ntBridge && !checkpoint.modules.get(module.name)?.state.ntBridge)
          this.write32(module.ntBridge.slot, 0);
      }
      if (this.wineProcess && this.wineProcess !== wineProcess) {
        for (const base of this.wineProcess.reservations) this.virtualMemory.free(base, 0, 0x8000);
        if (ntdllBeforeBootstrap) this.data.set(ntdllBeforeBootstrap, existingNtdll.base);
      }
      this.graph.restore(checkpoint);
      this.wineProcess = wineProcess;
      this.write32(PEB_PROCESS_HEAP, processHeap);
      // DLL callbacks may have changed process virtual allocations. Remove
      // only rolled-back images; preserve the memory manager's current state.
      const retained = this.regions.filter(
        (region) => !region.module || checkpoint.modules.get(region.module)?.state.mapped,
      );
      this.regions.splice(0, this.regions.length, ...retained);
      this.refreshCodeRanges();
      this.cpu.cache.clear(); // Compiled code may refer to unloaded guest addresses.
      if (!guestStarted) error.win32Error = missingError;
      throw error;
    }
  }
  async loadLibrary(name) {
    const module = await this.withModuleLoad(() => this.graph.load(name, true));
    return module.base;
  }
  async resolveExport(module, symbol) {
    const target = await this.withModuleLoad(() => this.graph.resolve(module, symbol), 127);
    return this.graph.address(target);
  }
  async run() {
    const started = performance.now();
    await this.initializeModules();
    await this.tls.attach(this.graph.main);
    const entryResult = await this.callGuest(this.pe.entryPoint);
    if (this.exitCode === null) this.exitCode = entryResult;
    const processExit = this.exitCode;
    // Wine's process shutdown notifies DLL TLS, not the main EXE's TLS callbacks.
    for (const module of this.graph.initializationOrder().reverse())
      if (module.initialized) {
        this.exitCode = null;
        await this.tls.detach(module);
        if (module.pe.entryPoint) await this.callGuest(module.pe.entryPoint, [module.base, 0, 1]);
      }
    this.exitCode = processExit;
    flushGdi(this);
    return {
      exitCode: this.exitCode,
      modules: this.graph.describe(),
      apiTrace: this.apiTrace,
      blocks: this.blocks,
      instructions: this.cpu.instructions,
      compiledBlocks: this.cpu.cache.size,
      wasmBytes: this.cpu.compiledBytes,
      apiCalls: this.calls,
      elapsedMs: performance.now() - started,
      outputs: [...this.dirty].map((path) => ({ path, bytes: this.files.get(path) })),
    };
  }
}
