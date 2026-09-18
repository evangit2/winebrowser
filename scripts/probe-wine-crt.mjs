import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { parsePE } from '../src/pe.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuredWineDir = process.argv[2] || process.env.WINEBROWSER_WINE_DIR;
const wineDir = configuredWineDir ? path.resolve(configuredWineDir) : null;
const outputPath = path.join(repo, 'evidence/wine-crt-results.json');
const nlsDirectory = process.argv[3] || process.env.WINEBROWSER_NLS_DIR;
const nlsManifest = JSON.parse(
  await readFile(path.join(repo, 'runtime/wine/nls-probe-manifest.json'), 'utf8'),
);

// Pinned hashes from the initial installed-Wine closure probe. The closure is
// inspected first and never executed unless every name and hash matches.
const pinnedSha256 = {
  'msvcrt.dll': '612edff0b1d2493a6c491aa3be10f1b42a961f8516db8cffe3d59dbe4c192558',
  'kernel32.dll': 'c4b1f1f1210e85acc9f82a898664b1c79b6e83e0485cb59e2e6251885cde9418',
  'kernelbase.dll': '4fae98d80c69cf36fbfc669acbe87676f0ad06dcebb85cff7b4abee13912a6f6',
  'ntdll.dll': 'bac6f2d9434860d09a696dcdcd5f85631e19fd4f9409b3a39828841b7a40c089',
};

const result = {
  date: new Date().toISOString(),
  status: configuredWineDir ? 'blocked-startup' : 'blocked-integrity',
  wineDirectory: wineDir,
  nls: { directory: nlsDirectory ?? null, files: [] },
  executable: {
    path: 'public/demos/console/console.exe',
    behavior: 'Load the real msvcrt dependency closure; do not call the executable entry point.',
  },
  operation: "Runtime.loadLibrary('msvcrt.dll')",
  dlls: [],
  runtime: null,
  firstFailure: null,
  scope:
    'Optional probe of the whole unmodified installed Wine DLL closure rooted at msvcrt.dll. It performs Runtime.loadLibrary only; successful closure loading is not application execution or general CRT compatibility.',
  sources: [
    'https://github.com/wine-mirror/wine/blob/wine-11.0/dlls/ntdll/ntdll.spec (NtInitializeNlsFiles syscall declaration)',
    'https://github.com/wine-mirror/wine/blob/wine-11.0/dlls/ntdll/unix/env.c (NLS data mapping services)',
    'https://github.com/wine-mirror/wine/blob/wine-11.0/dlls/kernelbase/locale.c (kernelbase process-attach NLS loading)',
  ],
};

let runtime;
try {
  if (!wineDir)
    throw Object.assign(
      Error('Pass the i386 Wine DLL directory as an argument or set WINEBROWSER_WINE_DIR.'),
      { probeIntegrityError: true },
    );
  const files = new Map();
  const parsed = new Map();
  const queue = ['msvcrt.dll'];
  while (queue.length) {
    const name = queue.shift().toLowerCase();
    if (files.has(name)) continue;
    let bytes;
    let pe;
    try {
      bytes = new Uint8Array(await readFile(path.join(wineDir, name)));
      pe = parsePE(bytes, { allowDll: true });
    } catch (error) {
      throw Object.assign(Error(`Cannot inspect required closure DLL ${name}: ${error.message}`), {
        probeIntegrityError: true,
      });
    }
    files.set(name, bytes);
    parsed.set(name, pe);
    for (const dll of new Set(pe.imports.map((entry) => entry.dll.toLowerCase())))
      if (!files.has(dll)) queue.push(dll);
  }

  result.dlls = [...files].map(([name, bytes]) => {
    const pe = parsed.get(name);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return {
      name,
      bytes: bytes.byteLength,
      sha256,
      pinnedSha256: pinnedSha256[name] ?? null,
      matchesPinnedHash: pinnedSha256[name] ? sha256 === pinnedSha256[name] : null,
      imports: pe.imports.map((entry) => ({
        dll: entry.dll.toLowerCase(),
        name: entry.name ?? null,
        ordinal: entry.ordinal ?? null,
      })),
    };
  });

  const expectedNames = Object.keys(pinnedSha256).sort();
  const actualNames = [...files.keys()].sort();
  const integrityProblems = [];
  for (const missing of expectedNames.filter((name) => !files.has(name)))
    integrityProblems.push(`missing pinned DLL ${missing}`);
  for (const extra of actualNames.filter((name) => !pinnedSha256[name]))
    integrityProblems.push(`unrecognized closure DLL ${extra}`);
  for (const dll of result.dlls)
    if (dll.pinnedSha256 && dll.sha256 !== dll.pinnedSha256)
      integrityProblems.push(`pinned hash mismatch for ${dll.name}`);
  if (integrityProblems.length) {
    result.status = 'blocked-integrity';
    result.firstFailure = {
      phase: 'pinned DLL closure integrity check',
      error: { name: 'Error', message: integrityProblems.join('; ') },
      problems: integrityProblems,
    };
    throw Object.assign(Error(result.firstFailure.error.message), { probeIntegrityError: true });
  }

  const executableName = 'console.exe';
  const executableBytes = new Uint8Array(
    await readFile(path.join(repo, 'public/demos/console/console.exe')),
  );
  let nlsFiles;
  if (nlsDirectory) {
    nlsFiles = new Map();
    for (const [name, expected] of Object.entries(nlsManifest.files)) {
      const bytes = new Uint8Array(await readFile(path.join(nlsDirectory, name)));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== expected.sha256 || bytes.length !== expected.bytes)
        throw Object.assign(Error(`NLS integrity mismatch: ${name}`), {
          probeIntegrityError: true,
        });
      nlsFiles.set(name, bytes);
      result.nls.files.push({ name, bytes: bytes.length, sha256 });
    }
  }
  runtime = new Runtime(iced, {
    files: new Map([[executableName, executableBytes]]),
    exe: executableName,
    builtinFiles: files,
    nlsFiles,
  });

  let lastIP = null;
  const recentIPs = [];
  const step = runtime.cpu.step.bind(runtime.cpu);
  runtime.cpu.step = (ip) => {
    lastIP = ip >>> 0;
    recentIPs.push(lastIP);
    if (recentIPs.length > 16) recentIPs.shift();
    try {
      return step(ip);
    } catch (error) {
      // Capture guest state before failed-load rollback removes the DLL images.
      result.firstFailure ??= {
        phase: 'guest x86 execution',
        error: { name: error.name, message: error.message },
        instructionPointer: `0x${lastIP.toString(16)}`,
        recentInstructionPointers: recentIPs.map((address) => `0x${address.toString(16)}`),
        registers: Object.fromEntries(
          runtime.cpu.r.map((register, index) => [
            ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'][index],
            `0x${(register.value >>> 0).toString(16)}`,
          ]),
        ),
        modulesAtFailure: runtime.graph.describe(),
        blocks: runtime.blocks,
      };
      throw error;
    }
  };

  const api = runtime.api.bind(runtime);
  runtime.api = async (entry) => {
    try {
      return await api(entry);
    } catch (error) {
      if (!result.firstFailure) {
        const serviceId = runtime.cpu.r[0].value >>> 0;
        const service = entry.services?.get(serviceId);
        const stack = runtime.cpu.r[4].value >>> 0;
        const safeRead32 = (address) => {
          try {
            return runtime.read32(address) >>> 0;
          } catch {
            return null;
          }
        };
        result.firstFailure = {
          phase: 'guest DLL initialization / runtime API dispatch',
          error: { name: error.name, message: error.message },
          dispatcher: {
            dll: entry.dll,
            name: entry.name,
            serviceId: service ? serviceId : null,
            serviceIdHex: service ? `0x${serviceId.toString(16)}` : null,
            serviceName: service?.name ?? null,
            argumentCount: service?.argc ?? null,
            arguments: service
              ? Array.from({ length: service.argc }, (_, index) =>
                  safeRead32(stack + 8 + index * 4),
                )
              : [],
          },
          instructionPointer: lastIP === null ? null : `0x${lastIP.toString(16)}`,
          recentInstructionPointers: recentIPs.map((ip) => `0x${ip.toString(16)}`),
          registers: Object.fromEntries(
            runtime.cpu.r.map((register, index) => [
              ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'][index],
              `0x${(register.value >>> 0).toString(16)}`,
            ]),
          ),
          stackWords: Array.from({ length: 12 }, (_, index) => safeRead32(stack + index * 4)),
          modulesAtFailure: runtime.graph.describe(),
          apiTrace: [...runtime.apiTrace],
          blocks: runtime.blocks,
        };
      }
      throw error;
    }
  };

  await runtime.loadLibrary('msvcrt.dll');
  result.status = 'loaded-not-application-tested';
  result.runtime = {
    loaded: true,
    modules: runtime.graph.describe(),
    apiTrace: [...runtime.apiTrace],
    blocks: runtime.blocks,
  };
} catch (error) {
  if (error.probeIntegrityError) result.status = 'blocked-integrity';
  result.runtime = runtime
    ? {
        loaded: false,
        modulesAfterFailure: runtime.graph.describe(),
        apiTrace: [...runtime.apiTrace],
        blocks: runtime.blocks,
      }
    : { loaded: false };
  result.firstFailure ??= {
    phase: error.probeIntegrityError
      ? 'pinned DLL closure integrity check'
      : 'PE closure inspection or module loading',
    error: { name: error.name, message: error.message },
  };
}

result.processExitCode = result.status === 'loaded-not-application-tested' ? 0 : 1;
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
const summary = {
  status: result.status,
  wineDirectory: result.wineDirectory,
  dlls: result.dlls.map(({ name, bytes, sha256, imports }) => ({
    name,
    bytes,
    sha256,
    importCount: imports.length,
  })),
  firstFailure: result.firstFailure
    ? {
        phase: result.firstFailure.phase,
        error: result.firstFailure.error,
        dispatcher: result.firstFailure.dispatcher,
        instructionPointer: result.firstFailure.instructionPointer,
        blocks: result.firstFailure.blocks,
        modules: result.firstFailure.modulesAtFailure?.map((module) => ({
          name: module.name,
          initialized: module.initialized,
        })),
      }
    : null,
  processExitCode: result.processExitCode,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
process.exitCode = result.processExitCode;
