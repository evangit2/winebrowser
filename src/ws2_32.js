// Winsock 2. WineBrowser has no network transport, so these entry points model
// the API's own state machine (initialization, last-error, address conversion,
// socket bookkeeping) and fail socket I/O with WSAENETDOWN / WSAENOTCONN
// instead of silently succeeding. An application that only calls WSACleanup at
// startup (as Hamsterball's BASS DLL does) completes cleanly; one that needs
// real networking gets an honest error.
const WS_VERSION = 0x0202,
  WSAENETDOWN = 10050,
  WSAENOTCONN = 10057,
  WSAEINVAL = 10022,
  WSAEWOULDBLOCK = 10035;

const ok = (result = 0, argc = 0) => ({ result, argc });
function fail(r, code, argc, value = 0xffffffff) {
  r.wsaLastError = code;
  return ok(value, argc);
}

// WSAStartup(WORD wVersionRequested, LPWSADATA lpWSAData). The runtime accepts
// Winsock 2.x and fills the version, description and max-sockets fields.
function wsaStartup(r, a) {
  const version = a(0) & 0xffff;
  const out = a(1);
  if (!out) return fail(r, WSAEINVAL, 2, WSAEINVAL);
  r.check(out, 0x190, true);
  r.data.fill(0, out, out + 0x190);
  const major = Math.max(2, (version >> 8) & 0xff),
    minor = Math.max(2, version & 0xff);
  r.guestMemory.write(out, (minor << 8) | major, 2); // wVersion
  r.guestMemory.write(out + 2, (minor << 8) | major, 2); // wHighVersion
  const description = 'WineBrowser Winsock 2.2 (no network transport)';
  for (let i = 0; i < description.length && i < 256; i++)
    r.data[out + 4 + i] = description.charCodeAt(i);
  const systemStatus = '';
  for (let i = 0; i < systemStatus.length && i < 128; i++)
    r.data[out + 0x104 + i] = systemStatus.charCodeAt(i);
  r.guestMemory.write(out + 0x184, 0x101, 2); // iMaxSockets
  r.guestMemory.write(out + 0x186, 0x40, 2); // iMaxUdpDg
  // lpVendorInfo is left as a null pointer.
  r.wsaStarted = (r.wsaStarted ?? 0) + 1;
  r.wsaLastError = 0;
  return ok(0, 2);
}
function wsaCleanup(r) {
  if (r.wsaStarted) r.wsaStarted--;
  r.wsaLastError = 0;
  return ok(0, 0);
}
function wsaGetLastError(r) {
  return ok(r.wsaLastError ?? 0, 0);
}
function wsaSetLastError(r, a) {
  r.wsaLastError = a(0) >>> 0;
  return ok(0, 1);
}
// htons/htonl swap byte order; the argument is a 16- or 32-bit value.
function htons(r, a) {
  return ok(((a(0) & 0xffff) << 8) | ((a(0) >>> 8) & 0xff), 1);
}
function htonl(r, a) {
  const value = a(0) >>> 0;
  return ok(
    (((value & 0xff) << 24) |
      ((value & 0xff00) << 8) |
      ((value >>> 8) & 0xff00) |
      (value >>> 24)) >>>
      0,
    1,
  );
}
function ntohs(r, a) {
  return htons(r, a);
}
function ntohl(r, a) {
  return htonl(r, a);
}
// inet_addr parses a dotted decimal address into network byte order.
function inetAddr(r, a) {
  const text = r.string(a(0));
  const parts = text.split('.');
  if (parts.length !== 4) return fail(r, WSAEINVAL, 1, 0xffffffff);
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255)
      return fail(r, WSAEINVAL, 1, 0xffffffff);
    value = (value << 8) | octet;
  }
  // The API returns the address in network byte order.
  return ok(
    (((value & 0xff) << 24) |
      ((value & 0xff00) << 8) |
      ((value >>> 8) & 0xff00) |
      (value >>> 24)) >>>
      0,
    1,
  );
}
// inet_ntoa writes a dotted-decimal string into a per-process static buffer.
function inetNtoa(r, a) {
  const value = a(0) >>> 0;
  const text = [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join('.');
  if (!r.inetNtoaBuffer) r.inetNtoaBuffer = r.allocate(16);
  for (let i = 0; i < text.length; i++) r.data[r.inetNtoaBuffer + i] = text.charCodeAt(i);
  r.data[r.inetNtoaBuffer + text.length] = 0;
  return ok(r.inetNtoaBuffer, 1);
}
// Socket creation records a handle; every transfer then reports that the
// network is unavailable rather than pretending data moved.
function socket(r, a) {
  r.wsaSockets ??= new Map();
  const handle = (r.nextWsaHandle = (r.nextWsaHandle ?? 0x52000000) + 4);
  r.wsaSockets.set(handle, { family: a(0), type: a(1), protocol: a(2), bound: null });
  return ok(handle, 3);
}
function socketOp(r, a, argc) {
  const handle = a(0) >>> 0;
  if (!r.wsaSockets?.has(handle)) return fail(r, 10038, argc); // WSAENOTSOCK
  return fail(r, WSAENETDOWN, argc);
}
function closesocket(r, a) {
  const handle = a(0) >>> 0;
  if (!r.wsaSockets?.delete(handle)) return fail(r, 10038, 1);
  r.wsaLastError = 0;
  return ok(0, 1);
}
// WSAAsyncGetHostByName and friends queue a host lookup; with no resolver the
// request completes immediately in error, which the WM_ message reports.
function asyncRequest(r, a, argc) {
  const buffer = a(1);
  if (!buffer) return fail(r, WSAEINVAL, argc);
  r.check(buffer, 32, true);
  r.data.fill(0, buffer, buffer + 32);
  // A non-zero task handle is required; the message never arrives because the
  // network is unavailable, so the caller falls back.
  const task = (r.nextWsaAsync = (r.nextWsaAsync ?? 0x53000000) + 4);
  return fail(r, WSAENETDOWN, argc, task);
}

export const ws2Apis = {};
export const WS2_NAMES = {};

// Wine's ws2_32 ordinals, verified against dlls/ws2_32/ws2_32.spec's
// declaration order. Only the entry points the runtime models are listed;
// a program importing another ordinal resolves through its name when it has
// one and otherwise fails loudly.
const ORDINALS = {
  1: 'accept',
  2: 'bind',
  3: 'closesocket',
  4: 'connect',
  5: 'getpeername',
  6: 'getsockname',
  7: 'getsockopt',
  8: 'htonl',
  9: 'htons',
  10: 'ioctlsocket',
  11: 'inet_addr',
  12: 'inet_ntoa',
  13: 'listen',
  14: 'ntohl',
  15: 'ntohs',
  16: 'recv',
  17: 'recvfrom',
  18: 'select',
  19: 'send',
  20: 'sendto',
  21: 'setsockopt',
  22: 'shutdown',
  23: 'socket',
  57: 'gethostname',
  101: 'WSAAsyncSelect',
  102: 'WSAAsyncGetHostByAddr',
  103: 'WSAAsyncGetHostByName',
  108: 'WSACancelAsyncRequest',
  111: 'WSAGetLastError',
  112: 'WSASetLastError',
  115: 'WSAStartup',
  116: 'WSACleanup',
  151: '__WSAFDIsSet',
  165: 'WSAAccept',
  166: 'WSAAddressToStringA',
  168: 'WSACloseEvent',
  172: 'WSACreateEvent',
  180: 'WSAEventSelect',
  191: 'WSAIoctl',
  197: 'WSAGetOverlappedResult',
  203: 'WSARecv',
  208: 'WSASend',
  215: 'WSASocketA',
  216: 'WSASocketW',
  217: 'WSAStringToAddressA',
  233: 'freeaddrinfo',
  234: 'getaddrinfo',
};

// WS2_32's ordinals are also resolved through its name table, so the module
// exposes both. ImpSpec ordinals come from the exported table; a name is
// derived from `ORDINALS` for names exported at a fixed ordinal.
for (const [ordinal, name] of Object.entries(ORDINALS)) {
  const key = `ws2_32.dll!${name}`;
  WS2_NAMES[key] = name;
  WS2_NAMES[`ws2_32.dll!#${ordinal}`] = name;
  ws2Apis[key] = (r, a) => {
    switch (name) {
      case 'WSAStartup':
        return wsaStartup(r, a);
      case 'WSACleanup':
        return wsaCleanup(r);
      case 'WSAGetLastError':
        return wsaGetLastError(r);
      case 'WSASetLastError':
        return wsaSetLastError(r, a);
      case 'htonl':
        return htonl(r, a);
      case 'htons':
        return htons(r, a);
      case 'ntohl':
        return ntohl(r, a);
      case 'ntohs':
        return ntohs(r, a);
      case 'inet_addr':
        return inetAddr(r, a);
      case 'inet_ntoa':
        return inetNtoa(r, a);
      case 'socket':
        return socket(r, a);
      case 'closesocket':
        return closesocket(r, a);
      case 'WSAAsyncGetHostByName':
      case 'WSAAsyncGetHostByAddr':
        return asyncRequest(r, a, 6);
      default:
        return socketOp(r, a, 3);
    }
  };
}
// An ordinal that reaches the runtime as "#N" is the same handler as the name
// it denotes; unknown ordinals fail loudly rather than returning success.
for (const [ordinal, name] of Object.entries(ORDINALS))
  ws2Apis[`ws2_32.dll!#${ordinal}`] = ws2Apis[`ws2_32.dll!${name}`];
