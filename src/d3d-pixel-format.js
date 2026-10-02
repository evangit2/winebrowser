// Decoded legacy texture snapshots retain the precision of their guest format.
// Other supported formats are decoded to RGBA8; A16B16G16R16 is already native
// little-endian RGBA16 UNORM and must never pass through an 8-bit intermediate.
export const snapshotFormat = (snapshot) => snapshot?.format ?? 'rgba8unorm';
export const snapshotPixelBytes = (snapshot) =>
  snapshotFormat(snapshot) === 'rgba16unorm' ? 8 : 4;
export const validSnapshotFormat = (snapshot) =>
  [undefined, 'rgba8unorm', 'rgba16unorm'].includes(snapshot?.format);
export const targetGPUFormat = (format) => (format === 36 ? 'rgba16unorm' : 'rgba8unorm');
export const targetPixelBytes = (format) => (format === 36 ? 8 : 4);
export const colorTargetFormats = [21, 22, 23, 36];

// WebGPU's normalized 16-bit attachment formats are unfilterable. Preserve
// all UNORM16 components in float32 sampling textures (23-bit significands),
// whose linear filtering is available with float32-filterable. Render targets
// themselves stay native RGBA16 UNORM; no stage reduces them to eight bits.
export const samplingFormat = (snapshot) =>
  snapshotFormat(snapshot) === 'rgba16unorm' ? 'rgba32float' : 'rgba8unorm';
export const samplingPixelBytes = (snapshot) =>
  snapshotFormat(snapshot) === 'rgba16unorm' ? 16 : 4;
export function samplingPixels(snapshot, level) {
  if (snapshotFormat(snapshot) !== 'rgba16unorm') return level.rgba;
  const view = new DataView(level.rgba.buffer, level.rgba.byteOffset, level.rgba.byteLength);
  const values = new Float32Array(level.rgba.byteLength / 2);
  for (let i = 0; i < values.length; i++) values[i] = view.getUint16(i * 2, true) / 65535;
  return values;
}

export function supportsGuestFormat(runtime, format) {
  return format !== 36 || runtime.graphics?.supportsRGBA16Unorm === true;
}
