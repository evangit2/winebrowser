// Minimal process bootstrap for a guest Wine ntdll. The heap implementation
// stays inside the unmodified PE; only its normal PEB pointer is installed here.
import { PEB_PROCESS_HEAP } from './process-layout.js';
export { PEB_PROCESS_HEAP } from './process-layout.js';
const HEAP_EXPORTS = ['RtlCreateHeap', 'RtlAllocateHeap', 'RtlFreeHeap', 'RtlDestroyHeap'];

export async function initializeWineProcess(runtime, module) {
  if (!module.ntBridge || runtime.wineProcess) return;
  const entries = HEAP_EXPORTS.map((name) => module.pe.exports.find((e) => e.name === name));
  if (entries.every((entry) => !entry)) return; // Portable syscall-only fixtures.
  if (entries.some((entry) => !entry || entry.forwarder))
    throw Error('Wine process bootstrap requires direct Rtl heap exports');
  const exports = Object.fromEntries(entries.map((entry) => [entry.name, module.base + entry.rva]));
  const before = new Set(runtime.virtualMemory.reservations.keys());
  const image = runtime.data.slice(module.base, module.base + module.pe.imageSize);
  let heap;
  try {
    heap = await runtime.callGuest(exports.RtlCreateHeap, [2, 0, 0, 0, 0, 0]);
    if (!heap) throw Error('Wine process heap creation failed');
  } catch (error) {
    // The DLL may already have assigned its private process_heap global.
    runtime.data.set(image, module.base);
    for (const base of runtime.virtualMemory.reservations.keys())
      if (!before.has(base)) runtime.virtualMemory.free(base, 0, 0x8000);
    throw error;
  }
  runtime.write32(PEB_PROCESS_HEAP, heap);
  const reservations = [...runtime.virtualMemory.reservations.keys()].filter(
    (base) => !before.has(base),
  );
  runtime.wineProcess = { module, heap, exports, reservations };
}

export function callWineHeap(runtime, name, args) {
  if (!runtime.wineProcess) throw Error('Wine process heap is not initialized');
  return runtime.callGuest(runtime.wineProcess.exports[name], args);
}
