// Content-addressed package storage. Runtime output gets its own namespace.
export async function packageId(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
export async function savePackage(id, bytes) {
  const root = await navigator.storage.getDirectory();
  const packages = await root.getDirectoryHandle('winebrowser-packages', { create: true });
  const file = await packages.getFileHandle(id, { create: true });
  const stream = await file.createWritable();
  await stream.write(bytes);
  await stream.close();
}
export async function saveOutputs(id, outputs) {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle('winebrowser-output', { create: true });
  const dir = await base.getDirectoryHandle(id, { create: true });
  for (const { path, bytes } of outputs) {
    let target = dir;
    const parts = path.split('/');
    for (const part of parts.slice(0, -1))
      target = await target.getDirectoryHandle(part, { create: true });
    const f = await target.getFileHandle(parts.at(-1), { create: true });
    const w = await f.createWritable();
    await w.write(bytes);
    await w.close();
  }
}
