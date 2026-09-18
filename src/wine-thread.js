import { PROCESS_LAYOUT } from './process-layout.js';

const STATUS_SUCCESS = 0;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const CURRENT_THREAD = 0xfffffffe;
const THREAD_ZERO_TLS_CELL = 10;
const INLINE_TLS_SLOTS = 64;
const EXPANSION_TLS_SLOTS = 1024; // PEB.TlsExpansionBitmapBits[32].
const TEB_TLS_SLOTS = PROCESS_LAYOUT.teb + 0xe10;
const TEB_TLS_EXPANSION_SLOTS = PROCESS_LAYOUT.teb + 0xf94;

export const threadNtServices = {
  NtSetInformationThread: {
    argc: 4,
    call(runtime, argument) {
      const informationClass = argument(1) >>> 0;
      if (informationClass !== THREAD_ZERO_TLS_CELL)
        throw Error(`Unsupported Wine thread information class ${informationClass}`);
      // The guest runtime has one thread; no other thread handles are modeled.
      if (argument(0) >>> 0 !== CURRENT_THREAD) return STATUS_INVALID_HANDLE;
      if (argument(3) >>> 0 !== 4) return STATUS_INVALID_PARAMETER;

      let index;
      try {
        index = runtime.read32(argument(2) >>> 0);
      } catch {
        return STATUS_ACCESS_VIOLATION;
      }
      if (index >= INLINE_TLS_SLOTS + EXPANSION_TLS_SLOTS) return STATUS_INVALID_PARAMETER;

      let cell;
      if (index < INLINE_TLS_SLOTS) {
        cell = TEB_TLS_SLOTS + index * 4;
      } else {
        const expansion = runtime.read32(TEB_TLS_EXPANSION_SLOTS);
        if (!expansion) return STATUS_SUCCESS;
        cell = expansion + (index - INLINE_TLS_SLOTS) * 4;
      }
      if (cell > 0xfffffffc) return STATUS_ACCESS_VIOLATION;
      try {
        runtime.write32(cell, 0);
      } catch {
        return STATUS_ACCESS_VIOLATION;
      }
      return STATUS_SUCCESS;
    },
  },
};
