// This runtime exposes a process-local UTC timezone. It does not consult the
// host timezone, so the guest sees stable no-DST rules in every environment.
import { PROCESS_LAYOUT } from './process-layout.js';
import { VirtualMemoryConstants } from './virtual-memory.js';
import { GUEST_CPUID, GUEST_PROCESSOR_FEATURES } from './processor-features.js';

const STATUS_SUCCESS = 0;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const BASIC_INFORMATION_SIZE = 44; // PE32 SYSTEM_BASIC_INFORMATION.
const PROCESSOR_INFORMATION_SIZE = 12; // PE32 SYSTEM_CPU_INFORMATION.
const TIME_OF_DAY_SIZE = 48; // SYSTEM_TIMEOFDAY_INFORMATION.
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

// SYSTEM_CPU_INFORMATION (class 1): the same stable, intentionally generic
// processor the CPUID and PF_* paths describe. ProcessorFeatureBits is a
// bitmask over Wine's PF_* indices, so index 8 (RDTSC) sets bit 8.
function processorInformation(runtime) {
  const processors = runtime.read32(PROCESS_LAYOUT.peb + 0x64);
  if (processors !== 1) throw Error('Unsupported Wine guest processor count');
  const bytes = new Uint8Array(PROCESSOR_INFORMATION_SIZE);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0, true); // PROCESSOR_ARCHITECTURE_INTEL.
  view.setUint16(2, GUEST_CPUID.family, true); // ProcessorLevel.
  view.setUint16(4, (GUEST_CPUID.model << 8) | GUEST_CPUID.stepping, true);
  view.setUint16(6, 1, true); // MaximumProcessors.
  let featureBits = 0;
  for (const index of GUEST_PROCESSOR_FEATURES.advertised) featureBits |= 1 << index;
  view.setUint32(8, featureBits >>> 0, true);
  return bytes;
}

export const systemNtServices = {
  NtQuerySystemInformation: {
    argc: 4,
    call(runtime, argument) {
      const informationClass = argument(0) >>> 0;
      if (informationClass === 1000) {
        // Wine's private SystemWineVersionInformation describes its Unix host
        // (four NUL-separated strings). This browser has no Wine Unix host.
        // Report its absence, as an NT host without this extension would;
        // version_init still selects Wine's Windows version defaults itself.
        const returnLength = argument(3) >>> 0;
        try {
          if (returnLength) runtime.write32(returnLength, 0);
        } catch {
          return STATUS_ACCESS_VIOLATION;
        }
        return 0xc0000003; // STATUS_INVALID_INFO_CLASS, never fabricated success.
      }
      if (![0, 1, 3, 44, 102].includes(informationClass))
        throw Error(`Unsupported Wine system information class ${informationClass}`);
      const value =
        informationClass === 0
          ? basicInformation(runtime)
          : informationClass === 1
            ? processorInformation(runtime)
            : informationClass === 3
              ? timeOfDayInformation(runtime)
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
      if ([0, 1].includes(informationClass) ? capacity !== size : capacity < size) {
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

function timeOfDayInformation(runtime) {
  const bytes = new Uint8Array(TIME_OF_DAY_SIZE);
  const view = new DataView(bytes.buffer);
  // The virtual machine starts with this process. Both clocks use UTC FILETIME;
  // timezone bias, DST id and suspend accounting are zero for this runtime.
  view.setBigInt64(0, runtime.packageFileTime, true);
  view.setBigInt64(8, BigInt(runtime.systemNow()) * 10000n + 116444736000000000n, true);
  return bytes;
}
