import test from 'node:test';
import assert from 'node:assert/strict';
import { installWineUnixClock } from '../src/wine-unix-clock.js';
import { systemFileTime } from '../src/shared-user-data.js';

test('Wine precise-clock dispatcher writes the shared 64-bit time and rejects other Unix services', () => {
  const data = new Uint8Array(4096),
    view = new DataView(data.buffer);
  let now = 1700000000000;
  const r = {
    data,
    thunks: new Map(),
    systemNow: () => now,
    check(p, n) {
      if (!p || p + n > data.length) throw Error('memory');
    },
    read32: (p) => view.getUint32(p, true),
    write32: (p, n) => view.setUint32(p, n, true),
  };
  const module = {
    name: 'ntdll.dll',
    base: 128,
    pe: {
      exports: [
        { name: '__wine_unix_call_dispatcher', rva: 64 },
        { name: '__wine_unixlib_handle', rva: 80 },
      ],
    },
  };
  installWineUnixClock(r, module);
  const address = r.read32(192),
    thunk = r.thunks.get(address);
  assert.equal(thunk.kind, 'wine-unix');
  const args = [r.read32(208), r.read32(212), 7, 512];
  const call = () => thunk.invoke(r, (i) => args[i]);
  const read = () => BigInt(r.read32(512)) | (BigInt(r.read32(516)) << 32n);
  assert.deepEqual(call(), { result: 0, argc: 4 });
  assert.equal(read(), systemFileTime(now));
  now += 123;
  call();
  assert.equal(read(), systemFileTime(now));
  installWineUnixClock(r, module);
  assert.equal(r.thunks.size, 1, 'installation is idempotent');
  const logs = [];
  r.emit = (e) => logs.push(e);
  data.set(new TextEncoder().encode('native debug\n'), 1024);
  r.write32(512, 1024);
  r.write32(516, 13);
  args[2] = 2;
  assert.deepEqual(call(), { result: 13, argc: 4 });
  assert.deepEqual(logs, [{ type: 'log', text: 'native debug\n' }]);
  r.write32(516, 1024 * 1024 + 1);
  assert.throws(call, /exceeds limit/);
  r.write32(516, 4096);
  assert.throws(call, /memory/);
  assert.equal(logs.length, 1, 'invalid diagnostic buffers produce no log');
  args[2] = 8;
  assert.throws(call, /Unsupported Wine Unix service/);
  args[2] = 7;
  args[0] = 0;
  assert.throws(call, /Unsupported Wine Unix service/);
  const conflicting = { ...module, unixClock: undefined };
  assert.throws(() => installWineUnixClock(r, conflicting), /already initialized/);
});

import { debugNtServices } from '../src/wine-debug.js';

test('Wine debugger exceptions emit bounded ANSI and Unicode messages and leave other exceptions explicit', () => {
  const data = new Uint8Array(4096),
    view = new DataView(data.buffer),
    events = [];
  const r = {
    data,
    cpu: {
      r: Array.from({ length: 8 }, () => ({ value: 0 })),
      host: { flagByte() {} },
      f: {},
      df: 0,
    },
    check(p, n) {
      if (!p || p + n > data.length) throw Error('memory');
    },
    read32: (p) => view.getUint32(p, true),
    emit: (event) => events.push(event),
  };
  const word = (p, n) => view.setUint32(p, n, true),
    args = [128, 256, 1];
  const call = () => debugNtServices.NtRaiseException.call(r, (i) => args[i]);
  word(256 + 0xb8, 1536);
  word(256 + 0xc4, 1792);
  word(256 + 0xc0, 0x202);
  word(128, 0x40010006);
  word(144, 2);
  word(148, 4);
  word(152, 1024);
  data.set([65, 0x80, 66, 0], 1024);
  assert.deepEqual(call(), { result: 0, jumpTo: 1536 });
  assert.equal(r.cpu.r[4].value, 1792, 'handled notifications restore the saved stack');
  assert.equal(events[0].text, 'A€B');
  word(128, 0x4001000a);
  word(144, 4);
  word(148, 3);
  data.set([0x41, 0, 0xa9, 3, 0, 0], 1024);
  assert.deepEqual(call(), { result: 0, jumpTo: 1536 });
  assert.equal(events[1].text, 'AΩ');
  word(148, 32769);
  assert.equal(call(), 0xc000000d);
  word(148, 3);
  data[1028] = 1;
  assert.equal(call(), 0xc000000d);
  word(128, 0xc0000005);
  assert.throws(call, /Unsupported Wine NT exception/);
  assert.equal(events.length, 2, 'rejected requests emit no text');
});
