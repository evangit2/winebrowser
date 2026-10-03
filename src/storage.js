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

export async function packageFilesId(files) {
  const entries = [];
  for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    entries.push([path, bytes.length, await packageId(bytes)]);
  return packageId(new TextEncoder().encode(JSON.stringify(entries)));
}

export async function savePackageFiles(id, files) {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle('winebrowser-file-packages', { create: true });
  const dir = await base.getDirectoryHandle(id, { create: true });
  const entries = [];
  // Stable names make repeated saves of the same content-addressed package
  // safe even when selection order changes or a prior worker was terminated.
  for (const [path, bytes] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const name = String(entries.length);
    const file = await dir.getFileHandle(name, { create: true });
    const stream = await file.createWritable();
    await stream.write(bytes);
    await stream.close();
    entries.push({ path, file: name, bytes: bytes.length });
  }
  // Publish the index last, after all file writes finish.
  const index = await dir.getFileHandle('manifest.json', { create: true });
  const stream = await index.createWritable();
  await stream.write(JSON.stringify({ version: 1, entries }));
  await stream.close();
}
export async function saveOutputs(id, outputs, deletedFiles = []) {
  const root = await navigator.storage.getDirectory();
  const base = await root.getDirectoryHandle('winebrowser-output', { create: true });
  const dir = await base.getDirectoryHandle(id, { create: true });
  for (const path of deletedFiles) {
    try {
      let target = dir;
      const parts = path.split('/');
      for (const part of parts.slice(0, -1)) target = await target.getDirectoryHandle(part);
      await target.removeEntry(parts.at(-1));
    } catch (error) {
      if (error.name !== 'NotFoundError') throw error;
    }
  }
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
