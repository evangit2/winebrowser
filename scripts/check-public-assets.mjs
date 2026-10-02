import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { inspectPublicationAsset } from './lib/publication-assets.mjs';

const manifest = JSON.parse(
  await readFile(new URL('./lib/private-game-asset-hashes.json', import.meta.url), 'utf8'),
);
const privateHashes = new Map(manifest.assets.map((asset) => [asset.sha256, asset.name]));

async function filesBelow(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) paths.push(...(await filesBelow(path)));
    else if (entry.isFile()) paths.push(path);
    else throw Error(`Unsupported publication asset: ${path}`);
  }
  return paths;
}

const paths = new Set([
  ...execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean),
  ...(await filesBelow('public')),
]);
for (const path of paths) inspectPublicationAsset(path, await readFile(path), privateHashes);
console.log(
  `Publication check passed: ${paths.size} repository/Pages files; private game hashes and archive contents checked.`,
);
