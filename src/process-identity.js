// Identity inside one isolated guest process; never derived from the host user.
// Every Runtime owns its registry, so equal SIDs do not share data across runs.
export const PROCESS_USER_SID = 'S-1-5-21-0-0-0-1000';

export function processUserSidBytes() {
  const subAuthorities = [21, 0, 0, 0, 1000];
  const bytes = new Uint8Array(8 + subAuthorities.length * 4);
  bytes[0] = 1;
  bytes[1] = subAuthorities.length;
  bytes[7] = 5; // SECURITY_NT_AUTHORITY is a six-byte big-endian value.
  const view = new DataView(bytes.buffer);
  subAuthorities.forEach((value, index) => view.setUint32(8 + index * 4, value, true));
  return bytes;
}
