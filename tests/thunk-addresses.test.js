import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ComObjects } from '../src/com.js';

const executable = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
const ntdll = new Uint8Array(
  await readFile(new URL('./fixtures/wine-nt/ntdll.dll', import.meta.url)),
);

function runtime() {
  return new Runtime(iced, {
    files: new Map([['console.exe', executable]]),
    exe: 'console.exe',
    builtinFiles: new Map([['ntdll.dll', ntdll]]),
  });
}

function hostThunk(r, symbol) {
  return r.graph.address({ host: true, module: r.graph.modules.get('kernel32.dll'), symbol });
}

function comThunk(r) {
  const object = new ComObjects(r).create({
    name: 'ITest',
    iid: '00000000-0000-0000-c000-000000000046',
    methodNames: ['QueryInterface', 'AddRef', 'Release'],
  });
  return r.read32(object.vtable);
}

test('host thunk lookup skips COM and Wine NT entries in the shared map', async () => {
  const r = runtime();
  await r.loadLibrary('ntdll.dll');
  const wine = r.graph.modules.get('ntdll.dll').ntBridge.address;
  const com = comThunk(r);
  const host = hostThunk(r, 'GetTickCount');
  assert.equal(new Set([wine, com, host]).size, 3);
  assert.equal(r.thunks.get(wine).kind, 'wine-nt');
  assert.equal(r.thunks.get(com).kind, 'com');
  assert.deepEqual(r.thunks.get(host), { dll: 'kernel32.dll', name: 'GetTickCount' });
  assert.equal(hostThunk(r, 'GetTickCount'), host, 'host import lookup still deduplicates');
});

test('deletion and graph rollback never recycle thunk addresses', () => {
  const r = runtime();
  const com = comThunk(r);
  const removed = hostThunk(r, 'GetTickCount');
  r.thunks.delete(removed);
  const afterDelete = hostThunk(r, 'Beep');
  assert.ok(afterDelete > removed);
  assert.equal(r.thunks.has(removed), false);
  assert.equal(r.thunks.get(com).kind, 'com');

  const checkpoint = r.graph.checkpoint();
  const transient = hostThunk(r, 'Sleep');
  r.graph.restore(checkpoint);
  assert.equal(r.thunks.has(transient), false);
  const afterRollback = hostThunk(r, 'GetLastError');
  assert.ok(afterRollback > transient);
  assert.equal(r.thunks.get(afterDelete).name, 'Beep');
  assert.equal(r.thunks.get(com).kind, 'com');
});
