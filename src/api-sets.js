// UCRT contract destinations from Wine db11d0fe6a169c457e23d007e20404643d067aa8,
// dlls/apisetschema/apisetschema.spec. Contracts alias a real DLL; they do not
// supply implementations or fabricate successful calls when it is unavailable.
const CRT_CONTRACTS = new Set(
  'conio convert environment filesystem heap locale math multibyte private process runtime stdio string time utility'
    .split(' ')
    .map((name) => `api-ms-win-crt-${name}-l1-1-0.dll`),
);

// The Windows API sets forward every kernel32/user32/etc. entry point by
// contract. Wine's apisetschema.spec maps the core contracts onto the real
// kernelbase/kernel32 modules; a program that LoadLibrary's
// "api-ms-win-core-synch-l1-2-0" and then GetProcAddress's InitializeCriticalSectionEx
// must reach kernel32, or it calls a null pointer. The names below are the core
// contracts with their Wine destinations.
const API_SET_CONTRACTS = new Map(
  [
    'api-ms-win-core-synch-l1-1-0',
    'api-ms-win-core-synch-l1-2-0',
    'api-ms-win-core-processthreads-l1-1-0',
    'api-ms-win-core-processthreads-l1-1-1',
    'api-ms-win-core-processthreads-l1-1-2',
    'api-ms-win-core-handle-l1-1-0',
    'api-ms-win-core-file-l1-1-0',
    'api-ms-win-core-file-l1-2-0',
    'api-ms-win-core-memory-l1-1-0',
    'api-ms-win-core-memory-l1-1-1',
    'api-ms-win-core-heap-l1-1-0',
    'api-ms-win-core-heap-l2-1-0',
    'api-ms-win-core-errorhandling-l1-1-0',
    'api-ms-win-core-errorhandling-l1-1-1',
    'api-ms-win-core-libraryloader-l1-1-0',
    'api-ms-win-core-libraryloader-l1-1-1',
    'api-ms-win-core-libraryloader-l1-2-0',
    'api-ms-win-core-localization-l1-1-0',
    'api-ms-win-core-localization-l1-2-0',
    'api-ms-win-core-interlocked-l1-1-0',
    'api-ms-win-core-sysinfo-l1-1-0',
    'api-ms-win-core-sysinfo-l1-2-0',
    'api-ms-win-core-timezone-l1-1-0',
    'api-ms-win-core-datetime-l1-1-0',
    'api-ms-win-core-debug-l1-1-0',
    'api-ms-win-core-rtlsupport-l1-1-0',
    'api-ms-win-core-string-l1-1-0',
    'api-ms-win-core-util-l1-1-0',
    'api-ms-win-core-io-l1-1-0',
    'api-ms-win-core-io-l1-1-1',
    'api-ms-win-core-console-l1-1-0',
    'api-ms-win-core-console-l1-2-0',
    'api-ms-win-core-processenvironment-l1-1-0',
    'api-ms-win-core-processenvironment-l1-2-0',
    'api-ms-win-core-namedpipe-l1-1-0',
    'api-ms-win-core-fibers-l1-1-0',
    'api-ms-win-core-fibers-l1-1-1',
  ].map((name) => [name + '.dll', 'kernel32.dll']),
);
const API_SET_PREFIXES = [
  'api-ms-win-core-',
  'api-ms-win-crt-',
  'api-ms-win-security-',
  'api-ms-win-service-',
  'api-ms-win-appmodel-',
  'ext-ms-win-',
];

export function resolveApiSet(name) {
  // ModuleGraph adds a `.dll` suffix to a bare name before it resolves, so the
  // contract tables are keyed with the suffix and matched the same way.
  const lower = name.toLowerCase();
  const suffixed = lower.endsWith('.dll') ? lower : lower + '.dll';
  if (CRT_CONTRACTS.has(suffixed)) return 'ucrtbase.dll';
  const contract = API_SET_CONTRACTS.get(suffixed);
  if (contract) return contract;
  // A core contract with no explicit destination still belongs to kernel32;
  // every other api-ms-win family ends in -l1-1-0 or similar and is resolved
  // by its own destination DLL when the runtime has one.
  if (API_SET_PREFIXES.some((prefix) => lower.startsWith(prefix)))
    return API_SET_CONTRACTS.get(suffixed) ?? name;
  return name;
}
