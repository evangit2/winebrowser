// Unblended XYZ fixed-function declarations, with optional normal, diffuse,
// specular and one float2 UV. Unsupported layouts remain explicit.
export function fvfLayout(fvf = 0x42) {
  if (!Number.isInteger(fvf) || fvf < 0 || fvf > 0xffffffff || fvf & ~0x1d2 || !(fvf & 2))
    return null;
  let offset = 12;
  const layout = { position: 0, normal: null, diffuse: null, specular: null, uv: null };
  for (const [field, bit, size] of [
    ['normal', 0x10, 12],
    ['diffuse', 0x40, 4],
    ['specular', 0x80, 4],
    ['uv', 0x100, 8],
  ])
    if (fvf & bit) {
      layout[field] = offset;
      offset += size;
    }
  layout.size = offset;
  layout.attributes = [{ shaderLocation: 0, offset: 0, format: 'float32x3' }];
  for (const [field, location, format] of [
    ['normal', 3, 'float32x3'],
    ['diffuse', 1, 'unorm8x4'],
    ['specular', 4, 'unorm8x4'],
    ['uv', 2, 'float32x2'],
  ])
    if (layout[field] !== null)
      layout.attributes.push({ shaderLocation: location, offset: layout[field], format });
  return layout;
}
