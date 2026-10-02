import { registerThunk } from './thunk-addresses.js';
import { systemFileTime } from './shared-user-data.js';

// Wine 11's RtlGetSystemTimePrecise calls ntdll's private Unix table (entry 7),
// unlike NtQuerySystemTime. Supply that host boundary with the same process
// clock. Other Unix services remain explicit errors; there is no native server.
export function installWineUnixClock(runtime, module) {
  if (module.unixClock || module.host || module.name !== 'ntdll.dll') return;
  const find = (name) => module.pe.exports.find((e) => e.name === name && !e.forwarder);
  const dispatcher = find('__wine_unix_call_dispatcher'),
    handle = find('__wine_unixlib_handle');
  if (!dispatcher || !handle) return;
  const slot = module.base + dispatcher.rva,
    handleSlot = module.base + handle.rva;
  runtime.check(slot, 4, true);
  runtime.check(handleSlot, 8, true);
  if (runtime.read32(slot) || runtime.read32(handleSlot) || runtime.read32(handleSlot + 4))
    throw Error('Wine Unix clock dispatcher is already initialized');
  const token = 0x5742434c;
  const address = registerThunk(runtime.thunks, {
    dll: 'ntdll.dll',
    name: '__wine_unix_call_dispatcher',
    kind: 'wine-unix',
    invoke(r, a) {
      if (a(0) >>> 0 !== token || a(1) || a(2) !== 7)
        throw Error(`Unsupported Wine Unix service ${a(2) >>> 0}`);
      const pointer = a(3) >>> 0;
      r.check(pointer, 8, true);
      const value = systemFileTime(r.systemNow());
      r.write32(pointer, Number(value & 0xffffffffn));
      r.write32(pointer + 4, Number(value >> 32n));
      return { result: 0, argc: 4 };
    },
  });
  runtime.write32(handleSlot, token);
  runtime.write32(handleSlot + 4, 0);
  runtime.write32(slot, address);
  module.unixClock = { address, slot, handleSlot };
}
