// Process bootstrap for a guest Wine ntdll. Heap, lock, parameters and NLS
// initialization execute inside the unmodified PE; host code owns their mappings.
import { PEB_PROCESS_HEAP } from './process-layout.js';
import { initializeWineNlsProcess, PEB_NLS_POINTERS } from './wine-nls-process.js';
import {
  initializeWineParameters,
  PEB_FAST_LOCK,
  PEB_PROCESS_PARAMETERS,
} from './wine-parameters.js';
export { PEB_PROCESS_HEAP } from './process-layout.js';
const HEAP_EXPORTS = ['RtlCreateHeap', 'RtlAllocateHeap', 'RtlFreeHeap', 'RtlDestroyHeap'];

export function snapshotWineProcessPointers(runtime) {
  return [
    PEB_PROCESS_HEAP,
    PEB_FAST_LOCK,
    PEB_PROCESS_PARAMETERS,
    ...Object.values(PEB_NLS_POINTERS),
  ].map((address) => [address, runtime.read32(address)]);
}

export function restoreWineProcessPointers(runtime, pointers) {
  for (const [address, value] of pointers) runtime.write32(address, value);
}

export async function initializeWineProcess(runtime, module) {
  if (!module.ntBridge || runtime.wineProcess) return;
  const entries = HEAP_EXPORTS.map((name) => module.pe.exports.find((e) => e.name === name));
  if (entries.every((entry) => !entry)) return; // Portable syscall-only fixtures.
  if (entries.some((entry) => !entry || entry.forwarder))
    throw Error('Wine process bootstrap requires direct Rtl heap exports');
  const exports = Object.fromEntries(entries.map((entry) => [entry.name, module.base + entry.rva]));
  const before = new Set(runtime.virtualMemory.reservations.keys());
  const image = runtime.data.slice(module.base, module.base + module.pe.imageSize);
  const pointers = snapshotWineProcessPointers(runtime);
  let heap;
  let parameters;
  let nls;
  try {
    heap = await runtime.callGuest(exports.RtlCreateHeap, [2, 0, 0, 0, 0, 0]);
    if (!heap) throw Error('Wine process heap creation failed');
    runtime.write32(PEB_PROCESS_HEAP, heap);
    parameters = await initializeWineParameters(runtime, module, heap, exports);
    nls = await initializeWineNlsProcess(runtime, module);
  } catch (error) {
    // The DLL may already have assigned its private process_heap global.
    runtime.data.set(image, module.base);
    restoreWineProcessPointers(runtime, pointers);
    for (const base of runtime.virtualMemory.reservations.keys())
      if (!before.has(base)) runtime.virtualMemory.free(base, 0, 0x8000);
    throw error;
  }
  const reservations = [...runtime.virtualMemory.reservations.keys()].filter(
    (base) => !before.has(base),
  );
  runtime.wineProcess = { module, heap, exports, reservations, nls, ...parameters };
}

export function callWineHeap(runtime, name, args) {
  if (!runtime.wineProcess) throw Error('Wine process heap is not initialized');
  return runtime.callGuest(runtime.wineProcess.exports[name], args);
}
