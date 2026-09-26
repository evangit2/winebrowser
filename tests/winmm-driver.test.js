import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { driverApis } from '../src/winmm-driver.js';
import { probeDrivers } from '../scripts/lib/driver-probe.js';

const files = new Map(
  await Promise.all(
    [
      ['client.exe', 'drivers/client.exe'],
      ['plugins/codec.dll', 'drivers/codec.dll'],
      ['bad.dll', 'modules/math.dll'],
    ].map(async ([path, name]) => [
      path,
      new Uint8Array(await readFile(new URL('./fixtures/' + name, import.meta.url))),
    ]),
  ),
);
const call = (r, name, args = []) => driverApis['winmm.dll!' + name](r, (i) => args[i] ?? 0);

test('native WinMM client and driver verify instances, registry aliases, message ABI and failure cleanup', async () => {
  const report = await probeDrivers(iced, { files });
  assert.equal(report.status, 'passed', report.failure);
});

test('driver callbacks cannot recursively close their own active instance; invalid handles never call guest code', async () => {
  const r = new Runtime(iced, { files, exe: 'client.exe' });
  try {
    const pointer = r.allocString('plugins\\codec.dll', true);
    const { result: handle } = await call(r, 'OpenDriver', [pointer]);
    assert.ok(handle);
    assert.equal((await call(r, 'GetDriverFlags', [handle])).result, 0x80000000);
    const instanceModule = r.graph.findLoaded('codec.dll');
    const proc = await r.resolveExport(instanceModule, 'DriverProc');
    const original = r.callGuest.bind(r);
    let messages = 0;
    r.callGuest = async (address, args, ...rest) => {
      if (address === proc) {
        messages++;
        assert.equal((await call(r, 'CloseDriver', [handle])).result, 0);
      }
      return original(address, args, ...rest);
    };
    assert.equal(
      (await call(r, 'SendDriverMessage', [handle, 0x4000, 10, 20])).result,
      (1 << 16) | 30,
    );
    assert.equal((await call(r, 'CloseDriver', [handle, 0, 0])).result, 1);
    assert.equal(messages, 4);
    assert.equal(r.graph.findLoaded('codec.dll'), undefined);
    for (const name of [
      'GetDriverModuleHandle',
      'GetDriverFlags',
      'SendDriverMessage',
      'CloseDriver',
    ])
      assert.equal((await call(r, name, [handle])).result, 0);
    assert.equal(messages, 4);
  } finally {
    r.cpu.dispose();
  }
});

test('reentrant open during DRV_LOAD fails explicitly and releases the failed DLL reference', async () => {
  const r = new Runtime(iced, { files, exe: 'client.exe' });
  try {
    const path = r.allocString('plugins\\codec.dll', true);
    const original = r.callGuest.bind(r);
    r.callGuest = async (address, args, ...rest) => {
      if (args?.length === 5 && args[2] === 1) await call(r, 'OpenDriver', [path]);
      return original(address, args, ...rest);
    };
    await assert.rejects(
      call(r, 'OpenDriver', [path]),
      /Reentrant open during driver initialization/,
    );
    assert.equal(r.graph.findLoaded('codec.dll'), undefined);
    r.callGuest = original;
    const { result: handle } = await call(r, 'OpenDriver', [path]);
    assert.ok(handle);
    assert.equal((await call(r, 'CloseDriver', [handle])).result, 1);
  } finally {
    r.cpu.dispose();
  }
});
