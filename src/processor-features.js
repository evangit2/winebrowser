const RDTSC_AVAILABLE = true;

// This profile describes instructions guaranteed by the browser PE runtime,
// never the host CPU. Wine's PF_* constants include MMX (3), SSE (6), SSE2
// (10), and later extensions; partial opcode support cannot advertise any of
// those complete instruction families yet.
export const GUEST_PROCESSOR_FEATURES = Object.freeze({
  architecture: 'i386',
  maxIndex: 64, // Wine's PROCESSOR_FEATURE_MAX / KUSER_SHARED_DATA array length.
  advertised: Object.freeze(RDTSC_AVAILABLE ? [8] : []), // PF_RDTSC_INSTRUCTION_AVAILABLE
});

// CPUID reports one stable, intentionally generic 32-bit processor. The
// custom vendor keeps guest code from selecting a host-vendor optimization
// path, while the Pentium-family identity matches the conservative optional
// feature masks. Leaves and bits grow only with complete
// runtime support; they are never copied from the browser's host machine.
export const GUEST_CPUID = Object.freeze({
  vendor: 'WineBrowser ',
  family: 5,
  model: 4,
  stepping: 3,
  logicalProcessors: 1,
  maxStandardLeaf: 1,
  maxExtendedLeaf: 0x80000000,
  featureEcx: 0,
  featureEdx: RDTSC_AVAILABLE ? 1 << 4 : 0, // CPUID.01H:EDX.TSC
});

export const GUEST_PROCESSOR_PROFILE = Object.freeze({
  architecture: GUEST_PROCESSOR_FEATURES.architecture,
  processorFeatures: GUEST_PROCESSOR_FEATURES,
  cpuid: GUEST_CPUID,
});

function vendorWord(offset) {
  return (
    (GUEST_CPUID.vendor.charCodeAt(offset) |
      (GUEST_CPUID.vendor.charCodeAt(offset + 1) << 8) |
      (GUEST_CPUID.vendor.charCodeAt(offset + 2) << 16) |
      (GUEST_CPUID.vendor.charCodeAt(offset + 3) << 24)) >>>
    0
  );
}

export function guestCpuid(leaf, _subleaf = 0) {
  leaf >>>= 0;
  if (leaf === 0)
    return Object.freeze({
      eax: GUEST_CPUID.maxStandardLeaf,
      ebx: vendorWord(0),
      edx: vendorWord(4),
      ecx: vendorWord(8),
    });
  if (leaf === 1)
    return Object.freeze({
      eax: (GUEST_CPUID.family << 8) | (GUEST_CPUID.model << 4) | GUEST_CPUID.stepping,
      ebx: GUEST_CPUID.logicalProcessors << 16,
      ecx: GUEST_CPUID.featureEcx,
      edx: GUEST_CPUID.featureEdx,
    });
  if (leaf === 0x80000000)
    return Object.freeze({ eax: GUEST_CPUID.maxExtendedLeaf, ebx: 0, ecx: 0, edx: 0 });
  return Object.freeze({ eax: 0, ebx: 0, ecx: 0, edx: 0 });
}

export function guestProcessorFeaturePresent(feature) {
  const index = feature >>> 0;
  return Number(
    index < GUEST_PROCESSOR_FEATURES.maxIndex &&
      GUEST_PROCESSOR_FEATURES.advertised.includes(index),
  );
}

export const processorFeatureNtServices = {
  NtWow64IsProcessorFeaturePresent: {
    argc: 1,
    // Wine returns its boolean feature byte as 0 or 1 despite the NTSTATUS
    // declaration. A nonzero NTSTATUS error would be mistaken for "present".
    call: (_runtime, argument) => guestProcessorFeaturePresent(argument(0)),
  },
};
