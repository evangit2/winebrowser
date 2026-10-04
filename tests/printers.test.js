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

test('printerless common dialogs validate PE32 structures and distinguish default queries from a real warning', async () => {
  const view = new DataView(new ArrayBuffer(256)),
    notices = [],
    r = {
      commonDialogError: 99,
      lastError: 123,
      check(p, n) {
        assert.ok(p >= 16 && p + n <= 256);
      },
      read32(p) {
        return view.getUint32(p, true);
      },
      write32(p, v) {
        view.setUint32(p, v, true);
      },
      allocString(s) {
        return s;
      },
      free() {},
      apiProvider: new Map([
        [
          'user32.dll!MessageBoxA',
          async (_r, a) => {
            notices.push([a(0), a(1), a(2), a(3)]);
            return { result: 1, argc: 4 };
          },
        ],
      ]),
    };
  const call = (name, ...args) => printerApis[`comdlg32.dll!${name}`](r, (i) => args[i] ?? 0);
  for (const suffix of ['A', 'W']) {
    assert.equal((await call('PrintDlg' + suffix, 0)).result, 0);
    assert.equal(r.commonDialogError, 2);
    r.write32(16, 65);
    await call('PrintDlg' + suffix, 16);
    assert.equal(r.commonDialogError, 1);
    r.write32(16, 66);
    r.write32(36, 0x400);
    await call('PrintDlg' + suffix, 16);
    assert.equal(r.commonDialogError, 0x1008);
    assert.equal(notices.length, 0);
    r.write32(24, 1);
    await call('PrintDlg' + suffix, 16);
    assert.equal(r.commonDialogError, 0x1003);
    r.write32(24, 0);
  }
  r.write32(36, 0);
  await call('PrintDlgA', 16);
  assert.equal(r.commonDialogError, 0);
  assert.match(notices[0][1], /No Windows printers/);
  assert.equal(r.lastError, 123);
  notices.length = 0;
  for (const suffix of ['A', 'W']) {
    view.setUint8(100, 0x71);
    r.write32(16, 84);
    r.write32(32, 0x80);
    await call('PageSetupDlg' + suffix, 16);
    assert.equal(r.commonDialogError, 0x1008);
    assert.equal(r.read32(32), 0x84);
    assert.equal(view.getUint8(100), 0x71);
    assert.equal(notices.length, 0);
    r.write32(32, 0x40080);
    r.write32(88, 0);
    await call('PageSetupDlg' + suffix, 16);
    assert.equal(r.commonDialogError, 0xb);
  }
  r.write32(32, 0);
  await call('PageSetupDlgW', 16);
  assert.equal(r.commonDialogError, 0x1008);
  assert.match(notices[0][1], /No default Windows printer/);
  assert.equal(r.lastError, 123);
});
