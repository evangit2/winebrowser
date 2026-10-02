// Fixed-function vertex declarations. XYZ uses object space and the device
// world/view/projection transforms; XYZRHW carries pre-transformed screen-space
// coordinates (x, y, z, 1/w) that bypass those transforms, as 2D sprites and UI
// overlays expect. Optional normal, diffuse, specular and up to eight sized texture coordinates follow.
// Unsupported layouts remain explicit.
const D3DFVF_XYZ = 0x2;
const D3DFVF_XYZRHW = 0x4;

export function fvfLayout(fvf = 0x42) {
  if (!Number.isInteger(fvf) || fvf < 0 || fvf > 0xffffffff || fvf & ~0xffff0fd6) return null;
  const transformed = !!(fvf & D3DFVF_XYZRHW);
  // Exactly one position declaration is required.
  if (transformed === !!(fvf & D3DFVF_XYZ)) return null;
  const textureCount = (fvf >>> 8) & 15;
  if (textureCount > 8 || (textureCount < 8 && fvf >>> (16 + textureCount * 2))) return null;
  let offset = transformed ? 16 : 12;
  const layout = {
    rhw: transformed,
    position: 0,
    normal: null,
    diffuse: null,
    specular: null,
    uv: null,
    uvSize: 2,
    texcoords: [],
  };
  for (const [field, bit, size] of [
    ['normal', 0x10, 12],
    ['diffuse', 0x40, 4],
    ['specular', 0x80, 4],
  ])
    if (fvf & bit) {
      layout[field] = offset;
      offset += size;
    }
  for (let i = 0; i < textureCount; i++) {
    const components = [2, 3, 4, 1][(fvf >>> (16 + i * 2)) & 3];
    layout.texcoords.push({
      offset,
      components,
      size: components * 4,
      format: components === 1 ? 'float32' : `float32x${components}`,
    });
    if (i === 0) {
      layout.uv = offset;
      layout.uvSize = components;
    }
    offset += components * 4;
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
    ['uv', 2, layout.texcoords[0]?.format],
  ])
    if (layout[field] !== null)
      layout.attributes.push({ shaderLocation: location, offset: layout[field], format });
  return layout;
}
