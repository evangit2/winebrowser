import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ComObjects } from '../src/com.js';
import { comApis } from '../src/win32-com.js';
import { registerThunk } from '../src/thunk-addresses.js';
const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
const oracle = JSON.parse(await readFile('tests/fixtures/com-errors/wine-oracle.json', 'utf8'));
async function setup(t) {
  const r = new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
  t.after(async () => {
    await r.threads.stopOthers();
    r.syncObjects?.dispose();
    r.windows.dispose();
    r.cpu.dispose();
  });
  await r.initializeModules();
  r.comObjects = new ComObjects(r);
  const create = (name) =>
    r.comObjects.create({
      name,
      iid: '1cf2b120-547d-101b-8e65-08002b2bd119',
      methodNames: ['QueryInterface', 'AddRef', 'Release'],
    });
  const first = create('FirstError'),
    second = create('SecondError'),
    out = r.allocate(4);
  const call = async (name, reserved = 0, pointer = out) =>
    (await comApis['oleaut32.dll!' + name](r, (i) => [reserved, pointer][i])).result;
  return { r, first, second, out, call };
}
test('real error-info references match native retrieval, replacement, reserved arguments and thread-exit cleanup', async (t) => {
  const { r, first, second, out, call } = await setup(t);
  const rows = [];
  const row = (step, hr, pointer = 0) =>
    rows.push({
      step,
      hr,
      value: pointer === first.pointer ? 1 : pointer === second.pointer ? 2 : pointer === 0 ? 0 : 9,
      refs: [first.refs, second.refs],
      error: r.lastError,
    });
  r.lastError = 777;
  r.write32(out, 0x12345678);
  row('empty', await call('GetErrorInfo'), r.read32(out));
  row('set-first', await call('SetErrorInfo', 0, first.pointer));
  r.write32(out, 0x12345678);
  row('get-reserved', await call('GetErrorInfo', 1), r.read32(out));
  row('set-reserved', await call('SetErrorInfo', 1, second.pointer));
  row('get-null', await call('GetErrorInfo', 0, 0));
  row('take', await call('GetErrorInfo'), r.read32(out));
  await r.comObjects.release(first);
  row('caller-release', 0);
  row('set-again', await call('SetErrorInfo', 0, first.pointer));
  row('replace', await call('SetErrorInfo', 0, second.pointer));
  const worker = registerThunk(r.thunks, {
    kind: 'com',
    name: 'ErrorInfoWorker',
    invoke: async () => {
      r.lastError = 777;
      r.write32(out, 0x12345678);
      row('thread-empty', await call('GetErrorInfo'), r.read32(out));
      row('thread-set', await call('SetErrorInfo', 0, first.pointer));
      return { result: 0, argc: 1 };
    },
  });
  const created = r.threads.create({ start: worker });
  assert.equal(created.status, 0);
  const join = registerThunk(r.thunks, {
    kind: 'com',
    name: 'ErrorInfoJoin',
    invoke: async () => {
      await r.threads.block(created.thread.completion);
      return { result: 0, argc: 0 };
    },
  });
  await r.callGuest(join);
  row('after-thread', 0);
  row('main-take', await call('GetErrorInfo'), r.read32(out));
  await r.comObjects.release(second);
  row('set-before-clear', await call('SetErrorInfo', 0, first.pointer));
  row('clear', await call('SetErrorInfo', 0, 0));
  r.write32(out, 0x12345678);
  row('empty-after-clear', await call('GetErrorInfo'), r.read32(out));
  assert.deepEqual(rows, oracle);
  assert.equal(created.thread.errorInfo, 0);
});
test('OLE Automation ordinals and DLL aliases share one thread slot, released before process DLL teardown', async (t) => {
  const { r, first, out } = await setup(t);
  const base = await r.loadLibrary('oleaut32.dll');
  const module = [...r.graph.modules.values()].find((m) => m.base === base);
  assert.equal(await r.resolveExport(module, 200), await r.resolveExport(module, 'GetErrorInfo'));
  assert.equal(await r.resolveExport(module, 201), await r.resolveExport(module, 'SetErrorInfo'));
  assert.equal(
    (await comApis['ole32.dll!SetErrorInfo'](r, (i) => [0, first.pointer][i])).result,
    0,
  );
  assert.equal(comApis['combase.dll!GetErrorInfo'](r, (i) => [0, out][i]).result, 0);
  assert.equal(r.read32(out), first.pointer);
  assert.equal(first.refs, 2);
  await r.comObjects.release(first);
  await comApis['oleaut32.dll!SetErrorInfo'](r, (i) => [0, first.pointer][i]);
  r.exitCode = 0;
  await r.shutdownProcess();
  assert.equal(first.refs, 1);
  assert.equal(r.threads.current.errorInfo, 0);
});
test('ProgIDFromCLSID reads actual class registrations and returns a task-owned UTF-16 string', async (t) => {
  const { r, out } = await setup(t);
  const guid = r.allocate(16);
  r.data.fill(0, guid, guid + 16);
  r.write32(guid, 0x12345678);
  const call = (name, ...args) => r.apiProvider.get(name)(r, (i) => args[i] >>> 0);
  const get = (pointer) => call('ole32.dll!ProgIDFromCLSID', guid, pointer);
  assert.equal(get(0).result, 0x80070057);
  r.write32(out, 0x1234);
  assert.equal(get(out).result, 0x80040154);
  assert.equal(r.read32(out), 0);
  const keyText = 'CLSID\\{12345678-0000-0000-0000-000000000000}\\ProgID';
  for (const [root, prefix] of [
    [0x80000001, 'Software\\Classes\\'],
    [0x80000000, ''],
  ]) {
    assert.equal(
      call(
        'advapi32.dll!RegCreateKeyExW',
        root,
        r.allocString(prefix + keyText, true),
        0,
        0,
        0,
        2,
        0,
        out,
        0,
      ).result,
      0,
    );
    const key = r.read32(out),
      text = 'WineBrowser.Café.1',
      value = r.allocString(text, true);
    assert.equal(
      call('advapi32.dll!RegSetValueExW', key, 0, 0, 1, value, (text.length + 1) * 2).result,
      0,
    );
    call('advapi32.dll!RegCloseKey', key);
    assert.equal(get(out).result, 0);
    const pointer = r.read32(out);
    assert.equal(r.wideString(pointer), text);
    assert.ok(r.heap.allocations.has(pointer));
    call('ole32.dll!CoTaskMemFree', pointer);
    assert.equal(r.heap.allocations.has(pointer), false);
  }
});
