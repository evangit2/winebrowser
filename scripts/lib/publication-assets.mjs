import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
const forbiddenName =
  /(?:^|\/)(?:hamsterball[^/]*\.(?:exe|dll|zip|wasm)|bass[^/]*\.dll|[^/]*\.mo3)$/i;

export function inspectPublicationAsset(name, bytes, privateHashes = new Map(), depth = 0) {
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (forbiddenName.test(name.replaceAll('\\', '/')) || privateHashes.has(hash))
    throw Error(
      `Private game asset cannot be published: ${name}${privateHashes.has(hash) ? ` (matches ${privateHashes.get(hash)})` : ''}`,
    );
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) {
    if (depth >= 8) throw Error(`Publication archive nesting limit exceeded: ${name}`);
    let expanded = 0;
    const entries = unzipSync(bytes, {
      filter(entry) {
        expanded += entry.originalSize;
        if (expanded > 128 * 1024 * 1024)
          throw Error(`Publication archive size limit exceeded: ${name}`);
        return true;
      },
    });
    for (const [path, content] of Object.entries(entries))
      inspectPublicationAsset(`${name}/${path}`, content, privateHashes, depth + 1);
  }
}
