// Native DXGI BC formats store 4x4 blocks. Copy footprints count block rows,
// while their Width/Height fields continue to describe texels.
export const BC_FORMATS = Object.freeze({
  71: { format: 'bc1-rgba-unorm', bytes: 8 },
  72: { format: 'bc1-rgba-unorm-srgb', bytes: 8 },
  74: { format: 'bc2-rgba-unorm', bytes: 16 },
  75: { format: 'bc2-rgba-unorm-srgb', bytes: 16 },
  77: { format: 'bc3-rgba-unorm', bytes: 16 },
  78: { format: 'bc3-rgba-unorm-srgb', bytes: 16 },
});

export function textureRows(format, width, height, bytesPerPixel) {
  const bc = BC_FORMATS[format];
  if (!width || !height || (!bc && !bytesPerPixel))
    throw Error('Unsupported D3D12 texture footprint');
  return {
    rowSize: bc ? Math.ceil(width / 4) * bc.bytes : width * bytesPerPixel,
    rowCount: bc ? Math.ceil(height / 4) : height,
  };
}
