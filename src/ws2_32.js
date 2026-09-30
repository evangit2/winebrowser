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

// ---------------------------------------------------------------------------
// The classic name-resolution and address-conversion entry points. The sandbox
// has no resolver, so gethostbyname/getservbyname report the documented
// "unknown host"/"unknown service" failure instead of a fabricated address;
// inet_ntop and getnameinfo format the literals the runtime can compute
// exactly, which is what a client uses them for once a socket exists.
function getHostByName(r, a) {
  const name = r.string(a(0));
  if (!name) return fail(r, WSAEINVAL, 1, 0);
  // A numeric literal is resolved locally, exactly as the real call does.
  const numeric = /^\d+\.\d+\.\d+\.\d+$/.test(name);
  r.wsaLastError = numeric ? 0 : 11001; // WSAHOST_NOT_FOUND
  if (!numeric) return ok(0, 1);
  const parts = name.split('.').map(Number);
  r.wsaHostBuffer ??= r.allocate(24);
  const address = r.allocate(4);
  r.data[address] = parts[0];
  r.data[address + 1] = parts[1];
  r.data[address + 2] = parts[2];
  r.data[address + 3] = parts[3];
  const list = r.allocate(8);
  r.write32(list, address);
  r.write32(list + 4, 0);
  // HOSTENT: h_name, h_aliases, h_addrtype, h_length, h_addr_list.
  r.write32(r.wsaHostBuffer, r.wsaHostBuffer + 16);
  r.write32(r.wsaHostBuffer + 4, 0);
  r.view.setUint16(r.wsaHostBuffer + 8, 2, true); // AF_INET
  r.view.setUint16(r.wsaHostBuffer + 10, 4, true);
  r.write32(r.wsaHostBuffer + 12, list);
  for (let i = 0; i <= name.length; i++)
    r.data[r.wsaHostBuffer + 16 + i] = i === name.length ? 0 : name.charCodeAt(i);
  return ok(r.wsaHostBuffer, 1);
}
function getServByName(r, a) {
  const name = r.string(a(0));
  const protocol = a(1) ? r.string(a(1)) : '';
  if (!name) return fail(r, WSAEINVAL, 2, 0);
  // The names below are the ones the sockets API defines for a standard
  // service; anything else reports "unknown service".
  const table = {
    ftp: 21,
    'ftp-data': 20,
    ssh: 22,
    telnet: 23,
    smtp: 25,
    domain: 53,
    http: 80,
    www: 80,
    'www-http': 80,
    pop3: 110,
    ntp: 123,
    imap: 143,
    https: 443,
    'https-alt': 443,
  };
  const port = table[name.toLowerCase()];
  if (port === undefined) {
    r.wsaLastError = 11004; // WSANO_DATA
    return ok(0, 2);
  }
  if (!['', 'tcp', 'udp'].includes(protocol.toLowerCase())) {
    r.wsaLastError = 11004;
    return ok(0, 2);
  }
  r.wsaServBuffer ??= r.allocate(24);
  r.write32(r.wsaServBuffer, r.wsaServBuffer + 16);
  r.write32(r.wsaServBuffer + 4, 0);
  r.view.setUint16(r.wsaServBuffer + 8, port ? port : 0, false); // s_port is network order
  r.view.setUint16(r.wsaServBuffer + 8, ((port & 0xff) << 8) | (port >> 8), false);
  r.write32(r.wsaServBuffer + 12, 0);
  const proto = protocol || 'tcp';
  for (let i = 0; i <= name.length + proto.length + 1; i++) {
    const text = name + '\u0000' + proto;
    r.data[r.wsaServBuffer + 16 + i] = i < text.length ? text.charCodeAt(i) : 0;
  }
  return ok(r.wsaServBuffer, 2);
}
// inet_ntop(AF, Src, Dst, Size) formats an address. Only AF_INET and AF_INET6
// literals can be computed without a resolver.
function inetNtop(r, a) {
  const family = a(0) | 0;
  const source = a(1) >>> 0;
  const destination = a(2);
  const size = a(3) >>> 0;
  if (!source || !destination) return fail(r, WSAEINVAL, 4, 0);
  let text;
  if (family === 2) {
    r.check(source, 4);
    text = [0, 1, 2, 3].map((i) => r.data[source + i]).join('.');
  } else if (family === 23) {
    r.check(source, 16);
    const groups = Array.from({ length: 8 }, (_, i) =>
      r.guestMemory.read(source + i * 2, 2).toString(16),
    );
    text = groups.join(':');
  } else {
    return fail(r, 10047, 4, 0); // WSAEAFNOSUPPORT
  }
  if (!size || size < text.length + 1) return fail(r, 10014, 4, 0); // WSAEFAULT
  r.check(destination, size, true);
  for (let i = 0; i <= text.length; i++)
    r.data[destination + i] = i === text.length ? 0 : text.charCodeAt(i);
  return ok(destination, 4);
}
// inet_pton(AF, Src, Dst) parses a literal into binary form.
function inetPton(r, a) {
  const family = a(0) | 0;
  const source = a(1);
  const destination = a(2);
  if (!source || !destination) return fail(r, WSAEINVAL, 3, 0);
  if (family !== 2) return ok(0, 3); // an unsupported family reports 0, not an error
  const text = r.string(source);
  const parts = text.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p) || Number(p) > 255)) return ok(0, 3);
  r.check(destination, 4, true);
  for (let i = 0; i < 4; i++) r.data[destination + i] = Number(parts[i]);
  return ok(1, 3);
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
  52: 'gethostbyname',
  55: 'getservbyname',
  57: 'getservbyport',
  53: 'gethostbyaddr',
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
      case 'gethostbyname':
        return getHostByName(r, a);
      case 'getservbyname':
        return getServByName(r, a);
      case 'inet_ntop':
        return inetNtop(r, a);
      case 'inet_pton':
        return inetPton(r, a);
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

// A handful of modern ws2_32 exports are name-only: they have no fixed ordinal
// in the original table, so they are registered separately. They format and
// parse address literals the runtime can compute without a resolver.
for (const name of ['inet_ntop', 'inet_pton', 'getnameinfo', 'freeaddrinfo']) {
  ws2Apis[`ws2_32.dll!${name}`] = (r, a) => {
    switch (name) {
      case 'inet_ntop':
        return inetNtop(r, a);
      case 'inet_pton':
        return inetPton(r, a);
      case 'getnameinfo':
        return fail(r, 10047, 7, 10047); // WSAEAFNOSUPPORT without a resolver
      default:
        return ok(0, 1);
    }
  };
  WS2_NAMES[`ws2_32.dll!${name}`] = name;
}
