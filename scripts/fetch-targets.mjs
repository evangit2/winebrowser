import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'tests/targets.json'), 'utf8'));
const selectedIds = new Set(process.argv.slice(2));
for (const id of selectedIds)
  if (!manifest.targets.some((t) => t.id === id)) throw Error('Unknown target ' + id);
const cacheRoot = path.join(root, '.cache/targets');

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function safePath(relativePath) {
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Refusing path outside project: ${relativePath}`);
  }
  if (!resolved.startsWith(`${cacheRoot}${path.sep}`)) {
    throw new Error(`Target fetches may only write into .cache/targets: ${relativePath}`);
  }
  return resolved;
}

async function fetchBytes(url) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function saveVerified(url, relativePath, expectedSha256) {
  const dest = safePath(relativePath);
  let bytes;
  try {
    bytes = await readFile(dest);
    if (sha256(bytes) === expectedSha256) {
      console.log(`cached ${relativePath}`);
      return bytes;
    }
  } catch {
    // Fetch below.
  }

  bytes = await fetchBytes(url);
  const actual = sha256(bytes);
  if (actual !== expectedSha256) {
    throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
  }
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
  console.log(`fetched ${relativePath} (${bytes.length} bytes)`);
  return bytes;
}

for (const file of selectedIds.size ? [] : (manifest.referenceFiles ?? [])) {
  await saveVerified(file.url, file.path, file.sha256);
}

for (const target of manifest.targets) {
  if (selectedIds.size && !selectedIds.has(target.id)) continue;
  if (target.builtLocally) {
    console.log(`source-built cache artifact, not fetched: ${target.path}`);
    continue;
  }

  const url = target.source.downloadUrl;
  if (!url) {
    console.log(`no binary download configured: ${target.id}`);
    continue;
  }

  if (target.source.archiveSha256) {
    const archivePath = `.cache/targets/${target.id}.upstream.zip`;
    const archive = await saveVerified(url, archivePath, target.source.archiveSha256);
    const files = unzipSync(new Uint8Array(archive));
    if (target.extractArchive) {
      for (const [name, bytes] of Object.entries(files)) {
        if (name.endsWith('/')) continue;
        const dest = safePath(path.posix.join('.cache/targets', name));
        await mkdir(path.dirname(dest), { recursive: true });
        await writeFile(dest, bytes);
      }
    } else if (target.downloadEntry) {
      const bytes = files[target.downloadEntry];
      if (!bytes) throw new Error(`Missing ${target.downloadEntry} in ${url}`);
      const dest = safePath(target.path);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
      console.log(`extracted ${target.path} (${bytes.length} bytes)`);
    }
  } else {
    await saveVerified(url, target.path, target.sha256);
  }

  const binary = await readFile(safePath(target.path));
  const actual = sha256(binary);
  if (actual !== target.sha256) {
    throw new Error(
      `Binary SHA-256 mismatch for ${target.id}: expected ${target.sha256}, got ${actual}`,
    );
  }
}
