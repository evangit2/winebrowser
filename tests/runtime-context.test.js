import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { parsePE } from '../src/pe.js';
import { Runtime } from '../src/runtime.js';

async function callbackRuntime(fail) {
  const bytes = new Uint8Array(await readFile('public/demos/console/console.exe'));
  const pe = parsePE(bytes);
  const section = pe.sections.find(
    (s) => pe.entryPointRva >= s.rva && pe.entryPointRva < s.rva + s.rawSize,
  );
  // mov eax,12345678h; movd xmm3,eax; movd eax,xmm3.
  // A separate block faults after changing XMM3, exercising exceptional cleanup.
  bytes.set(
    [
      0xb8,
      0x78,
      0x56,
      0x34,
      0x12,
      0x66,
      0x0f,
      0x6e,
      0xd8,
      0x66,
      0x0f,
      0x7e,
      0xd8,
      ...(fail ? [0xeb, 0, 0x0f, 0x0b] : [0xc3]),
    ],
    section.rawOffset + pe.entryPointRva - section.rva,
  );
  return new Runtime(iced, { files: new Map([['callback.exe', bytes]]), exe: 'callback.exe' });
}

for (const fail of [false, true]) {
  test(`guest callbacks restore full CPU context after ${fail ? 'a fault' : 'returning'}`, async () => {
    const runtime = await callbackRuntime(fail);
    runtime.cpu.simd.registers.forEach((r, n) => r.set([n + 1, n + 2, n + 3, n + 4]));
    const vectors = runtime.cpu.simd.snapshot();
    const registers = runtime.cpu.r.map((r) => r.value);
    const flags = { ...runtime.cpu.f };
    if (fail)
      await assert.rejects(runtime.callGuest(runtime.pe.entryPoint), /Unsupported instruction ud2/);
    else assert.equal(await runtime.callGuest(runtime.pe.entryPoint), 0x12345678);
    assert.deepEqual(runtime.cpu.simd.snapshot(), vectors);
    assert.deepEqual(
      runtime.cpu.r.map((r) => r.value),
      registers,
    );
    assert.deepEqual(runtime.cpu.f, flags);
    assert.equal(runtime.callDepth, 0);
  });
}
