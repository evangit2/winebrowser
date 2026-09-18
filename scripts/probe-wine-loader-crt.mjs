import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { parsePE } from '../src/pe.js';
import { installWineNtBridge } from '../src/wine-nt.js';
import { initializeWineProcess } from '../src/wine-process.js';
import { PROCESS_LAYOUT } from '../src/process-layout.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configuredWineDirectory = process.argv[2] || process.env.WINEBROWSER_WINE_DIR;
const configuredNlsDirectory = process.argv[3] || process.env.WINEBROWSER_NLS_DIR;
const wineDirectory = configuredWineDirectory ? path.resolve(configuredWineDirectory) : null;
const nlsDirectory = configuredNlsDirectory ? path.resolve(configuredNlsDirectory) : null;
const manifestPath = path.join(root, '.cache/wine-loader/manifest.json');
const evidencePath = path.join(root, 'evidence/wine-loader-crt-results.json');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hex = (value) => `0x${(value >>> 0).toString(16)}`;

// Same installed-DLL pin set as probe-wine-crt.mjs; the fourth DLL is the
// source-built ntdll from the hash-checked build manifest.
const installedHashes = {
  'msvcrt.dll': '612edff0b1d2493a6c491aa3be10f1b42a961f8516db8cffe3d59dbe4c192558',
  'kernel32.dll': 'c4b1f1f1210e85acc9f82a898664b1c79b6e83e0485cb59e2e6251885cde9418',
  'kernelbase.dll': '4fae98d80c69cf36fbfc669acbe87676f0ad06dcebb85cff7b4abee13912a6f6',
};
const report = {
  date: new Date().toISOString(),
  status: 'blocked-integrity',
  scope:
    'Optional diagnostic of a source-built Wine loader bridge with pinned installed CRT DLLs. No EXE entry point runs. After-attach loader metadata synchronization is not implemented; no general application support is claimed.',
  operation:
    'map full msvcrt closure; process bootstrap; source loader registration; kernelbase dynamic TLS; normal DLL attach',
  inputs: {
    manifest: path.relative(root, manifestPath),
    wineDirectory,
    nlsDirectory,
    dlls: [],
    nls: [],
  },
  phases: [],
  nlsRequests: [],
  recentNtCalls: [],
  firstFailure: null,
};

let runtime;
let phase = 'input integrity';
let lastIP = null;
const recentIPs = [];
const recentServices = [];
const registerNames = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
const safeRead32 = (address) => {
  try {
    return runtime.read32(address) >>> 0;
  } catch {
    return null;
  }
};
const moduleAt = (address) => {
  if (address === null) return null;
  const module = [...runtime.graph.modules.values()].find(
    (candidate) =>
      !candidate.host &&
      address >= candidate.base &&
      address < candidate.base + candidate.pe.imageSize,
  );
  return module ? { name: module.name, offset: hex(address - module.base) } : null;
};
const sectionAt = (address) => {
  if (address === null) return null;
  const module = [...runtime.graph.modules.values()].find(
    (candidate) =>
      !candidate.host &&
      address >= candidate.base &&
      address < candidate.base + candidate.pe.imageSize,
  );
  if (!module) return null;
  const rva = address - module.base;
  const section = module.pe.sections.find(
    (candidate) =>
      rva >= candidate.rva &&
      rva < candidate.rva + Math.max(candidate.rawSize, candidate.virtualSize),
  );
  return section
    ? { name: section.name, rva: hex(rva), characteristics: hex(section.characteristics) }
    : null;
};
const guestState = () => {
  const stack = runtime.cpu.r[4].value >>> 0;
  return {
    phase,
    instructionPointer: lastIP === null ? null : hex(lastIP),
    recentInstructionPointers: recentIPs.map(hex),
    registers: Object.fromEntries(
      runtime.cpu.r.map((register, index) => [registerNames[index], hex(register.value)]),
    ),
    stackWords: Array.from({ length: 12 }, (_, index) => safeRead32(stack + index * 4)),
    pebTlsBitmap: safeRead32(PROCESS_LAYOUT.peb + 0x40),
    pebTlsExpansionBitmap: safeRead32(PROCESS_LAYOUT.peb + 0x150),
    modules: runtime.graph.describe(),
    apiTrace: [...runtime.apiTrace],
    recentServices: [...recentServices],
    blocks: runtime.blocks,
  };
};
const recordFailure = (error, detail = {}) => {
  report.firstFailure ??= {
    phase,
    error: { name: error.name, message: error.message },
    ...(runtime ? guestState() : {}),
    ...detail,
  };
};

try {
  if (!wineDirectory || !nlsDirectory)
    throw Error(
      'Pass the pinned i386 Wine DLL directory and NLS directory as arguments or WINEBROWSER_WINE_DIR/WINEBROWSER_NLS_DIR.',
    );
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.sourceRevision, 'db11d0fe6a169c457e23d007e20404643d067aa8');
  assert.equal(
    manifest.sourceSha256,
    '18aaee150ad540885b9706ae73ccf6febca904049de2792199a9dc18a2772e6a',
  );
  assert.equal(
    manifest.patchSha256,
    sha256(await readFile(path.join(root, 'runtime/wine/browser-loader.patch'))),
  );
  assert.equal(manifest.artifactPathBase, 'manifest-directory');
  const patchedPath = path.resolve(path.dirname(manifestPath), manifest.artifact.path);
  const patched = new Uint8Array(await readFile(patchedPath));
  assert.equal(patched.length, manifest.artifact.bytes);
  assert.equal(sha256(patched), manifest.artifact.sha256);
  assert.equal(parsePE(patched, { allowDll: true }).isDll, true);
  report.inputs.sourceRevision = manifest.sourceRevision;
  report.inputs.sourceSha256 = manifest.sourceSha256;
  report.inputs.patchSha256 = manifest.patchSha256;
  report.inputs.dlls.push({
    name: 'ntdll.dll',
    path: patchedPath,
    bytes: patched.length,
    sha256: sha256(patched),
  });

  const builtins = new Map([['ntdll.dll', patched]]);
  for (const [name, expected] of Object.entries(installedHashes)) {
    const filename = path.join(wineDirectory, name);
    const bytes = new Uint8Array(await readFile(filename));
    assert.equal(sha256(bytes), expected, `${name} differs from the pinned installed DLL`);
    assert.equal(parsePE(bytes, { allowDll: true }).isDll, true);
    builtins.set(name, bytes);
    report.inputs.dlls.push({ name, path: filename, bytes: bytes.length, sha256: expected });
  }

  const nlsManifest = JSON.parse(
    await readFile(path.join(root, 'runtime/wine/nls-probe-manifest.json'), 'utf8'),
  );
  assert.equal(nlsManifest.wineCommit, manifest.sourceRevision);
  const nlsFiles = new Map();
  for (const [name, expected] of Object.entries(nlsManifest.files)) {
    const direct = path.join(nlsDirectory, name);
    let filename = direct;
    let bytes;
    try {
      bytes = new Uint8Array(await readFile(filename));
    } catch (error) {
      if (name !== 'sortdefault.nls' || error.code !== 'ENOENT') throw error;
      filename = path.resolve(nlsDirectory, '../globalization/sorting/sortdefault.nls');
      bytes = new Uint8Array(await readFile(filename));
    }
    assert.equal(bytes.length, expected.bytes, `${name} length differs from the pinned NLS file`);
    assert.equal(sha256(bytes), expected.sha256, `${name} differs from the pinned NLS file`);
    nlsFiles.set(name, bytes);
    report.inputs.nls.push({ name, path: filename, bytes: bytes.length, sha256: expected.sha256 });
  }
  const executableName = 'console.exe';
  const executable = new Uint8Array(
    await readFile(path.join(root, 'public/demos/console/console.exe')),
  );
  report.inputs.executable = {
    name: executableName,
    sha256: sha256(executable),
    bytes: executable.length,
  };
  report.phases.push({ name: phase, passed: true });

  runtime = new Runtime(iced, {
    files: new Map([[executableName, executable]]),
    exe: executableName,
    builtinFiles: builtins,
    nlsFiles,
  });
  const step = runtime.cpu.step.bind(runtime.cpu);
  runtime.cpu.step = (ip) => {
    lastIP = ip >>> 0;
    recentIPs.push(lastIP);
    if (recentIPs.length > 16) recentIPs.shift();
    try {
      return step(ip);
    } catch (error) {
      recordFailure(error);
      throw error;
    }
  };
  const api = runtime.api.bind(runtime);
  runtime.api = async (entry) => {
    const serviceId = runtime.cpu.r[0].value >>> 0;
    const service = entry.services?.get(serviceId);
    const stack = runtime.cpu.r[4].value >>> 0;
    const argumentsAtCall = service
      ? Array.from({ length: service.argc }, (_, index) => safeRead32(stack + 8 + index * 4))
      : [];
    const base = service?.name === 'NtProtectVirtualMemory' ? safeRead32(argumentsAtCall[1]) : null;
    const protection =
      service?.name === 'NtProtectVirtualMemory'
        ? {
            basePointer: hex(argumentsAtCall[1]),
            base: base === null ? null : hex(base),
            sizePointer: hex(argumentsAtCall[2]),
            size: safeRead32(argumentsAtCall[2]),
            newProtection: hex(argumentsAtCall[3]),
            oldProtectionPointer: hex(argumentsAtCall[4]),
            mappedModule: moduleAt(base),
            mappedSection: sectionAt(base),
            regions:
              base === null
                ? []
                : runtime.regions
                    .filter((region) => base >= region.start && base < region.end)
                    .map((region) => ({
                      start: hex(region.start),
                      end: hex(region.end),
                      kind: region.kind ?? null,
                      module: region.module ?? null,
                      read: region.read !== false,
                      write: !!region.write,
                      exec: !!region.exec,
                    })),
          }
        : null;
    try {
      const returnAddress = await api(entry);
      if (service) {
        const record = {
          name: service.name,
          arguments: argumentsAtCall,
          result: hex(runtime.cpu.r[0].value),
          ...(protection ? { protection } : {}),
        };
        recentServices.push(record);
        if (recentServices.length > 32) recentServices.shift();
        if (service.name === 'NtGetNlsSectionPtr' || service.name === 'NtInitializeNlsFiles')
          report.nlsRequests.push(record);
      }
      return returnAddress;
    } catch (error) {
      recordFailure(error, {
        dispatcher: {
          dll: entry.dll,
          name: entry.name,
          serviceId: service ? hex(serviceId) : null,
          serviceName: service?.name ?? null,
          arguments: argumentsAtCall,
          returnAddresses: [safeRead32(stack), safeRead32(stack + 4)].map((address) => ({
            address: address === null ? null : hex(address),
            module: moduleAt(address),
          })),
          ...(protection ? { protection } : {}),
        },
      });
      throw error;
    }
  };

  phase = 'map full guest closure';
  runtime.graph.load('msvcrt.dll', true);
  runtime.graph.map(runtime.memory, runtime.regions);
  runtime.refreshCodeRanges();
  const modules = [...runtime.graph.modules.values()].filter((module) => !module.host);
  assert.deepEqual(
    modules.map((module) => module.name).sort(),
    ['console.exe', 'kernel32.dll', 'kernelbase.dll', 'msvcrt.dll', 'ntdll.dll'].sort(),
  );
  for (const module of modules) assert.equal(module.mapped, true, `${module.name} is not mapped`);
  const ntdll = runtime.graph.modules.get('ntdll.dll');
  installWineNtBridge(runtime, ntdll);
  report.phases.push({ name: phase, modules: runtime.graph.describe(), passed: true });

  phase = 'Wine process heap, parameters and NLS bootstrap';
  await initializeWineProcess(runtime, ntdll);
  assert.ok(runtime.wineProcess?.heap);
  report.phases.push({ name: phase, heap: hex(runtime.wineProcess.heap), passed: true });

  phase = 'source loader registration before DLL attach';
  const exportEntry = ntdll.pe.exports.find((entry) => entry.name === 'WineBrowserLoaderBootstrap');
  assert.ok(
    exportEntry && !exportEntry.forwarder,
    'patched ntdll has no direct browser bootstrap export',
  );
  const bootstrap = ntdll.base + exportEntry.rva;
  const table = runtime.allocate(modules.length * 16);
  for (const [index, module] of modules.entries()) {
    const address = table + index * 16;
    const flags = module === runtime.graph.main ? 1 : module === ntdll ? 2 : 0;
    assert.equal(module.initialized, false, `${module.name} was attached before registration`);
    runtime.write32(address, 16);
    runtime.write32(address + 4, module.base);
    runtime.write32(
      address + 8,
      runtime.allocString(`\\??\\C:\\winebrowser\\${module.name}`, true),
    );
    runtime.write32(address + 12, flags);
  }
  const batch = runtime.allocate(16);
  [16, 1, modules.length, table].forEach((value, index) =>
    runtime.write32(batch + index * 4, value),
  );
  const bootstrapStatus = await runtime.callGuest(bootstrap, [batch]);
  assert.equal(bootstrapStatus, 0, `source loader bootstrap returned ${hex(bootstrapStatus)}`);
  report.phases.push({
    name: phase,
    moduleCount: modules.length,
    status: hex(bootstrapStatus),
    passed: true,
  });

  phase = 'kernelbase dynamic TLS before DLL attach';
  const kernelbase = runtime.graph.modules.get('kernelbase.dll');
  const tlsExport = (name) => {
    const entry = kernelbase.pe.exports.find((candidate) => candidate.name === name);
    assert.ok(entry && !entry.forwarder, `kernelbase has no direct ${name} export`);
    return kernelbase.base + entry.rva;
  };
  const tlsAlloc = tlsExport('TlsAlloc');
  const tlsSetValue = tlsExport('TlsSetValue');
  const tlsGetValue = tlsExport('TlsGetValue');
  const tlsFree = tlsExport('TlsFree');
  const slots = [];
  for (let i = 0; i < 65; i++) {
    const index = await runtime.callGuest(tlsAlloc);
    assert.notEqual(index, 0xffffffff, `TlsAlloc failed at allocation ${i}`);
    assert.ok(index < 1088, `TlsAlloc returned out-of-range slot ${index}`);
    assert.ok(!slots.includes(index), `TlsAlloc reused live slot ${index}`);
    slots.push(index);
    const value = 0x10000 + i;
    assert.equal(await runtime.callGuest(tlsSetValue, [index, value]), 1);
    assert.equal(await runtime.callGuest(tlsGetValue, [index]), value);
  }
  assert.ok(
    slots.some((index) => index < 64),
    'No inline TLS slot was allocated',
  );
  assert.ok(
    slots.some((index) => index >= 64),
    'No expansion TLS slot was allocated',
  );
  for (const index of slots) assert.equal(await runtime.callGuest(tlsFree, [index]), 1);
  const reused = await runtime.callGuest(tlsAlloc);
  assert.ok(slots.includes(reused), `TlsAlloc did not reuse a freed slot: ${reused}`);
  assert.equal(await runtime.callGuest(tlsGetValue, [reused]), 0);
  assert.equal(await runtime.callGuest(tlsFree, [reused]), 1);
  report.phases.push({
    name: phase,
    allocations: slots.length,
    inlineSlots: slots.filter((index) => index < 64).length,
    expansionSlots: slots.filter((index) => index >= 64).length,
    reused,
    passed: true,
  });

  phase = 'normal DLL initialization after source registration';
  const msvcrt = runtime.graph.modules.get('msvcrt.dll');
  const callGuest = runtime.callGuest.bind(runtime);
  runtime.callGuest = async (address, args, convention) => {
    const result = await callGuest(address, args, convention);
    if (address === msvcrt.pe.entryPoint)
      report.msvcrtAttach = {
        result: hex(result),
        recentInstructionPointers: recentIPs.map(hex),
        recentServices: [...recentServices],
      };
    return result;
  };
  await runtime.initializeModules();
  report.phases.push({ name: phase, modules: runtime.graph.describe(), passed: true });
  report.status = 'attached-diagnostic-only';
} catch (error) {
  recordFailure(error);
  report.status = phase === 'input integrity' ? 'blocked-integrity' : 'blocked-guest';
}
report.runtime = runtime
  ? {
      modulesAfterFailure: runtime.graph.describe(),
      apiTrace: [...runtime.apiTrace],
      blocks: runtime.blocks,
    }
  : null;
report.recentNtCalls = recentServices.slice(-16);
report.processExitCode = report.status === 'attached-diagnostic-only' ? 0 : 1;
await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ status: report.status, phases: report.phases.map(({ name, passed }) => ({ name, passed })), firstFailure: report.firstFailure, processExitCode: report.processExitCode }, null, 2)}\n`,
);
process.exitCode = report.processExitCode;
