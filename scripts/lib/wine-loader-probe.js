import { Runtime } from '../../src/runtime.js';
import { PROCESS_LAYOUT, PEB_PROCESS_HEAP } from '../../src/process-layout.js';
import { WineLoader, wineModulePath } from '../../src/wine-loader.js';
import { parsePE } from '../../src/pe.js';

// Shared by the optional Node and Chromium worker probes. Keep assertions in
// this test module so the browser runs the same rollback and ownership checks.
function equal(actual, expected, message = 'Unexpected guest result') {
  if (!Object.is(actual, expected)) throw Error(`${message}: expected ${expected}, got ${actual}`);
}
function different(actual, expected) {
  if (Object.is(actual, expected)) throw Error(`Guest value unexpectedly equals ${expected}`);
}
function same(actual, expected, message) {
  equal(JSON.stringify(actual), JSON.stringify(expected), message);
}

export async function probeWineLoader(iced, { files, dll, nlsFiles }) {
  const report = { status: 'blocked', cases: [] };
  let runtime;
  let phase = 'load rebuilt ntdll';
  try {
    runtime = new Runtime(iced, {
      files,
      exe: 'console.exe',
      builtinFiles: new Map([['ntdll.dll', dll]]),
      nlsFiles,
      hostModuleImages: true,
    });
    let lastIP;
    const step = runtime.cpu.step.bind(runtime.cpu);
    runtime.cpu.step = (ip) => {
      lastIP = ip >>> 0;
      try {
        return step(ip);
      } catch (error) {
        report.failure ??= {
          phase,
          message: error.message,
          instructionPointer: '0x' + lastIP.toString(16),
          registers: runtime.cpu.r.map((r) => '0x' + (r.value >>> 0).toString(16)),
        };
        throw error;
      }
    };
    await runtime.loadLibrary('ntdll.dll');
    phase = 'load independent guest DLL';
    await runtime.loadLibrary('math.dll');
    const ntdll = runtime.graph.modules.get('ntdll.dll');
    const math = runtime.graph.modules.get('math.dll');
    const symbol = (name) => runtime.resolveExport(ntdll, name);
    const invoke = async (name, args) => runtime.callGuest(await symbol(name), args);
    const bootstrap = await symbol('WineBrowserLoaderBootstrap');
    const modules = [runtime.graph.main, ntdll, math];
    const moduleTable = runtime.allocate(16 * modules.length);
    for (const [index, module] of modules.entries()) {
      const pointer = moduleTable + index * 16;
      runtime.write32(pointer, 16);
      runtime.write32(pointer + 4, module.base);
      runtime.write32(pointer + 8, runtime.allocString(wineModulePath(module), true));
      runtime.write32(
        pointer + 12,
        (index === 0 ? 1 : index === 1 ? 2 : 0) | (module.initialized ? 4 : 0),
      );
    }
    const batch = runtime.allocate(16);
    [16, 1, modules.length, moduleTable].forEach((value, index) =>
      runtime.write32(batch + index * 4, value),
    );
    const peb = PROCESS_LAYOUT.peb;
    const before = {
      heap: runtime.read32(PEB_PROCESS_HEAP),
      ldr: runtime.read32(peb + 0xc),
      lock: runtime.read32(peb + 0xa0),
      graph: runtime.graph.describe(),
    };
    let attachCalls = 0;
    const call = runtime.callGuest.bind(runtime);
    const trackStep = runtime.cpu.step;
    runtime.cpu.step = (ip) => {
      if (modules.some((module) => module.pe.entryPoint === ip >>> 0)) attachCalls++;
      return trackStep(ip);
    };
    const unchanged = () => {
      equal(runtime.read32(PEB_PROCESS_HEAP), before.heap, 'existing native process heap retained');
      same(runtime.graph.describe(), before.graph, 'host graph unchanged');
      equal(attachCalls, 0, 'no additional DLL entry points');
    };
    phase = 'invalid and duplicate registration';
    runtime.write32(batch + 4, 2);
    equal(await call(bootstrap, [batch]), 0xc000000d);
    runtime.write32(batch + 4, 1);
    const mathName = runtime.read32(moduleTable + 40);
    runtime.write32(moduleTable + 40, runtime.read32(moduleTable + 8));
    equal(await call(bootstrap, [batch]), 0xc0000035);
    runtime.write32(moduleTable + 40, mathName);
    equal(runtime.read32(peb + 0xc), before.ldr);
    equal(runtime.read32(peb + 0xa0), before.lock);
    unchanged();
    report.cases.push({ name: phase, passed: true });

    phase = 'allocation failure rollback';
    const allocate = await symbol('RtlAllocateHeap');
    const regularStep = runtime.cpu.step;
    let allocations = 0;
    runtime.cpu.step = (ip) => {
      if (ip >>> 0 === allocate && ++allocations === 4) {
        // Explicit diagnostic fault injection at the exported function boundary.
        // Fail the second module after the first has entered Wine's lists/tree.
        const returnAddress = runtime.cpu.pop() >>> 0;
        runtime.cpu.r[4].value += 12;
        runtime.cpu.r[0].value = 0;
        return returnAddress;
      }
      return regularStep(ip);
    };
    try {
      equal(await call(bootstrap, [batch]), 0xc0000017);
    } finally {
      runtime.cpu.step = regularStep;
    }
    equal(allocations, 4);
    equal(runtime.read32(peb + 0xc), before.ldr);
    equal(runtime.read32(peb + 0xa0), before.lock);
    unchanged();
    report.cases.push({
      name: phase,
      injection: 'fourth RtlAllocateHeap call returns null',
      passed: true,
    });

    phase = 'bootstrap after failed registration';
    equal(await call(bootstrap, [batch]), 0);
    different(runtime.read32(peb + 0xc), 0);
    different(runtime.read32(peb + 0xa0), 0);
    unchanged();
    equal(await call(bootstrap, [batch]), 0xc0000184);
    report.cases.push({
      name: phase,
      secondBootstrapRejected: true,
      sameHeap: true,
      noAdditionalAttach: true,
      passed: true,
    });

    phase = 'Wine RtlGetVersion';
    const version = runtime.allocate(284);
    runtime.write32(version, 284);
    equal(await invoke('RtlGetVersion', [version]), 0);
    equal(runtime.read32(version + 4), 10);
    equal(runtime.read32(version + 8), 0);
    equal(runtime.read32(version + 4), runtime.read32(peb + 0xa4));
    report.cases.push({
      name: phase,
      major: runtime.read32(version + 4),
      minor: runtime.read32(version + 8),
      build: runtime.read32(version + 12),
      passed: true,
    });

    phase = 'read-only Wine module lookups';
    const unicode = (text) => {
      const descriptor = runtime.allocate(8);
      runtime.guestMemory.write(descriptor, text.length * 2, 2);
      runtime.guestMemory.write(descriptor + 2, (text.length + 1) * 2, 2);
      runtime.write32(descriptor + 4, runtime.allocString(text, true));
      return descriptor;
    };
    const output = runtime.allocate(4);
    for (const module of modules) {
      equal(
        await invoke('LdrGetDllHandleEx', [1, 0, 0, unicode(module.name.toUpperCase()), output]),
        0,
      );
      equal(runtime.read32(output), module.base);
    }
    runtime.write32(output, 0xdeadbeef);
    equal(await invoke('LdrGetDllHandleEx', [1, 0, 0, unicode('missing.dll'), output]), 0xc0000135);
    equal(runtime.read32(output), 0xdeadbeef);
    equal(await invoke('LdrGetDllHandle', [0, 0, unicode('math.dll'), output]), 0);
    equal(runtime.read32(output), math.base);
    unchanged();
    report.cases.push({
      name: phase,
      modules: modules.map((m) => ({ name: m.name, base: m.base })),
      passed: true,
    });

    phase = 'unsupported loader ownership changes';
    for (const [name, args] of [
      ['LdrGetDllHandleEx', [0, 0, 0, unicode('math.dll'), output]],
      ['LdrGetDllHandleEx', [1, 0, 0, unicode('C:\\winebrowser\\math.dll'), output]],
      ['LdrLoadDll', [0, 0, unicode('math.dll'), output]],
      ['LdrUnloadDll', [math.base]],
      ['LdrAddRefDll', [0, math.base]],
      ['LdrGetProcedureAddress', [math.base, 0, 1, output]],
    ])
      equal(await invoke(name, args), 0xc00000bb, name);
    unchanged();
    equal(await runtime.callGuest(await runtime.resolveExport(math, 'sum'), [19, 23], 'cdecl'), 42);
    report.cases.push({ name: phase, guestDllStillCallable: true, passed: true });

    phase = 'native NT page protection';
    const memoryBase = runtime.allocate(4),
      memorySize = runtime.allocate(4),
      oldProtect = runtime.allocate(4);
    runtime.write32(memorySize, 4096);
    equal(
      await invoke('NtAllocateVirtualMemory', [0xffffffff, memoryBase, 0, memorySize, 0x3000, 4]),
      0,
    );
    const page = runtime.read32(memoryBase);
    runtime.write32(page, 0x12345678);
    equal(
      await invoke('NtProtectVirtualMemory', [0xffffffff, memoryBase, memorySize, 2, oldProtect]),
      0,
    );
    equal(runtime.read32(oldProtect), 4);
    let rejected = false;
    try {
      runtime.write32(page, 0);
    } catch {
      rejected = true;
    }
    equal(rejected, true, 'read-only page rejects guest writes');
    equal(
      await invoke('NtProtectVirtualMemory', [0xffffffff, memoryBase, memorySize, 4, oldProtect]),
      0,
    );
    equal(runtime.read32(oldProtect), 2);
    equal(runtime.read32(page), 0x12345678, 'protection changes preserve page contents');
    runtime.write32(page, 42);
    runtime.write32(memorySize, 0);
    equal(await invoke('NtFreeVirtualMemory', [0xffffffff, memoryBase, memorySize, 0x8000]), 0);
    report.cases.push({
      name: phase,
      restoredWritablePage: true,
      contentsRetained: true,
      passed: true,
    });

    phase = 'process and thread ownership guards';
    const raiseStatus = await symbol('RtlRaiseStatus');
    const guardedStep = runtime.cpu.step;
    const expectedStop = Error('Diagnostic stop at RtlRaiseStatus');
    const statuses = [];
    runtime.cpu.step = (ip) => {
      if (ip >>> 0 === raiseStatus) {
        statuses.push(runtime.read32((runtime.cpu.r[4].value >>> 0) + 4));
        throw expectedStop;
      }
      return guardedStep(ip);
    };
    try {
      for (const [name, args] of [
        ['LdrShutdownProcess', []],
        ['LdrShutdownThread', []],
        ['LdrInitializeThunk', [runtime.allocate(716), 0, 0, 0]],
      ]) {
        let stopped = false;
        try {
          await invoke(name, args);
        } catch (error) {
          if (error !== expectedStop) throw error;
          stopped = true;
        }
        equal(stopped, true, `${name} must reject a second lifecycle owner`);
        unchanged();
      }
    } finally {
      runtime.cpu.step = guardedStep;
    }
    same(statuses, [0xc00000bb, 0xc00000bb, 0xc00000bb], 'explicit lifecycle rejection statuses');
    report.cases.push({
      name: phase,
      passed: true,
      interception: 'stop at exported RtlRaiseStatus before unsupported guest exception dispatch',
      statuses,
    });
    phase = 'native loader callbacks and real host export tables';
    await new WineLoader(runtime, ntdll).enable();
    const ansi = (text) => {
      const descriptor = runtime.allocate(8);
      runtime.guestMemory.write(descriptor, text.length, 2);
      runtime.guestMemory.write(descriptor + 2, text.length + 1, 2);
      runtime.write32(descriptor + 4, runtime.allocString(text));
      return descriptor;
    };
    const kernel = runtime.graph.findLoaded('kernel32.dll');
    equal(await invoke('LdrLoadDll', [0, 0, unicode('KERNEL32'), output]), 0);
    equal(runtime.read32(output), kernel.base);
    equal(runtime.guestMemory.read(kernel.base, 2), 0x5a4d);
    equal(
      await invoke('LdrGetProcedureAddress', [kernel.base, ansi('GetLastError'), 0, output]),
      0,
    );
    const getLastError = runtime.read32(output);
    equal(getLastError, kernel.base + kernel.pe.exports.find((e) => e.name === 'GetLastError').rva);
    runtime.lastError = 42;
    equal(await runtime.callGuest(getLastError), 42);
    for (const registeredModule of [kernel, ntdll]) {
      equal(
        await invoke('LdrGetDllHandleEx', [
          1,
          0,
          0,
          unicode(wineModulePath(registeredModule)),
          output,
        ]),
        0,
      );
      equal(runtime.read32(output), registeredModule.base);
    }
    equal(await invoke('LdrUnloadDll', [kernel.base]), 0);
    runtime.write32(output, 0xdeadbeef);
    equal(await invoke('LdrLoadDll', [0, 0, unicode('missing.dll'), output]), 0xc0000135);
    equal(runtime.read32(output), 0xdeadbeef);
    equal(
      await invoke('LdrGetProcedureAddress', [math.base, ansi('missing'), 0, output]),
      0xc000007a,
    );
    equal(runtime.read32(output), 0xdeadbeef);
    report.cases.push({
      name: phase,
      realPeExports: true,
      unchangedFailureOutput: true,
      passed: true,
    });

    phase = 'native DLL refcounts, pinning and metadata removal';
    runtime.files.set('plugins/math.dll', files.get('math.dll').slice());
    const path = unicode('C:\\winebrowser\\plugins\\math.dll');
    equal(await invoke('LdrLoadDll', [0, 0, path, output]), 0);
    const dynamicBase = runtime.read32(output);
    different(dynamicBase, math.base);
    const dynamic = [...runtime.graph.modules.values()].find((m) => m.base === dynamicBase);
    equal(await invoke('LdrGetDllHandleEx', [1, 0, 0, path, output]), 0);
    equal(runtime.read32(output), dynamicBase);
    equal(await invoke('LdrGetProcedureAddress', [dynamicBase, ansi('sum'), 0, output]), 0);
    equal(await runtime.callGuest(runtime.read32(output), [19, 23], 'cdecl'), 42);
    equal(await invoke('LdrAddRefDll', [0, dynamicBase]), 0);
    equal(dynamic.refs, 2);
    equal(await invoke('LdrUnloadDll', [dynamicBase]), 0);
    equal(dynamic.refs, 1);
    equal(await invoke('LdrUnloadDll', [dynamicBase]), 0);
    equal(runtime.graph.findLoaded('C:\\winebrowser\\plugins\\math.dll'), undefined);
    equal(await invoke('LdrGetDllHandleEx', [1, 0, 0, path, output]), 0xc0000135);
    // Inspect the documented PEB load-order list too, independently of callback lookup.
    const loaderBases = () => {
      const head = runtime.read32(peb + 0xc) + 0xc,
        bases = [];
      for (let p = runtime.read32(head); p !== head; p = runtime.read32(p)) {
        if (bases.length >= 128) throw Error('Cyclic Wine loader list');
        bases.push(runtime.read32(p + 0x18));
      }
      return bases;
    };
    equal(loaderBases().includes(dynamicBase), false);
    equal(await invoke('LdrLoadDll', [0, 0, path, output]), 0);
    const pinnedBase = runtime.read32(output);
    equal(await invoke('LdrAddRefDll', [1, pinnedBase]), 0);
    equal(await invoke('LdrUnloadDll', [pinnedBase]), 0);
    equal(await invoke('LdrUnloadDll', [pinnedBase]), 0);
    equal(loaderBases().includes(pinnedBase), true);
    equal(await invoke('LdrGetProcedureAddress', [pinnedBase, 0, 1, output]), 0);
    equal(await runtime.callGuest(runtime.read32(output), [20, 22], 'cdecl'), 42);
    report.cases.push({
      name: phase,
      independentSameNameDll: true,
      guestLoaderListChecked: true,
      passed: true,
    });

    phase = 'native load attach failure rolls back both module graphs';
    const rejectedBytes = files.get('math.dll').slice(),
      rejectedPe = parsePE(rejectedBytes, { allowDll: true });
    const code = rejectedPe.sections.find(
      (s) => rejectedPe.entryPointRva >= s.rva && rejectedPe.entryPointRva < s.rva + s.rawSize,
    );
    rejectedBytes.set(
      [0x31, 0xc0, 0xc2, 12, 0],
      code.rawOffset + rejectedPe.entryPointRva - code.rva,
    );
    runtime.files.set('rejected.dll', rejectedBytes);
    const beforeFailure = runtime.graph.describe(),
      beforeBases = loaderBases();
    for (let attempt = 0; attempt < 2; attempt++) {
      runtime.write32(output, 0xdeadbeef);
      equal(await invoke('LdrLoadDll', [0, 0, unicode('rejected.dll'), output]), 0xc0000142);
      equal(runtime.read32(output), 0xdeadbeef);
      same(runtime.graph.describe(), beforeFailure, 'host graph rollback');
      same(loaderBases(), beforeBases, 'Wine graph rollback');
    }
    report.cases.push({ name: phase, retries: 2, passed: true });

    phase = 'native forwarder lookup uses the browser dependency graph';
    equal(await invoke('LdrLoadDll', [0, 0, unicode('forward.dll'), output]), 0);
    const forwardBase = runtime.read32(output);
    equal(await invoke('LdrGetProcedureAddress', [forwardBase, ansi('ForwardSum'), 0, output]), 0);
    equal(runtime.read32(output), await runtime.resolveExport(math, 'sum'));
    equal(await runtime.callGuest(runtime.read32(output), [21, 21], 'cdecl'), 42);
    equal(await invoke('LdrUnloadDll', [forwardBase]), 0);
    equal(loaderBases().includes(forwardBase), false);
    report.cases.push({ name: phase, passed: true });

    phase = 'native registration allocation failures roll back before attach';
    runtime.files.set('allocation.dll', files.get('math.dll').slice());
    const allocationName = unicode('allocation.dll');
    const loadAddress = await symbol('LdrLoadDll');
    const allocationGraph = runtime.graph.describe(),
      allocationBases = loaderBases();
    for (const failAt of [1, 2, 3]) {
      const previousStep = runtime.cpu.step;
      let attempts = 0;
      runtime.cpu.step = (ip) => {
        if (ip >>> 0 === allocate && ++attempts === failAt) {
          const returnAddress = runtime.cpu.pop() >>> 0;
          runtime.cpu.r[4].value += 12;
          runtime.cpu.r[0].value = 0;
          return returnAddress;
        }
        return previousStep(ip);
      };
      try {
        runtime.write32(output, 0xdeadbeef);
        equal(await runtime.callGuest(loadAddress, [0, 0, allocationName, output]), 0xc0000017);
        equal(runtime.read32(output), 0xdeadbeef);
      } finally {
        runtime.cpu.step = previousStep;
      }
      equal(attempts, failAt);
      same(runtime.graph.describe(), allocationGraph, 'registration failure host rollback');
      same(loaderBases(), allocationBases, 'registration failure Wine rollback');
    }
    equal(await invoke('LdrLoadDll', [0, 0, allocationName, output]), 0);
    equal(await invoke('LdrUnloadDll', [runtime.read32(output)]), 0);
    report.cases.push({
      name: phase,
      allocationFailurePoints: 3,
      retrySucceeded: true,
      passed: true,
    });

    phase = 'native loader rejects malformed descriptors before changing references';
    const malformed = unicode('math.dll'),
      refsBefore = math.refs;
    runtime.guestMemory.write(malformed, 3, 2);
    equal(await invoke('LdrLoadDll', [0, 0, malformed, output]), 0xc000000d);
    equal(await invoke('LdrLoadDll', [0, 0, unicode('math.dll'), 0]), 0xc0000005);
    equal(await invoke('LdrGetProcedureAddress', [math.base, 0, 1, 0]), 0xc0000005);
    equal(await invoke('LdrGetDllHandleEx', [3, 0, 0, unicode('math.dll'), output]), 0xc000000d);
    equal(math.refs, refsBefore);
    report.cases.push({ name: phase, passed: true });
    report.status = 'passed-experimental-loader-bootstrap';
  } catch (error) {
    report.failure ??= { phase, message: error.message, stack: error.stack };
  }
  report.blocks = runtime?.blocks;
  report.apiTrace = runtime?.apiTrace;
  report.modules = runtime?.graph.describe();
  return report;
}
