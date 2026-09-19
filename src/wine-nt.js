import { nlsServices } from './wine-nls.js';
import { closeRegistryHandle, registryNtServices } from './wine-registry.js';
import { tokenNtServices } from './wine-token.js';
import { systemNtServices } from './wine-system.js';
import { memoryNtServices } from './memory-protection.js';
import { threadNtServices } from './wine-thread.js';
import { processorFeatureNtServices } from './processor-features.js';
import { GUEST_PERFORMANCE_FREQUENCY } from './guest-clock.js';
import { closeFileHandle, fileNtServices } from './wine-file.js';
import { registerThunk } from './thunk-addresses.js';

// Wine i386 PE syscall ABI v1: EAX selects a service, either a wrapper CALLs a
// common trampoline or FS:[0xc0] dispatches directly, and RET n removes args.
// We install only validated Wine dispatcher slots; guest code stays unchanged.
export function installWineNtBridge(runtime, module) {
  if (module.host || module.name !== 'ntdll.dll' || module.ntBridge) return;
  const exported = module.pe.exports.find((e) => e.name === '__wine_syscall_dispatcher');
  if (!exported || exported.forwarder) return; // Ordinary Windows ntdll is a different ABI.
  const slot = module.base + exported.rva;
  runtime.check(slot, 4, true);
  if (runtime.read32(slot)) throw Error('Wine NT dispatcher is already installed by another host');
  const services = new Map();
  let hasTebWrappers = false;
  const executable = (address, size) =>
    module.pe.sections.some(
      (s) =>
        s.characteristics & 0x20000000 &&
        address >= module.base + s.rva &&
        address + size <= module.base + s.rva + Math.max(s.virtualSize, s.rawSize),
    );
  for (const entry of module.pe.exports) {
    if (!/^Nt[A-Z]/.test(entry.name ?? '') || entry.forwarder) continue;
    const address = module.base + entry.rva;
    if (!executable(address, 15)) continue;
    const code = runtime.data.subarray(address, address + 15);
    if (code[0] !== 0xb8 || code[12] !== 0xc2) continue; // Some Nt exports are ordinary guest implementations.
    const hasTrampolineCall = code[5] === 0xba && code[10] === 0xff && code[11] === 0xd2;
    const hasTebCall =
      code[5] === 0x64 &&
      code[6] === 0xff &&
      code[7] === 0x15 &&
      runtime.read32(address + 8) === 0xc0;
    if (hasTrampolineCall) {
      const trampoline = runtime.read32(address + 6);
      if (
        !executable(trampoline, 6) ||
        runtime.data[trampoline] !== 0xff ||
        runtime.data[trampoline + 1] !== 0x25 ||
        runtime.read32(trampoline + 2) !== slot
      )
        throw Error(`Unsupported Wine NT trampoline for ${entry.name}`);
    } else if (hasTebCall) {
      hasTebWrappers = true;
    } else continue; // Some Nt exports are ordinary guest implementations.
    const id = runtime.read32(address + 1),
      stackBytes = code[13] | (code[14] << 8);
    if (id >= 4096 || stackBytes % 4 || stackBytes > 64 || services.has(id))
      throw Error(`Unsupported Wine NT service table for ${entry.name}`);
    services.set(id, { name: entry.name, argc: stackBytes / 4 });
  }
  if (!services.size) throw Error('Unsupported Wine i386 syscall wrapper ABI');
  let tebSlot;
  if (hasTebWrappers) {
    if (!runtime.cpu.fsBase) throw Error('Wine FS syscall wrapper requires a guest TEB');
    tebSlot = runtime.cpu.fsBase + 0xc0;
    runtime.check(tebSlot, 4, true);
    if (runtime.read32(tebSlot)) throw Error('Wine TEB syscall dispatcher is already installed');
  }
  const address = registerThunk(runtime.thunks, {
    dll: module.name,
    name: '__wine_syscall_dispatcher',
    kind: 'wine-nt',
    services,
  });
  runtime.write32(slot, address);
  if (tebSlot !== undefined) runtime.write32(tebSlot, address);
  module.ntBridge = { version: 1, address, slot, serviceCount: services.size, tebSlot };
}

const ACCESS_VIOLATION = 0xc0000005;
const CURRENT_PROCESS = 0xffffffff;
const PROCESS_WOW64_INFORMATION = 26;
const PROCESS_EXECUTE_FLAGS = 34;
const MEM_EXECUTE_OPTION_DISABLE = 0x01;
const MEM_EXECUTE_OPTION_ENABLE = 0x02;
const MEM_EXECUTE_OPTION_DISABLE_THUNK_EMULATION = 0x04;
const MEM_EXECUTE_OPTION_PERMANENT = 0x08;
const BROWSER_EXECUTE_FLAGS =
  MEM_EXECUTE_OPTION_DISABLE |
  MEM_EXECUTE_OPTION_DISABLE_THUNK_EMULATION |
  MEM_EXECUTE_OPTION_PERMANENT;
function virtualMemoryCall(runtime, argument, allocate) {
  if (argument(0) !== 0xffffffff) return 0xc0000008; // Only current-process pseudo-handle.
  if (allocate && argument(2)) return 0xc000000d; // ZeroBits constraints need separate support.
  const basePointer = argument(1),
    sizePointer = argument(allocate ? 3 : 2);
  try {
    runtime.check(basePointer, 4, true);
    runtime.check(sizePointer, 4, true);
  } catch {
    return ACCESS_VIOLATION;
  }
  const base = runtime.read32(basePointer),
    size = runtime.read32(sizePointer);
  const result = allocate
    ? runtime.virtualMemory.allocate(base, size, argument(4), argument(5))
    : runtime.virtualMemory.free(base, size, argument(3));
  if (!result.status) {
    try {
      runtime.write32(basePointer, result.base);
      runtime.write32(sizePointer, result.size);
    } catch {
      return ACCESS_VIOLATION;
    }
  }
  return result.status;
}
function writeLargeInteger(runtime, address, value) {
  try {
    runtime.check(address, 8, true);
  } catch {
    return ACCESS_VIOLATION;
  }
  runtime.view.setBigInt64(address, value, true);
  return 0;
}

export const ntServices = {
  ...nlsServices,
  ...registryNtServices,
  ...tokenNtServices,
  ...systemNtServices,
  ...memoryNtServices,
  ...threadNtServices,
  ...processorFeatureNtServices,
  ...fileNtServices,
  NtClose: {
    argc: 1,
    call: (r, a) => {
      const result = closeRegistryHandle(r, a(0));
      if (result !== null) return result;
      const fileResult = closeFileHandle(r, a(0));
      if (fileResult === null)
        throw Error(
          `Unsupported Wine NT service NtClose for handle 0x${(a(0) >>> 0).toString(16)}`,
        );
      return fileResult;
    },
  },
  NtUnmapViewOfSection: {
    argc: 2,
    call: (r, a) => (a(0) === 0xffffffff ? r.sectionViews.unmap(a(1)) : 0xc0000008),
  },
  NtQueryInformationProcess: {
    argc: 5,
    call: (r, a) => {
      const informationClass = a(1);
      if (![PROCESS_WOW64_INFORMATION, PROCESS_EXECUTE_FLAGS].includes(informationClass))
        throw Error(`Unsupported Wine process information class ${informationClass}`);
      if (a(3) !== 4) return 0xc0000004; // STATUS_INFO_LENGTH_MISMATCH.
      if (a(0) !== CURRENT_PROCESS) return 0xc0000008;
      try {
        r.check(a(2), 4, true);
        if (a(4)) r.check(a(4), 4, true);
      } catch {
        return ACCESS_VIOLATION;
      }
      // This is a native PE32 process without WOW64. Browser DEP is always on:
      // guest data stays non-executable and ATL thunk emulation is unavailable.
      r.write32(a(2), informationClass === PROCESS_EXECUTE_FLAGS ? BROWSER_EXECUTE_FLAGS : 0);
      if (a(4)) r.write32(a(4), 4);
      return 0;
    },
  },
  NtSetInformationProcess: {
    argc: 4,
    call: (r, a) => {
      const informationClass = a(1);
      if (informationClass !== PROCESS_EXECUTE_FLAGS)
        throw Error(`Unsupported Wine process information class ${informationClass}`);
      if (a(0) !== CURRENT_PROCESS) return 0xc0000008;
      if (a(3) !== 4) return 0xc000000d; // STATUS_INVALID_PARAMETER.
      try {
        r.check(a(2), 4, false);
      } catch {
        return ACCESS_VIOLATION;
      }
      const flags = r.read32(a(2));
      if (flags === BROWSER_EXECUTE_FLAGS) return 0;
      const selection = flags & (MEM_EXECUTE_OPTION_DISABLE | MEM_EXECUTE_OPTION_ENABLE);
      if (!selection || selection === (MEM_EXECUTE_OPTION_DISABLE | MEM_EXECUTE_OPTION_ENABLE))
        return 0xc000000d;
      // The browser policy is permanent. In particular, ENABLE would permit
      // execution from guest data, which this runtime never grants.
      return 0xc0000022; // STATUS_ACCESS_DENIED.
    },
  },
  NtAllocateVirtualMemory: { argc: 6, call: (r, a) => virtualMemoryCall(r, a, true) },
  NtFreeVirtualMemory: { argc: 4, call: (r, a) => virtualMemoryCall(r, a, false) },
  NtQuerySystemTime: {
    argc: 1,
    call: (r, a) => writeLargeInteger(r, a(0), BigInt(Date.now()) * 10000n + 116444736000000000n),
  },
  NtQueryPerformanceCounter: {
    argc: 2,
    call: (r, a) => {
      try {
        r.check(a(0), 8, true);
        if (a(1)) r.check(a(1), 8, true);
      } catch {
        return ACCESS_VIOLATION;
      }
      writeLargeInteger(r, a(0), r.performanceClock.read());
      if (a(1)) writeLargeInteger(r, a(1), GUEST_PERFORMANCE_FREQUENCY);
      return 0;
    },
  },
};

export async function dispatchWineNt(runtime, entry) {
  const id = runtime.cpu.r[0].value >>> 0,
    service = entry.services.get(id);
  const provider = ntServices[service?.name];
  if (!provider) throw Error(`Unsupported Wine NT service ${service?.name ?? '#' + id}`);
  if (service.argc !== provider.argc)
    throw Error(`Wine NT argument ABI mismatch for ${service.name}`);
  const stack = runtime.cpu.r[4].value >>> 0;
  const argument = (index) => runtime.read32(stack + 8 + index * 4);
  runtime.calls++;
  if (runtime.apiTrace.length < 2048) runtime.apiTrace.push('ntdll.dll!' + service.name);
  return { result: await provider.call(runtime, argument), argc: 0 };
}
