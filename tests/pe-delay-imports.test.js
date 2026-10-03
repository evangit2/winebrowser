import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { parsePE, mapPE } from '../src/pe.js';
import { Runtime } from '../src/runtime.js';

const executable = new Uint8Array(await readFile('tests/fixtures/delay-imports/delay-imports.exe'));
const dll = new Uint8Array(await readFile('tests/fixtures/delay-imports/delayed.dll'));
const original = parsePE(executable);
const fileOffset = (rva) => {
  if (rva < original.headersSize) return rva;
  const section = original.sections.find((s) => rva >= s.rva && rva < s.rva + s.rawSize);
  assert.ok(section);
  return section.rawOffset + rva - section.rva;
};
const write = (bytes, rva, value) =>
  new DataView(bytes.buffer).setUint32(fileOffset(rva), value, true);
const directory = new DataView(executable.buffer).getUint32(0x3c, true) + 24 + 96 + 13 * 8;

test('delay metadata preserves named/ordinal lazy thunks and absent optional DLLs', () => {
  assert.deepEqual(
    original.delayImports.map(({ dll, name, ordinal }) => ({
      dll,
      ...(name ? { name } : { ordinal }),
    })),
    [
      { dll: 'msvcrt.dll', name: '_stricmp' },
      { dll: 'delayed.dll', name: 'DelayedAdd' },
      { dll: 'delayed.dll', ordinal: 7 },
      { dll: 'absent-optional.dll', name: 'NeverUsed' },
    ],
  );
  assert.equal(original.delayDescriptors.length, 3);
  assert.equal(
    original.imports.some((i) => i.dll === 'delayed.dll' || i.dll === 'absent-optional.dll'),
    false,
  );
  const memory = new WebAssembly.Memory({ initial: 1024 });
  const mapped = mapPE(original, executable, memory, 0x600000);
  const view = new DataView(memory.buffer);
  assert.deepEqual(mapped.delayImports, original.delayImports);
  for (const imported of original.delayImports) {
    const old = new DataView(executable.buffer).getUint32(fileOffset(imported.iatRva), true);
    assert.equal(
      view.getUint32(mapped.imageBase + imported.iatRva, true),
      old + 0x200000,
      'rebase original guest helper address; no host replacement thunk',
    );
  }
  for (const descriptor of mapped.delayDescriptors)
    assert.equal(view.getUint32(mapped.imageBase + descriptor.moduleHandleRva, true), 0);
});

test('legacy VA descriptors convert lookup/name/table pointers without changing lazy IATs', () => {
  const bytes = executable.slice(),
    view = new DataView(bytes.buffer);
  for (const descriptor of original.delayDescriptors) {
    write(bytes, descriptor.descriptorRva, 0);
    for (const field of [1, 2, 3, 4]) {
      const rva = descriptor.descriptorRva + field * 4;
      write(bytes, rva, view.getUint32(fileOffset(rva), true) + original.imageBase);
    }
    for (let i = 0; i < descriptor.count; i++) {
      const rva = descriptor.intRva + i * 4,
        value = view.getUint32(fileOffset(rva), true);
      if (!(value & 0x80000000)) write(bytes, rva, value + original.imageBase);
    }
  }
  const parsed = parsePE(bytes);
  assert.deepEqual(parsed.delayImports, original.delayImports);
  assert.ok(parsed.delayDescriptors.every((d) => d.attributes === 0));
});

test('delay descriptors reject invalid attributes, truncated tables and unchecked pointers', () => {
  const descriptor = original.delayDescriptors[0];
  const cases = [
    (bytes) => new DataView(bytes.buffer).setUint32(directory, 0, true),
    (bytes) => new DataView(bytes.buffer).setUint32(directory + 4, 16, true),
    (bytes) => new DataView(bytes.buffer).setUint32(directory + 4, 32, true),
    (bytes) => write(bytes, descriptor.descriptorRva, 2),
    (bytes) => write(bytes, descriptor.descriptorRva + 4, original.imageSize + 1),
    (bytes) => write(bytes, descriptor.descriptorRva + 8, original.imageSize - 2),
    (bytes) => write(bytes, descriptor.descriptorRva + 12, original.imageSize - 2),
    (bytes) => write(bytes, descriptor.descriptorRva + 16, original.imageSize - 2),
    (bytes) => write(bytes, descriptor.intRva, original.imageSize + 1),
    (bytes) => write(bytes, descriptor.descriptorRva + 20, original.imageSize - 2),
    (bytes) => write(bytes, descriptor.descriptorRva + 24, original.imageSize - 2),
    (bytes) => {
      write(bytes, descriptor.descriptorRva, 0);
      write(bytes, descriptor.descriptorRva + 4, 1);
    },
  ];
  for (const change of cases) {
    const bytes = executable.slice();
    change(bytes);
    assert.throws(() => parsePE(bytes), /delay|import hint/);
  }
  const included = executable.slice();
  new DataView(included.buffer).setUint32(directory + 4, 128, true);
  assert.deepEqual(
    parsePE(included).delayImports,
    original.delayImports,
    'directory may include null terminator',
  );
});

test('native MinGW delay helper loads on first call, preserves hooks and recovers missing DLL/procedure', async () => {
  const r = new Runtime(iced, {
    exe: 'delay-imports.exe',
    files: new Map([
      ['delay-imports.exe', executable],
      ['delayed.dll', dll],
    ]),
  });
  try {
    assert.equal(r.graph.findLoaded('delayed.dll'), undefined);
    assert.equal(r.graph.unresolved.length, 0);
    const result = await r.run();
    assert.equal(result.exitCode, 0);
    assert.ok(result.totalCompiledBlocks > 0);
    assert.equal(
      result.modules.some((m) => m.name === 'delayed.dll'),
      false,
      'explicit final FreeLibrary unloads guest DLL',
    );
    assert.equal(
      result.modules.some((m) => m.name === 'absent-optional.dll'),
      false,
    );
  } finally {
    r.windows.dispose();
    r.cpu.dispose();
  }
});
