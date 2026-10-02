import { GuestHeap } from './heap.js';
import { PROCESS_LAYOUT, initializeProcessLayout } from './process-layout.js';
import { VirtualMemory } from './virtual-memory.js';
import { SectionViews } from './section-views.js';
import { createNlsState } from './wine-nls.js';
import { cleanupWineNlsProcess } from './wine-nls-process.js';
import { installWineNtBridge, dispatchWineNt } from './wine-nt.js';
import {
  initializeWineProcess,
  snapshotWineProcessPointers,
  restoreWineProcessPointers,
} from './wine-process.js';
import { bootstrapWineLoader } from './wine-loader.js';
import { StaticTLS } from './tls.js';
import { WindowManager } from './win32-windows.js';
import { flushGdi } from './win32-gdi.js';
import { CPU } from './cpu.js';
import { parsePE } from './pe.js';
import { ModuleGraph } from './modules.js';
import { GuestMemory } from './memory.js';
import { API_NAMES, createWin32ApiProvider, importKey } from './win32.js';
import { initializeApiSetNamespace } from './api-set-namespace.js';
import { GuestPerformanceClock } from './guest-clock.js';
import { createSharedUserData, systemFileTime } from './shared-user-data.js';
import { canonicalHostSymbol } from './host-export-ordinals.js';
import { GuestThreads } from './guest-threads.js';
import { THUNK_BASE, THUNK_END } from './thunk-addresses.js';
import { yieldToHost, yieldToTimer } from './host-yield.js';
import { GuestUnwind, deliverGuestException, isGuestFault, unwindExceptionChain } from './seh.js';

export { API_NAMES };

export function inspect(bytes, files, exe, builtinFiles) {
  const pe = parsePE(bytes);
  let unsupported;
  if (files && exe) {
    const graph = new ModuleGraph(files, exe, API_NAMES, builtinFiles);
    unsupported = graph.unresolved.map((u) => u.error);
  } else
    unsupported = pe.imports
      .filter((i) => {
        const dll = i.dll.toLowerCase();
        return !API_NAMES[dll]?.includes(
          canonicalHostSymbol(dll, i.name ?? i.ordinal, API_NAMES[dll]),
        );
      })
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
      nlsFiles,
      graphics,
      graphics12,
      opengl,
      performanceNow,
      systemNow = () => Date.now(),
      hostModuleImages = true,
    },
  ) {
    this.files = new Map([...files].map(([path, bytes]) => [path, bytes.slice()]));
    this.exe = exe;
    this.cwd = exe.includes('/') ? exe.slice(0, exe.lastIndexOf('/') + 1) : '';
    this.emit = emit;
    this.request = (kind, detail) => {
      flushGdi(this);
      return this.threads.block(request(kind, detail));
    };
    this.maxBlocks = maxBlocks;
    this.lastProgress = performance.now();

    this.args = args;
    this.graphics = graphics;
    this.graphics12 = graphics12;
    this.opengl = opengl;
    this.performanceClock = new GuestPerformanceClock(performanceNow);
    this.systemNow = systemNow;
    this.packageFileTime = systemFileTime(systemNow());
    this.graph = new ModuleGraph(this.files, exe, API_NAMES, builtinFiles, { hostModuleImages });
    // A host export that is data (msvcrt's _iob and the other CRT globals) must
    // reach the guest as the address of that storage, not as the address of the
    // thunk that would create it. The import patch records those IAT slots; the
    // addresses are written once the heap and API provider exist, below.
    // 256 MiB of guest address space. Real Windows programs and self-unpacking
    // libraries reserve far more than the original 64 MiB budget, and a PE32
    // process has room for it; the TEB/heap/stack keep their fixed low layout
    // and the virtual-memory arena grows into the space above them.
    this.memory = new WebAssembly.Memory({ initial: 4096, maximum: 4096 });
    this.regions = [{ start: 0x2e00000, end: 0x4000000, write: true, exec: false }];
    this.graph.map(this.memory, this.regions);
    this.pe = this.graph.main.pe;
    this.guestMemory = new GuestMemory(this.memory, this.regions, {
      onCodeWrite: (address, size) => this.cpu?.invalidateRange(address, size),
      readOnlyViews: [createSharedUserData(this.performanceClock, this.systemNow)],
    });
    this.virtualMemory = new VirtualMemory(this.memory, this.regions);
    this.sectionViews = new SectionViews(this.memory, this.regions, this.virtualMemory);
    this.nls = createNlsState(this.files, this.cwd, nlsFiles);
    this.view = this.guestMemory.view;
    this.data = this.guestMemory.data;
    this.cpu = new CPU(iced, {
      memory: this.memory,
      read32: (a) => this.read32(a),
      write32: (a, v) => this.write32(a, v),
      read: (a, w) => this.guestMemory.read(a, w),
      readBytes: (a, size) => this.guestMemory.readBytes(a, size),
      write: (a, v, w) => this.guestMemory.write(a, v, w),
      check: (address, size, write) => this.guestMemory.check(address, size, write),
      executableRanges: [],
      fsBase: PROCESS_LAYOUT.teb,
      performanceCounter: () => this.performanceClock.read(),
    });
    this.refreshCodeRanges();
    this.thunks = this.graph.thunks;
    this.heap = new GuestHeap(this.memory, undefined, undefined, (count) => {
      // Keep the fixed low heap ABI, then acquire committed arenas through the
      // same allocator native VirtualAlloc uses, avoiding mapped images/stacks.
      const size = Math.ceil(Math.max(count, 4 * 1024 * 1024) / 0x10000) * 0x10000;
      const allocation = this.virtualMemory.allocate(0, size, 0x3000, 0x04);
      return allocation.status === 0 ? [allocation.base, allocation.base + allocation.size] : null;
    });
    this.tls = new StaticTLS(this);
    this.windows = new WindowManager(this);
    this.allocations = this.heap.allocations;
    this.callDepth = 0;
    initializeProcessLayout(this);
    this.apiSetMap = initializeApiSetNamespace(this);
    this.handles = new Map();
    this.nextHandle = 256;
    this.lastError = 0;
    this.exitCode = null;
    this.shutdownState = 'idle';
    this.dirty = new Set();
    this.calls = 0;
    // The first 2048 interceptions in order, for tracing call sequences, and a
    // complete deduplicated set of every API/COM method the guest reached.
    // A real application makes far more than 2048 calls, so the bounded trace
    // alone cannot answer "which APIs did this program use?". The set is what
    // diagnostics and compatibility reporting read.
    this.apiTrace = [];
    this.apiNames = new Set();
    // The most recent interceptions with their arguments. A packed image that
    // faults after an OS call needs the call, not just a stack address.
    this.apiRing = [];
    this.blocks = 0;
    this.apiProvider = createWin32ApiProvider();
    // Now that the heap and provider exist, point every host data-export IAT
    // slot at the storage its handler materializes (the CRT globals).
    for (const slot of this.graph.hostDataSlots ?? []) {
      const handler = this.apiProvider.get(importKey(slot.dll, slot.symbol));
      if (!handler) continue;
      // The import table lives in a read-only image section and the loader has
      // already patched it, so this write goes through the raw view exactly like
      // the loader's own IAT patching, not through the checked guest path.
      this.view.setUint32(slot.iat, handler(this).result >>> 0, true);
    }
    this.threads = new GuestThreads(this);
    // Module transactions may await guest callbacks. Keep their graph/TLS
    // mutations serialized even when another thread becomes runnable.
    for (const name of ['initializeModules', 'withModuleLoad', 'freeLibrary']) {
      const method = this[name];
      this[name] = (...args) => this.threads.withLoaderLock(() => method.apply(this, args));
    }
  }

  get lastError() {
    return this.read32(this.cpu.fsBase + 0x34);
  }
  set lastError(value) {
    this.write32(this.cpu.fsBase + 0x34, value);
  }

  check(address, size, write = false) {
    return this.guestMemory.checkLinear(address, size, write);
  }

  recordApi(name, argument) {
    const args = [];
    for (let i = 0; i < 6; i++) {
      try {
        args.push('0x' + (argument(i) >>> 0).toString(16));
      } catch {
        break;
      }
    }
    // The caller's address, read from the stack slot the thunk is about to pop.
    // Without it a call's arguments cannot be tied back to the site that made
    // it, which is what a packed or statically-linked image needs.
    const stack = this.cpu.r[4].value >>> 0;
    const caller = this.guestMemory.read32(stack);
    this.apiRing.push({ name, args, caller: '0x' + (caller >>> 0).toString(16) });
    if (this.apiRing.length > 64) this.apiRing.shift();
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
    // Host imports may use stdcall or cdecl. Both pop the return address;
    // only stdcall removes arguments before the guest resumes.
    const stackPointer = this.cpu.r[4].value >>> 0;
    const argument = (index) => this.read32(stackPointer + 4 + index * 4);
    let response;
    if (entry.kind === 'wine-nt') response = await dispatchWineNt(this, entry);
    else if (entry.kind === 'com' || entry.kind === 'wine-loader' || entry.kind === 'wine-unix') {
      this.calls++;
      this.apiNames.add(entry.name);
      if (this.apiTrace.length < 2048) this.apiTrace.push(entry.name);
      this.recordApi(entry.name, argument);
      try {
        response = await entry.invoke(this, argument);
      } catch (error) {
        // A COM failure usually names only a pointer or a state; adding the
        // vtable method makes the failing call identifiable in the log. The
        // message is rewritten in place so the error's class and stack survive
        // — guest-thread cancellation, for example, is recognised by type.
        if (error instanceof Error && !error.message.startsWith(entry.name + ':'))
          error.message = `${entry.name}: ${error.message}`;
        throw error;
      }
    } else {
      const handler = this.apiProvider.get(importKey(entry.dll, entry.name));
      if (!handler) throw Error(`Unimplemented import ${importKey(entry.dll, entry.name)}`);
      this.calls++;
      this.apiNames.add(importKey(entry.dll, entry.name));
      if (this.apiTrace.length < 2048) this.apiTrace.push(importKey(entry.dll, entry.name));
      this.recordApi(importKey(entry.dll, entry.name), argument);
      response = await handler(this, argument);
    }
    const { result, resultHigh, argc, convention = 'stdcall', jumpTo } = response;
    if (convention !== 'stdcall' && convention !== 'cdecl')
      throw Error(`Unsupported host import convention: ${convention}`);
    // A handler that transfers control itself (longjmp restores the saved
    // stack and frame) reports the destination instead of returning normally.
    // The pop is skipped because the handler has already replaced ESP.
    if (jumpTo !== undefined) {
      this.cpu.r[0].value = result | 0;
      if (resultHigh !== undefined) this.cpu.r[2].value = resultHigh | 0;
      return jumpTo >>> 0;
    }
    const returnAddress = this.cpu.pop() >>> 0;
    if (convention === 'stdcall') this.cpu.r[4].value = (this.cpu.r[4].value + argc * 4) | 0;
    this.cpu.r[0].value = result | 0;
    if (resultHigh !== undefined) this.cpu.r[2].value = resultHigh | 0;
    return returnAddress;
  }

  refreshCodeRanges() {
    this.cpu.ranges = this.regions.filter((r) => r.exec).map((r) => [r.start, r.end, !!r.write]);
  }

  /**
   * A page's access changed between readable/writable and executable.
   *
   * The decoder's address ranges and the translated-block cache are derived
   * from `regions`, and both go stale: bytes that just became executable have
   * no blocks yet and rights that just disappeared must stop running, while a
   * writable-executable page can have had its code replaced in place. Refreshing
   * the ranges plus dropping the blocks that overlap the changed pages keeps
   * execution consistent with the new protection.
   */
  onMemoryProtectionChanged(start, size, access) {
    this.refreshCodeRanges();
    if (access.exec || this.cpu?.cache.size === 0) this.cpu?.invalidateRange(start, size);
  }
  allocate(size, zero = true) {
    return this.heap.allocate(size, zero);
  }
  free(address) {
    return this.heap.free(address);
  }
  reallocate(address, size, zero = false) {
    return this.heap.reallocate(address, size, zero);
  }
  allocationSize(address) {
    return this.heap.allocationSize(address);
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
    const thread = this.threads.current;
    while (this.exitCode === null && ip !== until) {
      this.threads.checkRunning(thread);
      if (++this.blocks > this.maxBlocks) throw Error('Execution block budget exceeded');
      // Host thunks live in their own high address range; guest code, mapped
      // images and virtual allocations never do, so the common case skips the
      // map lookup entirely.
      const thunk = ip >= THUNK_BASE && ip < THUNK_END ? this.thunks.get(ip) : undefined;
      if (thunk) {
        try {
          ip = await this.api(thunk);
        } catch (error) {
          if (!(error instanceof GuestUnwind)) throw error;
          // RtlUnwind never returns: walk the chain, then resume at the frame
          // that accepted the exception with its return value in EAX.
          await this.unwindGuest(error);
          // RtlUnwind's TargetIp, when non-zero, is where control resumes. The
          // CRT passes 0 and relies on the accepting frame's own stack instead,
          // which the unwind walk has already restored.
          ip = error.targetIp || this.cpu.r[0].value >>> 0;
        }
      } else {
        const preparation = this.cpu.prepare(ip);
        if (preparation) await preparation;
        try {
          ip = this.cpu.step(ip);
        } catch (error) {
          if (!isGuestFault(error)) throw error;
          // The register file and the operands it points at describe the fault
          // itself, but the exception search runs guest handlers that clobber
          // them. Snapshot both here, before any handler can run.
          error.faultRegisters ??= this.cpu.r.map((register) => register.value >>> 0);
          error.faultMemory ??= this.captureFaultMemory(error.faultRegisters);
          // A guest access fault may be the signal an application's own
          // __try/__except is waiting for. Offer it to the registration chain
          // at fs:[0]; only an unhandled fault still stops the run.
          const delivered = await this.deliverException(error);
          if (!delivered.handled) {
            error.guestDiagnostic = this.describeFault(error, delivered);
            throw error;
          }
          ip = delivered.resume;
        }
      }
      if (this.blocks % 2048 === 0) {
        flushGdi(this);
        const now = performance.now();
        if (now - this.lastProgress >= 1000) {
          this.lastProgress = now;
          this.emit({
            type: 'progress',
            blocks: this.blocks,
            compiledBlocks: this.cpu.cache.size,
            totalCompiledBlocks: this.cpu.compilations,
            x86TranslationMs: this.cpu.translationMs,
            instructions: this.cpu.instructions,
            apiCalls: this.calls,
          });
        }
        // A MessageChannel macrotask yields to the host without the multi-
        // millisecond clamp browsers apply to nested timers. A timer yield is
        // still interleaved periodically so timer-driven host work (stop
        // requests, input, deadlines) is observed promptly.
        if (this.blocks % (2048 * 16) === 0) await yieldToTimer();
        else await yieldToHost();
        await this.threads.yield();
      }
    }
    return ip;
  }
  /**
   * Offers a guest fault to the exception registration chain at fs:[0].
   *
   * Each handler is invoked as a guest function with the cdecl convention, and
   * a handler that returns ExceptionContinueExecution resumes the faulting
   * thread at the (possibly repaired) context EIP. A fault with no chain, or
   * one every handler declines, is reported as unhandled so the caller stops
   * the run exactly as it did before.
   */
  async deliverException(fault) {
    const faultEip = this.cpu.instructionIp;
    fault.faultEip = faultEip;
    const result = await deliverGuestException({
      read32: (pointer) => this.guestMemory.read32(pointer),
      write32: (pointer, value) => this.guestMemory.write32(pointer, value),
      cpu: this.cpu,
      fsBase: this.cpu.fsBase,
      allocate: (bytes) => this.allocate(bytes),
      callHandler: (handler, args) => this.callGuest(handler, args, 'cdecl'),
      fault,
    });
    this.emit({
      type: 'log',
      text:
        `Guest fault at 0x${(fault.faultEip >>> 0).toString(16)}: ` +
        `${result.frames} exception frame(s) walked, handled=${result.handled}`,
    });
    return result;
  }

  /**
   * Attaches reproducible context to an unhandled guest fault: the failing
   * instruction, the guest call stack, the register file and the faulting
   * access. Without it a stop is only an address; with it the same location can
   * be re-inspected (and reproduced) instead of guessed at.
   */
  describeFault(error, delivered) {
    const hex = (value) => '0x' + (value >>> 0).toString(16);
    const registers = error.faultRegisters ?? this.cpu.r.map((register) => register.value >>> 0);
    const locate = (address) => {
      const found = this.graph.modules
        ? [...this.graph.modules.values()].find(
            (module) => address >= module.base && address < module.base + module.pe.imageSize,
          )
        : null;
      return found
        ? { module: found.name, offset: hex(address - found.base), address: hex(address) }
        : { address: hex(address) };
    };
    const frames = [];
    try {
      let frame = this.read32(this.cpu.fsBase) >>> 0;
      for (let n = 0; frame && frame !== 0xffffffff && n < 32; n++) {
        const next = this.read32(frame) >>> 0;
        const handler = this.read32(frame + 4) >>> 0;
        frames.push({ frame: hex(frame), handler: hex(handler), ...locate(handler) });
        if (next === frame) break;
        frame = next;
      }
    } catch {
      // A broken chain is itself worth reporting; keep what was read.
    }
    return {
      message: error.message,
      code: hex(error.sehCode ?? 0),
      access: {
        address: hex(error.sehAddress ?? 0),
        write: !!error.sehWrite,
        size: error.sehSize ?? 0,
      },
      eip: locate(error.faultEip ?? this.cpu.instructionIp ?? 0),
      // The bytes around the faulting instruction. Packed images decrypt their
      // own code, so the file on disk cannot show what actually executes here.
      code: (() => {
        try {
          const at = (error.faultEip ?? this.cpu.instructionIp ?? 0) >>> 0;
          // Decoding is only meaningful from a block boundary, so a generous
          // window lets a packed image's control flow be reconstructed.
          const start = (at - 96) >>> 0;
          return {
            start: '0x' + start.toString(16),
            bytes: [...this.guestMemory.data.slice(start, at + 48)].map((b) =>
              b.toString(16).padStart(2, '0'),
            ),
          };
        } catch {
          return null;
        }
      })(),
      registers: {
        eax: hex(registers[0]),
        ebx: hex(registers[3]),
        ecx: hex(registers[1]),
        edx: hex(registers[2]),
        esi: hex(registers[6]),
        edi: hex(registers[7]),
        ebp: hex(registers[5]),
        esp: hex(registers[4]),
      },
      // Oldest first: the execution path that reached the fault.
      recentBlocks: this.cpu.recentPath().map((address) => locate(address)),
      // The tail of the virtual-memory call log: a wild pointer is often one
      // allocation that returned an unexpected base.
      vmOperations: (this.virtualMemory.ops ?? []).slice(-64),
      // Raw bytes at the addresses the faulting instruction actually used, so a
      // bad index or table entry is visible without a second reproduction.
      memory: error.faultMemory ?? null,
      // The last OS calls the guest made, oldest first, and every distinct API
      // and COM method the program reached.
      recentApiCalls: this.apiRing.slice(-24),
      apiNames: [...this.apiNames].sort(),
      modules: this.graph.describe ? this.graph.describe() : [],
      exceptionFrames: frames,
      framesWalked: delivered?.frames ?? 0,
      instructions: this.cpu.instructions,
    };
  }

  /**
   * Reads the bytes around each register the faulting instruction used, at the
   * moment of the fault. A packed image's tables are frequently rewritten
   * between runs, so a later read would not show what the instruction saw.
   */
  captureFaultMemory(registers) {
    const windows = {};
    for (const [name, index] of [
      ['eax', 0],
      ['ecx', 1],
      ['edx', 2],
      ['ebx', 3],
      ['esp', 4],
      ['ebp', 5],
      ['esi', 6],
      ['edi', 7],
    ]) {
      const address = registers[index] >>> 0;
      try {
        windows[name] = {
          address: '0x' + address.toString(16),
          bytes: [...this.guestMemory.data.slice(address - 16, address + 48)].map((byte) =>
            byte.toString(16).padStart(2, '0'),
          ),
        };
      } catch {
        // An unmapped register value is itself informative; omit it.
      }
    }
    return windows;
  }

  /** Performs the RtlUnwind walk a guest handler requested. */
  async unwindGuest(unwind) {
    // The walk runs from the chain head to the frame whose __finally is
    // executing. Once it completes, that frame continues with the return value
    // RtlUnwind was given, on the stack its own caller left.
    const result = await unwindExceptionChain({
      read32: (pointer) => this.guestMemory.read32(pointer),
      write32: (pointer, value) => this.guestMemory.write32(pointer, value),
      cpu: this.cpu,
      fsBase: this.cpu.fsBase,
      allocate: (bytes) => this.allocate(bytes),
      callHandler: (handler, args) => this.callGuest(handler, args, 'cdecl'),
      endFrame: unwind.endFrame,
      resumeEsp: this.cpu.r[4].value >>> 0,
      retval: unwind.retval,
      faultEip: unwind.faultEip,
    });
    this.emit({
      type: 'log',
      text: `Guest structured unwind: ${result.delivered} handler(s) walked`,
    });
    return result;
  }

  async callGuest(address, args = [], convention = 'stdcall') {
    if (++this.callDepth > 32) throw Error('Guest callback depth exceeded');
    // Host-driven callbacks isolate CPU state, including the x87 stack.
    // Direct guest CALLs remain native and can return an x87 value in ST(0).
    const saved = this.cpu.captureContext(),
      sentinel = 0xffff0000 + this.callDepth * 16;
    try {
      for (const arg of [...args].reverse()) this.cpu.push(arg);
      this.cpu.push(sentinel);
      await this.dispatch(address, sentinel);
      const result = this.cpu.r[0].value >>> 0;
      if (this.exitCode === null) {
        if (convention === 'cdecl') this.cpu.r[4].value += args.length * 4;
        if (this.cpu.r[4].value !== saved.registers[4])
          throw Error('Guest callback stack imbalance');
      }
      return result;
    } finally {
      this.cpu.restoreContext(saved);
      this.callDepth--;
    }
  }
  async initializeModules() {
    this.tls.prepare(this.graph.modules.values());
    for (const module of this.graph.modules.values()) installWineNtBridge(this, module);
    const ntdll = this.graph.modules.get('ntdll.dll');
    if (ntdll) await initializeWineProcess(this, ntdll);
    await this.wineLoader?.sync();
    for (const module of this.graph.initializationOrder()) {
      if (module.initialized || module.initializing || module.detaching || module.detached)
        continue;
      if (this.shutdownState !== 'idle')
        throw Error('Loading new DLLs during process shutdown is unsupported');
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
        await this.wineLoader?.sync();
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
      processPointers = snapshotWineProcessPointers(this);
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
          !checkpoint.modules.get(module.key)?.state.initialized &&
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
      await this.wineLoader?.forget(
        [...this.graph.modules.values()].filter((module) => !checkpoint.modules.has(module.key)),
      );
      for (const module of this.graph.modules.values()) {
        if (module.ntBridge?.tebSlot && !checkpoint.modules.get(module.key)?.state.ntBridge)
          this.write32(module.ntBridge.tebSlot, 0);
        if (module.mapped && !checkpoint.modules.get(module.key)?.state.mapped) {
          this.cpu.invalidateRange(module.base, module.pe.imageSize);
          this.data.fill(0, module.base, module.base + module.pe.imageSize);
        } else if (module.ntBridge && !checkpoint.modules.get(module.key)?.state.ntBridge)
          this.write32(module.ntBridge.slot, 0);
      }
      if (this.wineProcess && this.wineProcess !== wineProcess) {
        cleanupWineNlsProcess(this, this.wineProcess.nls);
        for (const base of this.wineProcess.reservations) this.virtualMemory.free(base, 0, 0x8000);
        if (ntdllBeforeBootstrap) {
          this.cpu.invalidateRange(existingNtdll.base, existingNtdll.pe.imageSize);
          this.data.set(ntdllBeforeBootstrap, existingNtdll.base);
        }
      }
      this.graph.restore(checkpoint);
      await this.wineLoader?.sync();
      this.wineProcess = wineProcess;
      restoreWineProcessPointers(this, processPointers);
      // DLL callbacks may have changed process virtual allocations. Remove
      // only rolled-back images; preserve the memory manager's current state.
      const retained = this.regions.filter(
        (region) => !region.module || checkpoint.modules.get(region.module)?.state.mapped,
      );
      this.regions.splice(0, this.regions.length, ...retained);
      this.refreshCodeRanges();
      if (!guestStarted) error.win32Error ??= missingError;
      throw error;
    }
  }
  async loadLibrary(name, options = {}) {
    const module = await this.withModuleLoad(() => this.graph.load(name, true, options));
    return module.base;
  }
  async freeLibrary(base) {
    // Wine's LdrUnloadDll ignores unload requests during process detach.
    // The single shutdown pass owns the remaining TLS/DllMain notifications.
    if (this.shutdownState === 'running' || this.shutdownState === 'complete') return true;
    const module = [...this.graph.modules.values()].find((candidate) => candidate.base === base);
    if (!module || module.refs <= 0) {
      this.lastError = 6; // ERROR_INVALID_HANDLE
      return false;
    }
    module.refs--;

    // Startup imports, the executable, host shims, and Wine's process ntdll
    // remain roots. A dynamically loaded dependency remains live while any
    // retained module reaches it through its import/forwarder graph.
    const live = new Set(),
      visit = (candidate) => {
        if (!candidate || live.has(candidate)) return;
        live.add(candidate);
        for (const dependency of candidate.dependencies ?? []) visit(dependency);
      };
    for (const root of this.graph.startupModules) visit(root);
    for (const candidate of this.graph.modules.values())
      if (
        candidate.host ||
        candidate.pinned ||
        candidate.refs > 0 ||
        candidate === this.wineProcess?.module
      )
        visit(candidate);
    const removed = new Set(
      [...this.graph.modules.values()].filter((candidate) => !live.has(candidate)),
    );
    if (!removed.size) {
      await this.wineLoader?.sync();
      return true;
    }
    const removedNames = new Set(
      [...removed].filter((candidate) => candidate.host).map((candidate) => candidate.name),
    );
    const removedKeys = new Set([...removed].map((candidate) => candidate.key));

    const order = this.graph
      .initializationOrder()
      .reverse()
      .filter((candidate) => removed.has(candidate));
    for (const candidate of order) {
      await this.tls.detach(candidate);
      if (candidate.initialized && candidate.pe.entryPoint) {
        this.exitCode = null;
        await this.callGuest(candidate.pe.entryPoint, [candidate.base, 0, 0]);
      }
    }

    // Static TLS is per module. Use the same rollback machinery as failed
    // loads so the PE TLS index and TEB vector slot are restored before unmap.
    const keptTLS = new Map([...this.tls.records].filter(([candidate]) => !removed.has(candidate)));
    this.tls.restore({ vector: this.tls.vector, records: keptTLS });
    if (!keptTLS.size && this.tls.vector) {
      this.free(this.tls.vector);
      this.tls.vector = 0;
      this.write32(0x2e0002c, 0);
    }

    await this.wineLoader?.forget(removed);
    for (const candidate of removed) {
      if (
        candidate.ntBridge?.tebSlot &&
        this.read32(candidate.ntBridge.tebSlot) === candidate.ntBridge.address
      )
        this.write32(candidate.ntBridge.tebSlot, 0);
      if (candidate.ntBridge && this.read32(candidate.ntBridge.slot) === candidate.ntBridge.address)
        this.write32(candidate.ntBridge.slot, 0);
      if (candidate.mapped) {
        // Blocks read guest memory and dispatch branch addresses at execution
        // time. Only bytes in the disappearing image become stale; callers
        // and other DLLs can retain their already translated blocks.
        this.cpu.invalidateRange(candidate.base, candidate.pe.imageSize);
        this.data.fill(0, candidate.base, candidate.base + candidate.pe.imageSize);
        candidate.mapped = false;
        candidate.base = 0;
      }
      this.graph.modules.delete(candidate.key);
    }
    for (const [address, thunk] of this.graph.thunks)
      if (removedNames.has(thunk.dll)) this.graph.thunks.delete(address);
    this.regions.splice(
      0,
      this.regions.length,
      ...this.regions.filter((region) => !removedKeys.has(region.module)),
    );
    this.refreshCodeRanges();
    await this.wineLoader?.sync();
    return true;
  }
  async resolveExport(module, symbol) {
    const target = await this.withModuleLoad(() => this.graph.resolve(module, symbol), 127);
    return this.graph.address(target);
  }
  async run() {
    try {
      return await this.#runProcess();
    } finally {
      await this.threads.stopOthers();
      this.directSound?.dispose();
      this.syncObjects?.dispose();
      this.windows.dispose();
      this.cpu.dispose();
    }
  }
  async shutdownProcess() {
    if (this.shutdownState === 'failed') throw this.shutdownError;
    if (this.shutdownState !== 'idle' || this.nativeProcessTerminated) return;
    this.shutdownState = 'running';
    const originalExit = this.exitCode;
    const thread = this.threads.current,
      cleanup = thread.cleanup;
    thread.cleanup = true;
    this.exitCode = null;
    try {
      await this.threads.stopOthers();
      // One owner for host ExitProcess and the native LdrShutdownProcess bridge.
      // Recursive shutdown from DllMain returns to the current detach pass.
      for (const module of this.graph.initializationOrder().reverse()) {
        if (!module.initialized) continue;
        module.detaching = true;
        try {
          await this.tls.detach(module);
          if (this.exitCode === null && module.pe.entryPoint)
            await this.callGuest(module.pe.entryPoint, [module.base, 0, 1]);
          module.initialized = false;
          module.detached = true;
        } finally {
          module.detaching = false;
        }
        if (this.exitCode !== null) break;
      }
      if (this.exitCode === null) await this.wineLoader?.sync();
      this.shutdownState = 'complete';
    } catch (error) {
      this.shutdownState = 'failed';
      this.shutdownError = error;
      throw error;
    } finally {
      this.exitCode ??= originalExit;
      thread.cleanup = cleanup;
    }
  }
  async #runProcess() {
    const started = performance.now();
    await bootstrapWineLoader(this);
    await this.initializeModules();
    await this.tls.attach(this.graph.main);
    const entryResult = await this.runEntryPoint();
    if (this.exitCode === null) this.exitCode = entryResult;
    // Wine's process shutdown notifies DLL TLS, not the main EXE's TLS callbacks.
    await this.shutdownProcess();
    flushGdi(this);
    return {
      exitCode: this.exitCode,
      modules: this.graph.describe(),
      apiTrace: this.apiTrace,
      apiNames: [...this.apiNames],
      blocks: this.blocks,
      instructions: this.cpu.instructions,
      compiledBlocks: this.cpu.cache.size,
      totalCompiledBlocks: this.cpu.compilations,
      x86TranslationMs: this.cpu.translationMs,
      wasmBytes: this.cpu.compiledBytes,
      apiCalls: this.calls,
      elapsedMs: performance.now() - started,
      outputs: [...this.dirty].map((path) => ({ path, bytes: this.files.get(path) })),
    };
  }
  async runEntryPoint() {
    let entryResult;
    try {
      entryResult = await this.callGuest(this.pe.entryPoint);
    } catch (error) {
      if (!this.threads.isExit(error)) throw error;
      entryResult = this.threads.main.code ?? this.exitCode ?? 0;
      if (this.exitCode === null) await this.threads.waitForChildren();
    }
    return this.exitCode ?? entryResult;
  }
}
