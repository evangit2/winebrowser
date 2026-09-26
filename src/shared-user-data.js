import { GUEST_PERFORMANCE_FREQUENCY, splitGuestCounter } from './guest-clock.js';
import { guestProcessorFeaturePresent } from './processor-features.js';

export const SHARED_USER_DATA_ADDRESS = 0x7ffe0000;
export const systemFileTime = (now = Date.now()) => BigInt(now) * 10000n + 116444736000000000n;

// A read-only guest mapping, separate from the 64 MiB linear application arena.
// Only fields owned by implemented runtime services are readable. Unimplemented
// shared data (syscall trampolines, XSTATE, etc.) must not become invented zeros.
export function createSharedUserData(clock, systemNow = () => Date.now()) {
  const bytes = new Uint8Array(0x1000),
    view = new DataView(bytes.buffer);
  view.setUint32(4, 1 << 24, true); // Wine's tick units are already milliseconds.
  for (let i = 0; i < 64; i++) bytes[0x274 + i] = guestProcessorFeaturePresent(i);
  view.setBigUint64(0x300, GUEST_PERFORMANCE_FREQUENCY, true);
  function time(offset, value) {
    const { low, high } = splitGuestCounter(value);
    view.setUint32(offset, low, true);
    view.setUint32(offset + 4, high, true);
    view.setUint32(offset + 8, high, true);
  }
  return {
    start: SHARED_USER_DATA_ADDRESS,
    bytes,
    ranges: [
      [0, 0x2c],
      [0x274, 0x2b4],
      [0x300, 0x308],
      [0x320, 0x330],
    ],
    refresh(offset, size) {
      if ((offset < 0x20 && offset + size > 0) || (offset < 0x32c && offset + size > 0x320)) {
        const ticks = clock.read(),
          millis = ticks / 1_000_000n;
        view.setUint32(0, Number(millis & 0xffffffffn), true);
        time(8, ticks / 100n); // InterruptTime, 100 ns since virtual clock origin.
        time(0x14, systemFileTime(systemNow()));
        time(0x320, millis);
      }
      // TimeZoneBias remains zero: the NT provider also exposes fixed UTC.
    },
  };
}
