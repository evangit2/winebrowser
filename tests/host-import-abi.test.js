import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);

function runtime() {
  return new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
}

function pushCall(r, args, returnAddress = 0x12345678) {
  const originalStack = r.cpu.r[4].value;
  for (const arg of [...args].reverse()) r.cpu.push(arg);
  r.cpu.push(returnAddress);
  return { originalStack, returnAddress, callStack: r.cpu.r[4].value };
}

test('host cdecl import reads guest arguments and leaves caller cleanup to guest', async () => {
  const r = runtime();
  const stack = pushCall(r, [0x11223344, 0x55667788]);
  r.apiProvider.set('fixture.dll!CdeclCall', async (guest, argument) => {
    assert.equal(guest, r);
    assert.deepEqual([argument(0), argument(1)], [0x11223344, 0x55667788]);
    return { result: 0xaabbccdd, argc: 2, convention: 'cdecl' };
  });

  assert.equal(await r.api({ dll: 'fixture.dll', name: 'CdeclCall' }), stack.returnAddress);
  assert.equal(r.cpu.r[4].value, stack.callStack + 4);
  assert.equal(r.read32(r.cpu.r[4].value), 0x11223344);
  assert.equal(r.cpu.r[0].value >>> 0, 0xaabbccdd);
  r.cpu.r[4].value += 8; // Guest caller's `add esp, 8`.
  assert.equal(r.cpu.r[4].value, stack.originalStack);
});

test('host import defaults to stdcall and removes declared arguments', async () => {
  const r = runtime();
  const stack = pushCall(r, [17, 25]);
  r.apiProvider.set('fixture.dll!StdcallCall', (_guest, argument) => ({
    result: argument(0) + argument(1),
    argc: 2,
  }));

  assert.equal(await r.api({ dll: 'fixture.dll', name: 'StdcallCall' }), stack.returnAddress);
  assert.equal(r.cpu.r[4].value, stack.originalStack);
  assert.equal(r.cpu.r[0].value, 42);
});

test('unknown host import convention fails before changing the guest stack', async () => {
  const r = runtime();
  const stack = pushCall(r, [7]);
  r.apiProvider.set('fixture.dll!InvalidCall', () => ({
    result: 1,
    argc: 1,
    convention: 'fastcall',
  }));

  await assert.rejects(
    r.api({ dll: 'fixture.dll', name: 'InvalidCall' }),
    /Unsupported host import convention: fastcall/,
  );
  assert.equal(r.cpu.r[4].value, stack.callStack);
  assert.equal(r.read32(stack.callStack), stack.returnAddress);
});
