// This runtime exposes a process-local UTC timezone. It does not consult the
// host timezone, so the guest sees stable no-DST rules in every environment.
import { PROCESS_LAYOUT } from './process-layout.js';
import { VirtualMemoryConstants } from './virtual-memory.js';

const STATUS_SUCCESS = 0;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const BASIC_INFORMATION_SIZE = 44; // PE32 SYSTEM_BASIC_INFORMATION.
const TIME_ZONE_SIZE = 172; // PE32 RTL_TIME_ZONE_INFORMATION.
const DYNAMIC_TIME_ZONE_SIZE = 432; // PE32 RTL_DYNAMIC_TIME_ZONE_INFORMATION.

const utcTimeZone = new Uint8Array(DYNAMIC_TIME_ZONE_SIZE);
const zoneView = new DataView(utcTimeZone.buffer);
function writeName(offset, name) {
  for (let i = 0; i < name.length; i++)
    zoneView.setUint16(offset + i * 2, name.charCodeAt(i), true);
}
writeName(4, 'UTC'); // StandardName[32].
writeName(88, 'UTC'); // DaylightName[32]; unused because no DST rule exists.
writeName(172, 'UTC'); // TimeZoneKeyName[128].
utcTimeZone[428] = 1; // DynamicDaylightTimeDisabled.

function basicInformation(runtime) {
  const { pageSize, allocationGranularity } = VirtualMemoryConstants;
  const memorySize = runtime.memory.buffer.byteLength;
  const pages = memorySize / pageSize;
  if (!Number.isInteger(pages) || pages < 1 || memorySize > 0x100000000)
    throw Error('Unsupported Wine guest address-space size');
  const processors = runtime.read32(PROCESS_LAYOUT.peb + 0x64);
  if (processors !== 1) throw Error('Unsupported Wine guest processor count');
  const bytes = new Uint8Array(BASIC_INFORMATION_SIZE);
  const view = new DataView(bytes.buffer);
  // Unknown and KeMaximumIncrement remain zero; this runtime has no NT timer
  // resolution control. Physical-page fields describe its own guest memory.
  view.setUint32(8, pageSize, true);
  view.setUint32(12, pages, true);
  view.setUint32(16, 0, true);
  view.setUint32(20, pages - 1, true);
  view.setUint32(24, allocationGranularity, true);
  view.setUint32(28, allocationGranularity, true); // LowestUserAddress.
  view.setUint32(32, memorySize - 1, true); // HighestUserAddress.
  view.setUint32(36, 1, true); // ActiveProcessorsAffinityMask.
  bytes[40] = processors; // NumberOfProcessors.
  return bytes;
}

export const systemNtServices = {
  NtQuerySystemInformation: {
    argc: 4,
    call(runtime, argument) {
      const informationClass = argument(0) >>> 0;
      if (informationClass !== 0 && informationClass !== 44 && informationClass !== 102)
        throw Error(`Unsupported Wine system information class ${informationClass}`);
      const value =
        informationClass === 0
          ? basicInformation(runtime)
          : utcTimeZone.subarray(
              0,
              informationClass === 44 ? TIME_ZONE_SIZE : DYNAMIC_TIME_ZONE_SIZE,
            );
      const size = value.length;
      const output = argument(1) >>> 0;
      const capacity = argument(2) >>> 0;
      const returnLength = argument(3) >>> 0;
      try {
        if (returnLength) runtime.check(returnLength, 4, true);
      } catch {
        return STATUS_ACCESS_VIOLATION;
      }
      if (informationClass === 0 ? capacity !== size : capacity < size) {
        if (returnLength) runtime.write32(returnLength, size);
        return STATUS_INFO_LENGTH_MISMATCH;
      }
      try {
        runtime.check(output, size, true);
      } catch {
        if (returnLength) runtime.write32(returnLength, size);
        return STATUS_ACCESS_VIOLATION;
      }
      runtime.data.set(value, output);
      if (returnLength) runtime.write32(returnLength, size);
      return STATUS_SUCCESS;
    },
  },
};
