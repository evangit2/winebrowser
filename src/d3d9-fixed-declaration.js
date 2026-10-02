import { fvfLayout } from './d3d-fvf.js';
import { MAX_FRAME_BYTES } from './d3d-limits.js';

// The fixed pipeline also accepts declarations equivalent to an FVF. Pack
// those elements into the existing fixed vertex representation, including
// float colors commonly used by particle systems.
export function fixedDeclarationVertices(state, vertices, stride, vertexCount) {
  const elements = state.vertexDeclaration?.state.elements;
  if (!elements) return { state, vertices, stride };
  const find = (usage, index = 0) =>
    elements.find((e) => e.usage === usage && e.usageIndex === index);
  const position = find(0) ?? find(9),
    normal = find(2),
    diffuse = find(10),
    specular = find(10, 1);
  if (
    !position ||
    ![2, 3].includes(position.type) ||
    (position.usage === 9 && position.type !== 3) ||
    elements.some((e) => ![0, 2, 5, 9, 10].includes(e.usage) || e.offset + e.size > stride) ||
    elements.some((e) => e.usage !== 5 && e.usageIndex > (e.usage === 10 ? 1 : 0)) ||
    (normal && normal.type !== 2) ||
    [diffuse, specular].some((e) => e && ![3, 4].includes(e.type))
  )
    throw Error('Unsupported fixed-function vertex declaration');
  const coords = elements.filter((e) => e.usage === 5);
  const count = coords.length ? Math.max(...coords.map((e) => e.usageIndex)) + 1 : 0;
  if (count > 8 || coords.some((e) => e.type > 3))
    throw Error('Unsupported fixed texture coordinate declaration');
  let fvf =
    (position.usage === 9 ? 4 : 2) |
    (normal ? 0x10 : 0) |
    (diffuse ? 0x40 : 0) |
    (specular ? 0x80 : 0) |
    (count << 8);
  for (let index = 0; index < count; index++) {
    const e = find(5, index),
      components = e ? e.type + 1 : 2;
    fvf |= [3, 0, 1, 2][components - 1] << (16 + index * 2);
  }
  fvf >>>= 0;
  const layout = fvfLayout(fvf);
  if (
    !layout ||
    vertices.length < vertexCount * stride ||
    vertexCount * layout.size > MAX_FRAME_BYTES
  )
    throw Error('Invalid fixed declaration vertex bytes');
  const packed = new Uint8Array(vertexCount * layout.size);
  const source = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength),
    target = new DataView(packed.buffer);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const from = vertex * stride,
      to = vertex * layout.size;
    const copy = (element, offset, size) =>
      packed.set(
        vertices.subarray(from + element.offset, from + element.offset + size),
        to + offset,
      );
    copy(position, 0, layout.rhw ? 16 : 12);
    if (normal) copy(normal, layout.normal, 12);
    for (const [element, offset] of [
      [diffuse, layout.diffuse],
      [specular, layout.specular],
    ]) {
      if (!element) continue;
      if (element.type === 4) copy(element, offset, 4);
      else {
        const rgba = Array.from({ length: 4 }, (_, i) =>
          source.getFloat32(from + element.offset + i * 4, true),
        );
        if (!rgba.every(Number.isFinite)) throw Error('Non-finite fixed vertex color');
        const bytes = rgba.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
        target.setUint32(
          to + offset,
          ((bytes[3] << 24) | (bytes[0] << 16) | (bytes[1] << 8) | bytes[2]) >>> 0,
          true,
        );
      }
    }
    for (let index = 0; index < count; index++) {
      const e = find(5, index);
      if (e) copy(e, layout.texcoords[index].offset, layout.texcoords[index].size);
    }
  }
  return {
    state: { ...state, fvf, vertexDeclaration: null },
    vertices: packed,
    stride: layout.size,
  };
}
