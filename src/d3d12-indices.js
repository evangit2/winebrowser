// Validate upload snapshots at submission time: mapped index data can change
// after DrawIndexedInstanced records the buffer view and before execution.
export const indexElementBytes = (format) =>
  format === 'uint16' ? 2 : format === 'uint32' ? 4 : 0;

export function validateIndexSnapshot(command, vertexCapacity = null) {
  const { indices, indexFormat, indexCount, firstIndex, baseVertex } = command;
  const width = indexElementBytes(indexFormat);
  if (
    !width ||
    !(indices instanceof Uint8Array) ||
    !indices.length ||
    indices.length > 8 * 1024 * 1024 ||
    indices.length % width ||
    !Number.isInteger(indexCount) ||
    indexCount < 1 ||
    indexCount > 65535 ||
    !Number.isInteger(firstIndex) ||
    firstIndex < 0 ||
    (firstIndex + indexCount) * width > indices.length ||
    !Number.isInteger(baseVertex) ||
    baseVertex < -0x80000000 ||
    baseVertex > 0x7fffffff ||
    (vertexCapacity !== null && (!Number.isInteger(vertexCapacity) || vertexCapacity < 0))
  )
    throw Error('Invalid D3D12 index buffer snapshot');
  const view = new DataView(indices.buffer, indices.byteOffset, indices.byteLength);
  for (let i = firstIndex; i < firstIndex + indexCount; i++) {
    const index = width === 2 ? view.getUint16(i * 2, true) : view.getUint32(i * 4, true);
    const vertex = index + baseVertex;
    if (vertex < 0 || vertex > 0x7fffffff || (vertexCapacity !== null && vertex >= vertexCapacity))
      throw Error('D3D12 index references a vertex outside the bound vertex buffer');
  }
}
