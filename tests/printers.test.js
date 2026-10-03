import test from 'node:test';
import assert from 'node:assert/strict';
import { printerApis } from '../src/win32-printers.js';
import { API_NAMES } from '../src/win32.js';
function setup() {
  const data = new DataView(new ArrayBuffer(256));
  const r = {
    lastError: 12345,
    check(p, n) {
      if (p < 16 || p + n > 256) throw Error('Guest write violation');
    },
    write32(p, v) {
      data.setUint32(p, v, true);
    },
    string() {
      return 'Remote';
    },
    wideString() {
      return 'Remote';
    },
  };
  return {
    r,
    data,
    call: (name, ...args) => printerApis[`winspool.drv!${name}`](r, (i) => args[i] ?? 0),
  };
}
test('empty local/connected printer enumeration preserves buffers and caller LastError', () => {
  const { r, data, call } = setup();
  data.setUint8(48, 0x71);
  for (const suffix of ['A', 'W'])
    for (const level of [1, 2, 4, 5]) {
      assert.deepEqual(call(`EnumPrinters${suffix}`, 6, 0, level, 48, 32, 16, 20), {
        result: 1,
        argc: 7,
      });
      assert.equal(data.getUint32(16, true), 0);
      assert.equal(data.getUint32(20, true), 0);
      assert.equal(data.getUint8(48), 0x71);
      assert.equal(r.lastError, 12345);
      assert.ok(API_NAMES['winspool.drv'].includes(`EnumPrinters${suffix}`));
    }
});
test('printer APIs reject invalid enumeration, names, handles and output storage', () => {
  const { r, data, call } = setup();
  assert.equal(call('EnumPrintersA', 6, 0, 3, 0, 0, 16, 20).result, 0);
  assert.equal(r.lastError, 124);
  assert.equal(call('EnumPrintersA', 8, 0, 4, 0, 0, 16, 20).result, 0);
  assert.equal(r.lastError, 1004);
  assert.equal(call('EnumPrintersW', 6, 48, 4, 0, 0, 16, 20).result, 0);
  assert.equal(r.lastError, 123);
  assert.equal(call('EnumPrintersA', 6, 0, 4, 0, 1, 16, 20).result, 0);
  assert.equal(r.lastError, 87);
  assert.throws(() => call('EnumPrintersW', 6, 0, 4, 48, 32, 254, 20), /violation/);
  assert.deepEqual(call('GetDefaultPrinterA', 0, 16), { result: 0, argc: 2 });
  assert.equal(r.lastError, 2);
  assert.equal(data.getUint32(16, true), 0);
  assert.deepEqual(call('OpenPrinterW', 48, 16, 0), { result: 0, argc: 3 });
  assert.equal(r.lastError, 1801);
  assert.equal(data.getUint32(16, true), 0);
  assert.deepEqual(call('ClosePrinter', 99), { result: 0, argc: 1 });
  assert.equal(r.lastError, 6);
});
