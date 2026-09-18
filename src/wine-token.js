import { processUserSidBytes } from './process-identity.js';

const STATUS = Object.freeze({
  SUCCESS: 0,
  INVALID_HANDLE: 0xc0000008,
  ACCESS_VIOLATION: 0xc0000005,
  BUFFER_TOO_SMALL: 0xc0000023,
  NO_TOKEN: 0xc000007c,
});

export const tokenNtServices = {
  NtQueryInformationToken: {
    argc: 5,
    call(runtime, argument) {
      const handle = argument(0) >>> 0;
      // One guest thread, no impersonation. Its effective token is the process
      // token. Real token handles and other information classes need services
      // of their own; this does not simulate authentication or access checks.
      if (handle === 0xfffffffb) return STATUS.NO_TOKEN;
      if (handle !== 0xfffffffc && handle !== 0xfffffffa) return STATUS.INVALID_HANDLE;
      const informationClass = argument(1);
      if (informationClass !== 1)
        throw Error(`Unsupported Wine token information class ${informationClass}`);
      const output = argument(2) >>> 0;
      const capacity = argument(3) >>> 0;
      const returnLength = argument(4) >>> 0;
      const sid = processUserSidBytes();
      const size = 8 + sid.length; // PE32 TOKEN_USER, then the self-contained SID.
      try {
        if (returnLength) runtime.check(returnLength, 4, true);
        if (capacity >= size) runtime.check(output, size, true);
      } catch {
        return STATUS.ACCESS_VIOLATION;
      }
      if (returnLength) runtime.write32(returnLength, size);
      if (capacity < size) return STATUS.BUFFER_TOO_SMALL;
      runtime.data.set(sid, output + 8);
      runtime.write32(output, output + 8);
      runtime.write32(output + 4, 0);
      return STATUS.SUCCESS;
    },
  },
};
