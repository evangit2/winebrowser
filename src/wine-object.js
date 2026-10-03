import { registryStore } from './win32-registry.js';

export function guestHandleRecord(runtime, handle) {
  handle >>>= 0;
  if ([1, 2].includes(handle) && !runtime.closedStandardOutputs?.has(handle)) {
    runtime.standardHandleRecords ??= new Map();
    if (!runtime.standardHandleRecords.has(handle)) runtime.standardHandleRecords.set(handle, {});
    return runtime.standardHandleRecords.get(handle);
  }
  return runtime.handles.get(handle) ?? registryStore.stateFor(runtime).handles.get(handle);
}
export function guestHandleFlags(runtime, handle) {
  const opened = guestHandleRecord(runtime, handle);
  if (!opened) return null;
  return (opened.inherit ? 1 : 0) | (opened.protectFromClose ? 2 : 0);
}
export const objectNtServices = {
  NtQueryObject: {
    argc: 5,
    call: (r, a) => {
      // OBJECT_HANDLE_FLAG_INFORMATION is two BOOLEANs, not a DWORD mask.
      if (a(1) !== 4) return 0xc0000003; // STATUS_INVALID_INFO_CLASS
      if (a(3) < 2) return 0xc0000206; // STATUS_INVALID_BUFFER_SIZE
      const flags = guestHandleFlags(r, a(0));
      if (flags === null) return 0xc0000008;
      try {
        if (a(4)) {
          r.check(a(4), 4, true);
          r.write32(a(4), 2);
        }
        if (!a(2)) return 0xc0000005;
        r.check(a(2), 2, true);
        r.data[a(2)] = flags & 1;
        r.data[a(2) + 1] = flags >> 1;
        return 0;
      } catch {
        return 0xc0000005;
      }
    },
  },
  NtSetInformationObject: {
    argc: 4,
    call: (r, a) => {
      if (a(1) !== 4) return 0xc0000003;
      if (a(3) < 2) return 0xc0000206;
      const opened = guestHandleRecord(r, a(0));
      if (!opened) return 0xc0000008;
      try {
        if (!a(2)) return 0xc0000005;
        r.check(a(2), 2);
        opened.inherit = !!r.data[a(2)];
        opened.protectFromClose = !!r.data[a(2) + 1];
        return 0;
      } catch {
        return 0xc0000005;
      }
    },
  },
};
