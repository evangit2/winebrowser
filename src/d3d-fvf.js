// Fixed-function vertex declarations. XYZ uses object space and the device
// world/view/projection transforms; XYZRHW carries pre-transformed screen-space
// coordinates (x, y, z, 1/w) that bypass those transforms, as 2D sprites and UI
// overlays expect. Optional normal, diffuse, specular and one float2 UV follow.
// Unsupported layouts remain explicit.
const D3DFVF_XYZ = 0x2;
const D3DFVF_XYZRHW = 0x4;

export function fvfLayout(fvf = 0x42) {
  if (!Number.isInteger(fvf) || fvf < 0 || fvf > 0xffffffff || fvf & ~0x1d6) return null;
  const transformed = !!(fvf & D3DFVF_XYZRHW);
  // Exactly one position declaration is required.
  if (transformed === !!(fvf & D3DFVF_XYZ)) return null;
  let offset = transformed ? 16 : 12;
  const layout = {
    rhw: transformed,
    position: 0,
    normal: null,
    diffuse: null,
    specular: null,
    uv: null,
  };
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
  // XYZRHW carries (x, y, z, rhw) in the same 16 bytes a float32x4 occupies, so
  // the stride and every trailing offset are identical to the XYZ case.
  layout.attributes = [
    { shaderLocation: 0, offset: 0, format: transformed ? 'float32x4' : 'float32x3' },
  ];
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
