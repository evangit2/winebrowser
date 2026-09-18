import { PROCESS_LAYOUT } from './process-layout.js';
import { processCommandLine } from './command-line.js';

// PE32 offsets from Wine 11's winternl.h. Wine creates and owns the variable
// length RTL_USER_PROCESS_PARAMETERS allocation; only its PEB pointer is ours.
export const PEB_PROCESS_PARAMETERS = PROCESS_LAYOUT.peb + 0x10;
export const PEB_FAST_LOCK = PROCESS_LAYOUT.peb + 0x1c;
const PARAMETER_EXPORTS = [
  'RtlInitializeCriticalSectionEx',
  'RtlCreateProcessParametersEx',
  'RtlCreateEnvironment',
  'RtlSetCurrentEnvironment',
];

export async function initializeWineParameters(runtime, module, heap, heapExports) {
  const entries = PARAMETER_EXPORTS.map((name) =>
    module.pe.exports.find((entry) => entry.name === name),
  );
  if (entries.every((entry) => !entry)) return null; // Syscall/heap-only test libraries.
  if (entries.some((entry) => !entry || entry.forwarder))
    throw Error('Wine process bootstrap requires direct parameter and critical-section exports');
  const [initializeLock, createParameters, createEnvironment, setEnvironment] = entries.map(
    (entry) => module.base + entry.rva,
  );
  const lock = await runtime.callGuest(heapExports.RtlAllocateHeap, [heap, 8, 24]);
  if (!lock) throw Error('Wine process lock allocation failed');
  const lockStatus = await runtime.callGuest(initializeLock, [lock, 0, 0]);
  if (lockStatus)
    throw Error(`Wine process lock initialization failed: 0x${lockStatus.toString(16)}`);
  runtime.write32(PEB_FAST_LOCK, lock);

  const scratch = [];
  const allocate = (size) => {
    const address = runtime.allocate(size);
    scratch.push(address);
    return address;
  };
  const string = (value) => {
    if (value.length > 32766 || value.includes('\0'))
      throw Error('Invalid process parameter string');
    const address = allocate(8 + (value.length + 1) * 2);
    runtime.guestMemory.write(address, value.length * 2, 2);
    runtime.guestMemory.write(address + 2, (value.length + 1) * 2, 2);
    runtime.write32(address + 4, address + 8);
    for (let i = 0; i < value.length; i++)
      runtime.guestMemory.write(address + 8 + i * 2, value.charCodeAt(i), 2);
    return address;
  };
  try {
    const result = allocate(4);
    const image = string(runtime.exe.replaceAll('/', '\\'));
    const currentDirectory = runtime.cwd.replaceAll('/', '\\') || '\\';
    if (currentDirectory.length >= 260) throw Error('Wine current directory exceeds MAX_PATH');
    const directory = string(currentDirectory);
    const commandLine = string(processCommandLine(runtime));
    // An isolated process starts with an empty UTF-16 environment. Never copy
    // browser/host process variables.
    const environment = allocate(4);
    const status = await runtime.callGuest(createParameters, [
      result,
      image,
      0,
      directory,
      commandLine,
      environment,
      0,
      0,
      0,
      0,
      1,
    ]);
    if (status) throw Error(`Wine process parameters failed: 0x${status.toString(16)}`);
    const parameters = runtime.read32(result);
    if (!parameters) throw Error('Wine returned null process parameters');
    // Match the handles exposed by the existing console provider. Stdin stays
    // null because this runtime does not yet supply an input stream.
    const getStdHandle = runtime.apiProvider.get('kernel32.dll!GetStdHandle');
    for (const [offset, id] of [
      [0x1c, 0xfffffff5],
      [0x20, 0xfffffff4],
    ]) {
      const { result: handle } = await getStdHandle(runtime, () => id);
      runtime.write32(parameters + offset, handle);
    }
    runtime.write32(PEB_PROCESS_PARAMETERS, parameters);
    // Like Wine's init_user_process_params, use a separate heap allocation for
    // the live environment so RtlSetEnvironmentVariable can resize/free it.
    // The constructor's embedded copy belongs to the parameter allocation and
    // must not be passed to RtlFreeHeap; retain it via the old-environment output.
    const environmentResult = allocate(4);
    const oldEnvironment = allocate(4);
    const environmentStatus = await runtime.callGuest(createEnvironment, [0, environmentResult]);
    if (environmentStatus)
      throw Error(`Wine environment creation failed: 0x${environmentStatus.toString(16)}`);
    const processEnvironment = runtime.read32(environmentResult);
    if (!processEnvironment) throw Error('Wine returned null environment');
    await runtime.callGuest(setEnvironment, [processEnvironment, oldEnvironment]);
    return { lock, parameters };
  } finally {
    for (const address of scratch) runtime.free(address);
  }
}
