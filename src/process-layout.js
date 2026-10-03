import { processCommandLine } from './command-line.js';
import { packageDosPath } from './guest-paths.js';
import { allocateEnvironmentBlock } from './guest-environment.js';

// Process-owned addresses in the fixed 64 MiB PE32 address space. Wine i386
// places a 0x800-byte debug_info immediately after its 0x1000-byte TEB; keep
// the PEB on a separate page so unchanged guest debug helpers cannot corrupt it.
export const PROCESS_LAYOUT = Object.freeze({
  teb: 0x02e00000,
  tebSize: 0x1000,
  wineDebugSize: 0x800,
  peb: 0x02e02000,
  stackBase: 0x04000000,
  stackLimit: 0x03c00000,
});
export const PEB_PROCESS_HEAP = PROCESS_LAYOUT.peb + 0x18;

export function initializeProcessLayout(runtime) {
  initializeThreadLayout(runtime, { ...PROCESS_LAYOUT, threadId: 1 });
  const { peb } = PROCESS_LAYOUT;
  runtime.write32(peb + 8, runtime.pe.imageBase);
  runtime.write32(peb + 0x64, 1);
  // A standalone MSVC CRT reads PEB.ProcessParameters directly during exit.
  // Provide normalized PE32 RTL_USER_PROCESS_PARAMETERS even without ntdll.
  // Native Wine replaces this bootstrap allocation with its own parameters.
  const parameters = runtime.allocate(0x290);
  runtime.write32(parameters, 0x290);
  runtime.write32(parameters + 4, 0x290);
  runtime.write32(parameters + 8, 1); // RTL_USER_PROC_PARAMS_NORMALIZED
  runtime.write32(parameters + 0x1c, 1); // stdout, matching GetStdHandle
  runtime.write32(parameters + 0x20, 2); // stderr
  for (const [offset, value] of [
    [0x24, packageDosPath(runtime.cwd, true)],
    [0x30, ''],
    [0x38, packageDosPath(runtime.exe)],
    [0x40, processCommandLine(runtime)],
  ]) {
    if (value.length > 32766 || value.includes('\0'))
      throw Error('Invalid process parameter string');
    const buffer = runtime.allocString(value, true);
    runtime.guestMemory.write(parameters + offset, value.length * 2, 2);
    runtime.guestMemory.write(parameters + offset + 2, (value.length + 1) * 2, 2);
    runtime.write32(parameters + offset + 4, buffer);
  }
  runtime.write32(parameters + 0x48, allocateEnvironmentBlock(runtime));
  runtime.write32(peb + 0x10, parameters);
}

// Initialize a separately allocated TEB/debug block without changing process
// data. Allocation, stack ownership, TLS and lifecycle belong to the scheduler.
export function initializeThreadLayout(
  runtime,
  { teb, peb, stackBase, stackLimit, threadId, processId = 1, syscallDispatcher = 0 },
) {
  for (const value of [teb, peb, stackBase, stackLimit, threadId, processId, syscallDispatcher])
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw Error('Invalid thread layout');
  const size = PROCESS_LAYOUT.tebSize + PROCESS_LAYOUT.wineDebugSize;
  if (
    !threadId ||
    !processId ||
    !teb ||
    !peb ||
    teb % 4096 ||
    stackBase % 4 ||
    stackLimit % 4 ||
    stackBase <= stackLimit ||
    (teb < stackBase && teb + size > stackLimit) ||
    (stackLimit < peb + 4096 && stackBase > peb) ||
    (teb < peb + 4096 && teb + size > peb)
  )
    throw Error('Invalid thread layout');
  runtime.check(teb, size, true);
  runtime.check(stackLimit, stackBase - stackLimit, true);
  runtime.check(peb, 0x68);
  runtime.data.fill(0, teb, teb + size);
  runtime.write32(teb, 0xffffffff);
  runtime.write32(teb + 4, stackBase);
  runtime.write32(teb + 8, stackLimit);
  runtime.write32(teb + 0x18, teb);
  runtime.write32(teb + 0x20, processId);
  runtime.write32(teb + 0x24, threadId);
  runtime.write32(teb + 0x30, peb);
  runtime.write32(teb + 0xc0, syscallDispatcher);
  // Wine normally initializes these in its host TEB allocator. Native ANSI
  // filename helpers and activation-context queries require real per-thread
  // backing storage even when the process has no active manifest context.
  runtime.write32(teb + 0x1a8, teb + 0x184);
  runtime.write32(teb + 0x188, teb + 0x188);
  runtime.write32(teb + 0x18c, teb + 0x188);
  runtime.write32(teb + 0xbf8, 522 << 16); // UNICODE_STRING: length 0, capacity 261 WCHARs.
  runtime.write32(teb + 0xbfc, teb + 0xc00);
}
