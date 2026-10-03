// Browser-backed entropy for ephemeral Windows crypto-provider contexts.
// These services do not implement persistent containers, keys or encryption.
const states = new WeakMap();
const ok = (result, argc) => ({ result, argc });
const fail = (r, error, argc) => {
  r.lastError = error >>> 0;
  return ok(0, argc);
};
function state(r) {
  let value = states.get(r);
  if (!value) {
    value = { contexts: new Map(), next: 0x56000000 };
    states.set(r, value);
  }
  return value;
}
function acquire(r, a, wide) {
  const flags = a(4) >>> 0,
    type = a(3) >>> 0;
  if (!a(0)) return fail(r, 87, 5);
  r.check(a(0), 4, true);
  if (flags & ~(0xf0000000 | 0x40 | 0x20)) return fail(r, 0x80090009, 5);
  if (![1, 24].includes(type)) return fail(r, 0x80090014, 5);
  const read = (pointer) => (pointer ? (wide ? r.wideString(pointer) : r.string(pointer)) : '');
  const provider = read(a(2));
  const names =
    type === 1
      ? [
          'Microsoft Base Cryptographic Provider v1.0',
          'Microsoft Enhanced Cryptographic Provider v1.0',
          'Microsoft Strong Cryptographic Provider',
        ]
      : ['Microsoft Enhanced RSA and AES Cryptographic Provider'];
  if (provider && !names.some((name) => name.toLowerCase() === provider.toLowerCase()))
    return fail(r, 0x80090013, 5);
  if ((flags & 0xf0000000) >>> 0 !== 0xf0000000) return fail(r, 0x80090016, 5); // no persisted keyset
  if (read(a(1))) return fail(r, 0x80090009, 5);
  const s = state(r),
    handle = s.next++;
  if (s.contexts.size >= 4096) return fail(r, 8, 5);
  s.contexts.set(handle, { refs: 1 });
  r.write32(a(0), handle);
  return ok(1, 5);
}
export function fillGuestEntropy(r, pointer, length, entropy = globalThis.crypto) {
  r.check(pointer, length, true);
  // Web Crypto limits each request to 65536 bytes. Check the whole guest
  // range before filling so invalid trailing pages cannot cause partial writes.
  for (let offset = 0; offset < length; offset += 65536)
    entropy.getRandomValues(
      r.data.subarray(pointer + offset, pointer + Math.min(length, offset + 65536)),
    );
}
function generate(r, a) {
  if (!state(r).contexts.has(a(0))) return fail(r, 87, 3);
  if (a(1)) fillGuestEntropy(r, a(2), a(1) >>> 0);
  return ok(1, 3);
}
function release(r, a) {
  const s = state(r),
    context = s.contexts.get(a(0));
  if (!context) return fail(r, 87, 2);
  if (a(1)) return fail(r, 0x80090009, 2);
  if (!--context.refs) s.contexts.delete(a(0));
  return ok(1, 2);
}
function addRef(r, a) {
  const context = state(r).contexts.get(a(0));
  if (!context || a(1)) return fail(r, 87, 3);
  if (a(2)) return fail(r, 0x80090009, 3);
  context.refs++;
  return ok(1, 3);
}
export const randomApis = {
  'advapi32.dll!CryptAcquireContextA': (r, a) => acquire(r, a, false),
  'advapi32.dll!CryptAcquireContextW': (r, a) => acquire(r, a, true),
  'advapi32.dll!CryptGenRandom': generate,
  'advapi32.dll!CryptReleaseContext': release,
  'advapi32.dll!CryptContextAddRef': addRef,
  'advapi32.dll!SystemFunction036': (r, a) => {
    if (a(1)) fillGuestEntropy(r, a(0), a(1) >>> 0);
    return ok(1, 2);
  },
  'bcrypt.dll!BCryptGenRandom': (r, a) => {
    if (a(0)) return ok(0xc0000008, 4); // no opened algorithms
    if (a(3) !== 2) return ok(0xc000000d, 4); // BCRYPT_USE_SYSTEM_PREFERRED_RNG
    if (a(2)) fillGuestEntropy(r, a(1), a(2) >>> 0);
    return ok(0, 4);
  },
};
