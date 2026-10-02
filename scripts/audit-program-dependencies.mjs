import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ModuleGraph } from '../src/modules.js';
import { API_NAMES } from '../src/win32.js';
import { readLocalPackage } from './lib/local-package.mjs';
const [directory, exe, reportPath] = process.argv.slice(2);
if (!directory || !exe || !reportPath)
  throw Error('Usage: audit-program-dependencies.mjs program-folder relative-exe report.json');
const { files } = await readLocalPackage(directory);
const builtinFiles = new Map();
for (const name of ['ntdll', 'kernelbase', 'kernel32', 'ucrtbase', 'msvcrt'])
  builtinFiles.set(
    name + '.dll',
    new Uint8Array(await readFile('public/runtime/wine-base/' + name + '.dll')),
  );
const graph = new ModuleGraph(files, exe.toLowerCase(), API_NAMES, builtinFiles);
graph.map(new WebAssembly.Memory({ initial: 4096 }), []);
const report = {
  scope:
    'Static Windows x86 import closure resolves through the ordinary module graph. Rendering/input/exit are independently verified by the browser acceptance test; this audit does not execute every export or establish arbitrary DLL compatibility.',
  executable: exe,
  modules: [...graph.modules.values()].map((module) => ({
    name: module.name,
    path: module.path,
    provider: module.host
      ? 'WineBrowser host implementation'
      : files.has(module.path)
        ? 'uploaded native Windows x86 code'
        : 'bundled Wine source Windows x86 code',
    ...(module.host
      ? {}
      : {
          sha256: createHash('sha256')
            .update(files.get(module.path) || builtinFiles.get(module.name))
            .digest('hex'),
        }),
    imports:
      module.pe?.imports.map((entry) => ({
        dll: entry.dll,
        symbol: entry.name ?? entry.ordinal,
      })) || [],
  })),
  unresolved: graph.unresolved,
};
await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(`${report.modules.length} modules resolve without missing DLLs or imports.`);
