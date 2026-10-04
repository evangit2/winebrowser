import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
const url = 'https://liquidninja.com/metapad/downloads/metapad36LE.zip';
const response = await fetch(url);
assert.ok(response.ok, `Metapad download failed: ${response.status}`);
const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
const entry = Object.entries(files).find(
  ([path]) => path.replaceAll('\\', '/').split('/').at(-1).toLowerCase() === 'metapad.exe',
);
assert.ok(entry, 'Official archive contains no Metapad executable');
const bytes = entry[1],
  sha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(
  sha256,
  'dafe4bab2ece746564c3e3210c820f32b1adfcb26edae256e20d27613c6cef6b',
  'Official executable differs from pinned test target',
);
await mkdir('.cache/metapad-le', { recursive: true });
await writeFile('.cache/metapad-le/metapad.exe', bytes);
console.log(
  `Cached unchanged Metapad 3.6 LE (${sha256}); no executable added to the repository or Pages.`,
);
