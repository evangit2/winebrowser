import { Runtime } from '../../src/runtime.js';
import { installWineNtBridge } from '../../src/wine-nt.js';
import { initializeWineProcess } from '../../src/wine-process.js';
import { PROCESS_LAYOUT } from '../../src/process-layout.js';

const assert = {
  ok(value, message = 'assertion failed') {
    if (!value) throw Error(message);
  },
  equal(actual, expected, message) {
    if (actual !== expected) throw Error(message || `expected ${expected}, got ${actual}`);
  },
  notEqual(actual, expected, message) {
    if (actual === expected) throw Error(message || `did not expect ${expected}`);
  },
  deepEqual(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
      throw Error(
        message || `values differ: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
      );
  },
};
const hex = (value) => `0x${(value >>> 0).toString(16)}`;

export async function probeWineCrt(iced, { executable, builtinFiles, nlsFiles }) {
  const executableName = 'console.exe';
  const report = {
    status: 'blocked-guest',
    scope:
      'Portable worker-safe source-built Wine loader and real guest CRT service diagnostic. No EXE entry point runs.',
    phases: [{ name: 'input integrity', passed: true }],
    nlsRequests: [],
    recentNtCalls: [],
    firstFailure: null,
  };
  let runtime;
  const output = [];
  let phase = 'input integrity';
  let lastIP = null;
  const recentIPs = [];
  const recentServices = [];
  const registerNames = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
  const safeRead32 = (address) => {
    try {
      return runtime.read32(address) >>> 0;
    } catch {
      return null;
    }
  };
  const moduleAt = (address) => {
    if (address === null) return null;
    const module = [...runtime.graph.modules.values()].find(
      (candidate) =>
        !candidate.host &&
        address >= candidate.base &&
        address < candidate.base + candidate.pe.imageSize,
    );
    return module ? { name: module.name, offset: hex(address - module.base) } : null;
  };
  const sectionAt = (address) => {
    if (address === null) return null;
    const module = [...runtime.graph.modules.values()].find(
      (candidate) =>
        !candidate.host &&
        address >= candidate.base &&
        address < candidate.base + candidate.pe.imageSize,
    );
    if (!module) return null;
    const rva = address - module.base;
    const section = module.pe.sections.find(
      (candidate) =>
        rva >= candidate.rva &&
        rva < candidate.rva + Math.max(candidate.rawSize, candidate.virtualSize),
    );
    return section
      ? { name: section.name, rva: hex(rva), characteristics: hex(section.characteristics) }
      : null;
  };
  const guestState = () => {
    const stack = runtime.cpu.r[4].value >>> 0;
    return {
      phase,
      instructionPointer: lastIP === null ? null : hex(lastIP),
      recentInstructionPointers: recentIPs.map(hex),
      registers: Object.fromEntries(
        runtime.cpu.r.map((register, index) => [registerNames[index], hex(register.value)]),
      ),
      stackWords: Array.from({ length: 12 }, (_, index) => safeRead32(stack + index * 4)),
      pebTlsBitmap: safeRead32(PROCESS_LAYOUT.peb + 0x40),
      pebTlsExpansionBitmap: safeRead32(PROCESS_LAYOUT.peb + 0x150),
      modules: runtime.graph.describe(),
      apiTrace: [...runtime.apiTrace],
      recentServices: [...recentServices],
      blocks: runtime.blocks,
    };
  };
  const recordFailure = (error, detail = {}) => {
    report.firstFailure ??= {
      phase,
      error: { name: error.name, message: error.message },
      ...(runtime ? guestState() : {}),
      ...detail,
    };
  };
  try {
    runtime = new Runtime(iced, {
      files: new Map([[executableName, executable]]),
      exe: executableName,
      builtinFiles,
      nlsFiles,
      emit: (message) => {
        if (message.type === 'stdout') output.push(message.text);
      },
    });
    const step = runtime.cpu.step.bind(runtime.cpu);
    runtime.cpu.step = (ip) => {
      lastIP = ip >>> 0;
      recentIPs.push(lastIP);
      if (recentIPs.length > 16) recentIPs.shift();
      try {
        return step(ip);
      } catch (error) {
        recordFailure(error);
        throw error;
      }
    };
    const api = runtime.api.bind(runtime);
    runtime.api = async (entry) => {
      const serviceId = runtime.cpu.r[0].value >>> 0;
      const service = entry.services?.get(serviceId);
      const stack = runtime.cpu.r[4].value >>> 0;
      const argumentsAtCall = service
        ? Array.from({ length: service.argc }, (_, index) => safeRead32(stack + 8 + index * 4))
        : [];
      const base =
        service?.name === 'NtProtectVirtualMemory' ? safeRead32(argumentsAtCall[1]) : null;
      const protection =
        service?.name === 'NtProtectVirtualMemory'
          ? {
              basePointer: hex(argumentsAtCall[1]),
              base: base === null ? null : hex(base),
              sizePointer: hex(argumentsAtCall[2]),
              size: safeRead32(argumentsAtCall[2]),
              newProtection: hex(argumentsAtCall[3]),
              oldProtectionPointer: hex(argumentsAtCall[4]),
              mappedModule: moduleAt(base),
              mappedSection: sectionAt(base),
              regions:
                base === null
                  ? []
                  : runtime.regions
                      .filter((region) => base >= region.start && base < region.end)
                      .map((region) => ({
                        start: hex(region.start),
                        end: hex(region.end),
                        kind: region.kind ?? null,
                        module: region.module ?? null,
                        read: region.read !== false,
                        write: !!region.write,
                        exec: !!region.exec,
                      })),
            }
          : null;
      try {
        const returnAddress = await api(entry);
        if (service) {
          const record = {
            name: service.name,
            arguments: argumentsAtCall,
            result: hex(runtime.cpu.r[0].value),
            ...(protection ? { protection } : {}),
          };
          recentServices.push(record);
          if (recentServices.length > 32) recentServices.shift();
          if (service.name === 'NtGetNlsSectionPtr' || service.name === 'NtInitializeNlsFiles')
            report.nlsRequests.push(record);
        }
        return returnAddress;
      } catch (error) {
        recordFailure(error, {
          dispatcher: {
            dll: entry.dll,
            name: entry.name,
            serviceId: service ? hex(serviceId) : null,
            serviceName: service?.name ?? null,
            arguments: argumentsAtCall,
            returnAddresses: [safeRead32(stack), safeRead32(stack + 4)].map((address) => ({
              address: address === null ? null : hex(address),
              module: moduleAt(address),
            })),
            ...(protection ? { protection } : {}),
          },
        });
        throw error;
      }
    };

    phase = 'map full guest closure';
    runtime.graph.load('msvcrt.dll', true);
    runtime.graph.map(runtime.memory, runtime.regions);
    runtime.refreshCodeRanges();
    const modules = [...runtime.graph.modules.values()].filter((module) => !module.host);
    assert.deepEqual(
      modules.map((module) => module.name).sort(),
      ['console.exe', 'kernel32.dll', 'kernelbase.dll', 'msvcrt.dll', 'ntdll.dll'].sort(),
    );
    for (const module of modules) assert.equal(module.mapped, true, `${module.name} is not mapped`);
    const ntdll = runtime.graph.modules.get('ntdll.dll');
    installWineNtBridge(runtime, ntdll);
    report.phases.push({ name: phase, modules: runtime.graph.describe(), passed: true });

    phase = 'Wine process heap, parameters and NLS bootstrap';
    await initializeWineProcess(runtime, ntdll);
    assert.ok(runtime.wineProcess?.heap);
    report.phases.push({ name: phase, heap: hex(runtime.wineProcess.heap), passed: true });

    phase = 'source loader registration before DLL attach';
    const exportEntry = ntdll.pe.exports.find(
      (entry) => entry.name === 'WineBrowserLoaderBootstrap',
    );
    assert.ok(
      exportEntry && !exportEntry.forwarder,
      'patched ntdll has no direct browser bootstrap export',
    );
    const bootstrap = ntdll.base + exportEntry.rva;
    const table = runtime.allocate(modules.length * 16);
    for (const [index, module] of modules.entries()) {
      const address = table + index * 16;
      const flags = module === runtime.graph.main ? 1 : module === ntdll ? 2 : 0;
      assert.equal(module.initialized, false, `${module.name} was attached before registration`);
      runtime.write32(address, 16);
      runtime.write32(address + 4, module.base);
      runtime.write32(
        address + 8,
        runtime.allocString(`\\??\\C:\\winebrowser\\${module.name}`, true),
      );
      runtime.write32(address + 12, flags);
    }
    const batch = runtime.allocate(16);
    [16, 1, modules.length, table].forEach((value, index) =>
      runtime.write32(batch + index * 4, value),
    );
    const bootstrapStatus = await runtime.callGuest(bootstrap, [batch]);
    assert.equal(bootstrapStatus, 0, `source loader bootstrap returned ${hex(bootstrapStatus)}`);
    report.phases.push({
      name: phase,
      moduleCount: modules.length,
      status: hex(bootstrapStatus),
      passed: true,
    });

    phase = 'kernelbase dynamic TLS before DLL attach';
    const kernelbase = runtime.graph.modules.get('kernelbase.dll');
    const tlsExport = (name) => {
      const entry = kernelbase.pe.exports.find((candidate) => candidate.name === name);
      assert.ok(entry && !entry.forwarder, `kernelbase has no direct ${name} export`);
      return kernelbase.base + entry.rva;
    };
    const tlsAlloc = tlsExport('TlsAlloc');
    const tlsSetValue = tlsExport('TlsSetValue');
    const tlsGetValue = tlsExport('TlsGetValue');
    const tlsFree = tlsExport('TlsFree');
    const slots = [];
    for (let i = 0; i < 65; i++) {
      const index = await runtime.callGuest(tlsAlloc);
      assert.notEqual(index, 0xffffffff, `TlsAlloc failed at allocation ${i}`);
      assert.ok(index < 1088, `TlsAlloc returned out-of-range slot ${index}`);
      assert.ok(!slots.includes(index), `TlsAlloc reused live slot ${index}`);
      slots.push(index);
      const value = 0x10000 + i;
      assert.equal(await runtime.callGuest(tlsSetValue, [index, value]), 1);
      assert.equal(await runtime.callGuest(tlsGetValue, [index]), value);
    }
    assert.ok(
      slots.some((index) => index < 64),
      'No inline TLS slot was allocated',
    );
    assert.ok(
      slots.some((index) => index >= 64),
      'No expansion TLS slot was allocated',
    );
    for (const index of slots) assert.equal(await runtime.callGuest(tlsFree, [index]), 1);
    const reused = await runtime.callGuest(tlsAlloc);
    assert.ok(slots.includes(reused), `TlsAlloc did not reuse a freed slot: ${reused}`);
    assert.equal(await runtime.callGuest(tlsGetValue, [reused]), 0);
    assert.equal(await runtime.callGuest(tlsFree, [reused]), 1);
    report.phases.push({
      name: phase,
      allocations: slots.length,
      inlineSlots: slots.filter((index) => index < 64).length,
      expansionSlots: slots.filter((index) => index >= 64).length,
      reused,
      passed: true,
    });

    phase = 'normal DLL initialization after source registration';
    const msvcrt = runtime.graph.modules.get('msvcrt.dll');
    const callGuest = runtime.callGuest.bind(runtime);
    runtime.callGuest = async (address, args, convention) => {
      const result = await callGuest(address, args, convention);
      if (address === msvcrt.pe.entryPoint)
        report.msvcrtAttach = {
          result: hex(result),
          recentInstructionPointers: recentIPs.map(hex),
          recentServices: [...recentServices],
        };
      return result;
    };
    await runtime.initializeModules();
    report.phases.push({ name: phase, modules: runtime.graph.describe(), passed: true });
    phase = 'guest CRT allocation, formatting and byte output';
    const crt = async (name, args) =>
      runtime.callGuest(await runtime.resolveExport(msvcrt, name), args, 'cdecl');
    const memory = await crt('calloc', [16, 4]);
    assert.ok(memory, 'Wine CRT calloc returned null');
    assert.deepEqual([...runtime.data.slice(memory, memory + 64)], Array(64).fill(0));
    const text = runtime.allocString('Wine CRT');
    const format = runtime.allocString('%s: %d %08x');
    const expected = 'Wine CRT: 1234 feedcafe';
    assert.equal(await crt('sprintf', [memory, format, text, 1234, 0xfeedcafe]), expected.length);
    assert.equal(runtime.string(memory), expected);
    assert.equal(await crt('strlen', [memory]), expected.length);
    const line = 'Wine CRT stdout through NtWriteFile\n';
    const lineAddress = runtime.allocString(line);
    assert.equal(await crt('_write', [1, lineAddress, line.length]), line.length);
    assert.equal(output.join(''), line.replace('\n', '\r\n'));
    await crt('free', [memory]);
    for (const pointer of [text, format, lineAddress]) runtime.free(pointer);
    report.phases.push({ name: phase, passed: true, formatted: expected, stdout: output.join('') });
    report.status = 'verified-crt-services';
  } catch (error) {
    recordFailure(error);
    report.status = phase === 'input integrity' ? 'blocked-integrity' : 'blocked-guest';
  }
  report.runtime = runtime
    ? {
        modulesAfterFailure: runtime.graph.describe(),
        apiTrace: [...runtime.apiTrace],
        blocks: runtime.blocks,
      }
    : null;
  report.recentNtCalls = recentServices.slice(-16);
  report.processExitCode = report.status === 'verified-crt-services' ? 0 : 1;
  return report;
}
