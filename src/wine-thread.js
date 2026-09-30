import { threadCreationNtServices } from './wine-thread-create.js';

const STATUS_SUCCESS = 0;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const CURRENT_THREAD = 0xfffffffe;
const THREAD_ZERO_TLS_CELL = 10;
const INLINE_TLS_SLOTS = 64;
const EXPANSION_TLS_SLOTS = 1024; // PEB.TlsExpansionBitmapBits[32].

export const threadNtServices = {
  ...threadCreationNtServices,
  NtSetInformationThread: {
    argc: 4,
    call(runtime, argument) {
      const informationClass = argument(1) >>> 0;
      if (informationClass === 3) {
        if (argument(3) !== 4) return STATUS_INVALID_PARAMETER;
        let delta;
        try {
          delta = runtime.read32(argument(2)) | 0;
        } catch {
          return STATUS_ACCESS_VIOLATION;
        }
        return runtime.threads.setPriority(argument(0), delta);
      }
      // ThreadAffinityMask takes a KAFFINITY (4 bytes). The virtual CPU is a
      // single-processor machine, so the mask is recorded and reported back
      // exactly as the caller set it rather than being silently ignored.
      if (informationClass === 4) {
        if (argument(3) !== 4) return STATUS_INVALID_PARAMETER;
        const found = runtime.threads.lookup(argument(0), 0x40);
        if (found.status) return found.status;
        let mask;
        try {
          mask = runtime.read32(argument(2)) >>> 0;
        } catch {
          return STATUS_ACCESS_VIOLATION;
        }
        if (!mask) return STATUS_INVALID_PARAMETER;
        found.thread.affinity = mask;
        return STATUS_SUCCESS;
      }
      if (informationClass !== THREAD_ZERO_TLS_CELL)
        throw Error(`Unsupported Wine thread information class ${informationClass}`);
      if (argument(0) >>> 0 !== CURRENT_THREAD) return STATUS_INVALID_HANDLE;
      if (argument(3) >>> 0 !== 4) return STATUS_INVALID_PARAMETER;

      let index;
      try {
        index = runtime.read32(argument(2) >>> 0);
      } catch {
        return STATUS_ACCESS_VIOLATION;
      }
      if (index >= INLINE_TLS_SLOTS + EXPANSION_TLS_SLOTS) return STATUS_INVALID_PARAMETER;

      try {
        const cells = [];
        // TlsFree clears this index throughout the process before reuse.
        for (const thread of runtime.threads.records.values()) {
          const expansion = index >= INLINE_TLS_SLOTS ? runtime.read32(thread.teb + 0xf94) : 0;
          if (index >= INLINE_TLS_SLOTS && !expansion) continue;
          const cell =
            index < INLINE_TLS_SLOTS
              ? thread.teb + 0xe10 + index * 4
              : expansion + (index - INLINE_TLS_SLOTS) * 4;
          if (cell > 0xfffffffc) return STATUS_ACCESS_VIOLATION;
          runtime.check(cell, 4, true);
          cells.push(cell);
        }
        for (const cell of cells) runtime.write32(cell, 0);
      } catch {
        return STATUS_ACCESS_VIOLATION;
      }
      return STATUS_SUCCESS;
    },
  },
};
