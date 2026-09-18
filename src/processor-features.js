// This profile describes instructions guaranteed by the browser PE runtime,
// never the host CPU. Wine's PF_* constants include MMX (3), SSE (6), SSE2
// (10), and later extensions; partial opcode support cannot advertise any of
// those complete instruction families yet.
export const GUEST_PROCESSOR_FEATURES = Object.freeze({
  architecture: 'i386',
  maxIndex: 64, // Wine's PROCESSOR_FEATURE_MAX / KUSER_SHARED_DATA array length.
  advertised: Object.freeze([]),
});

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
