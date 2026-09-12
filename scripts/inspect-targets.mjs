import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inspect } from '../src/runtime.js';
const targets = [
  {
    name: '7zr',
    url: 'https://www.7-zip.org/a/7zr.exe',
    family: 'Console / filesystem / compression',
  },
  {
    name: 'putty-x86',
    url: 'https://the.earth.li/~sgtatham/putty/latest/w32/putty.exe',
    family: 'User32 / GDI / networking',
  },
];
await mkdir('.cache/targets', { recursive: true });
await mkdir('evidence', { recursive: true });
const results = [];
for (const target of targets) {
  const response = await fetch(target.url);
  if (!response.ok) throw Error(`${target.name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(`.cache/targets/${target.name}.exe`, bytes);
  let result;
  try {
    const pe = inspect(bytes);
    result = {
      machine: pe.machine,
      imports: pe.imports.length,
      unsupported: pe.unsupported,
      status: pe.unsupported.length ? 'blocked-imports' : 'imports-only-not-executed',
    };
  } catch (e) {
    result = { status: 'blocked-loader', error: e.message };
  }
  results.push({
    ...target,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    ...result,
  });
}
await writeFile(
  'evidence/third-party-inspection.json',
  JSON.stringify(
    {
      date: new Date().toISOString(),
      scope: 'Static PE/import inspection only; binaries not executed',
      results,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  results.map((x) => ({
    name: x.name,
    status: x.status,
    error: x.error,
    unsupported: x.unsupported?.length,
  })),
);
