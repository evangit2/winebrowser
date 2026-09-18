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
  const { teb, peb, stackBase, stackLimit } = PROCESS_LAYOUT;
  runtime.write32(teb, 0xffffffff);
  runtime.write32(teb + 4, stackBase);
  runtime.write32(teb + 8, stackLimit);
  runtime.write32(teb + 0x18, teb);
  runtime.write32(teb + 0x20, 1);
  runtime.write32(teb + 0x24, 1);
  runtime.write32(teb + 0x30, peb);
  runtime.write32(peb + 8, runtime.pe.imageBase);
  runtime.write32(peb + 0x64, 1);
}
