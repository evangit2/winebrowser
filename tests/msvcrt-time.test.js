import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));
// 2026-09-30T12:34:56Z. The runtime models local time as UTC, so localtime and
// gmtime describe the same instant.
const EPOCH = Date.UTC(2026, 8, 30, 12, 34, 56);
const SECONDS = Math.floor(EPOCH / 1000);

function setup(t) {
  const r = new Runtime(iced, {
    files: new Map([['console.exe', exe]]),
    exe: 'console.exe',
    systemNow: () => EPOCH,
  });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const call = async (name, ...args) =>
    await r.apiProvider.get(`msvcrt.dll!${name}`)(r, (index) => args[index] ?? 0);
  const tmFields = (pointer) =>
    [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => r.read32(pointer + i * 4) | 0);
  return { r, call, tmFields };
}

test('the CRT time family reports the guest clock and its calendar fields', async (t) => {
  const { r, call, tmFields } = setup(t);
  const cell = r.allocate(4);
  assert.equal((await call('time', cell)).result, SECONDS, 'time() returns guest seconds');
  assert.equal(r.read32(cell) | 0, SECONDS, 'time() writes the same value through its pointer');

  const tm = (await call('localtime', cell)).result >>> 0;
  assert.notEqual(tm, 0);
  // struct tm on i386 MSVC: sec, min, hour, mday, mon(0-based), year(since 1900),
  // wday, yday, isdst.
  assert.deepEqual(tmFields(tm), [56, 34, 12, 30, 8, 126, 3, 272, 0]);
  assert.equal(r.string((await call('asctime', tm)).result >>> 0), 'Wed Sep 30 12:34:56 2026\n');
  assert.equal(r.string((await call('ctime', cell)).result >>> 0), 'Wed Sep 30 12:34:56 2026\n');
  // gmtime agrees with localtime because the runtime's local zone is UTC.
  const gmt = (await call('gmtime', cell)).result >>> 0;
  assert.deepEqual(tmFields(gmt).slice(0, 6), [56, 34, 12, 30, 8, 126]);
  // mktime inverts it and normalizes the fields it was handed in place.
  assert.equal((await call('mktime', gmt)).result | 0, SECONDS);
});

test('strftime formats the documented specifiers into a bounded buffer', async (t) => {
  const { r, call } = setup(t);
  const cell = r.allocate(4);
  await call('time', cell);
  const tm = (await call('localtime', cell)).result >>> 0;
  const out = r.allocate(64);
  const format = r.allocString('%Y-%m-%d %H:%M:%S|%a %b %j|%I%p|%%');
  const written = (await call('strftime', out, 64, format, tm)).result;
  assert.equal(r.string(out), '2026-09-30 12:34:56|Wed Sep 273|12PM|%');
  assert.equal(written, '2026-09-30 12:34:56|Wed Sep 273|12PM|%'.length);
  // A result that does not fit returns 0 rather than truncating the buffer.
  assert.equal((await call('strftime', out, 8, format, tm)).result, 0);
});

test('errno is one process cell that the accessors and _errno agree on', async (t) => {
  const { r, call } = setup(t);
  const cell = (await call('_errno')).result >>> 0;
  assert.notEqual(cell, 0);
  assert.equal((await call('_set_errno', 42)).result, 0);
  assert.equal(r.read32(cell) | 0, 42, '_set_errno writes the cell _errno returns');
  const out = r.allocate(4);
  assert.equal((await call('_get_errno', out)).result, 0);
  assert.equal(r.read32(out) | 0, 42);
  // The DOS errno accessors use a separate cell, as the CRT does.
  assert.notEqual((await call('__doserrno')).result >>> 0, cell);
});

test('the bounded string and memory functions report errno_t instead of overrunning', async (t) => {
  const { r, call } = setup(t);
  const source = r.allocString('hello');
  const destination = r.allocate(8);
  assert.equal((await call('strcpy_s', destination, 8, source)).result, 0);
  assert.equal(r.string(destination), 'hello');
  // 22 EINVAL for a null argument, 34 ERANGE when the result does not fit; the
  // destination is emptied so a caller cannot read a partial string.
  assert.equal((await call('strcpy_s', destination, 8, 0)).result, 22);
  assert.equal(r.string(destination), '');
  assert.equal((await call('strcpy_s', destination, 4, source)).result, 34);
  assert.equal(r.string(destination), '');

  const joined = r.allocString('ab');
  assert.equal((await call('strcat_s', joined, 16, source)).result, 0);
  assert.equal(r.string(joined), 'abhello');
  assert.equal((await call('strcat_s', joined, 4, source)).result, 34);

  const target = r.allocate(8);
  r.data.fill(0xcc, target, target + 8);
  assert.equal((await call('memcpy_s', target, 8, source, 6)).result, 0);
  assert.equal(r.string(target), 'hello');
  // memcpy_s zeroes the remainder of the destination, and a count past the
  // destination size is ERANGE rather than a write past the end.
  assert.equal(r.data[target + 6], 0);
  assert.equal((await call('memcpy_s', target, 4, source, 6)).result, 34);

  // strtok_s keeps its position in the caller's context pointer.
  const text = r.allocString('a,b,,c');
  const delimiters = r.allocString(',');
  const context = r.allocate(4);
  const first = (await call('strtok_s', text, delimiters, context)).result >>> 0;
  assert.equal(r.string(first), 'a');
  const next = r.read32(context) >>> 0;
  const second = (await call('strtok_s', next, delimiters, context)).result >>> 0;
  assert.equal(r.string(second), 'b');
  const third = (await call('strtok_s', r.read32(context) >>> 0, delimiters, context)).result >>> 0;
  assert.equal(r.string(third), 'c');
});

// The wide time-string forms write UTF-16 into the same per-process buffer their
// ANSI twins use. _wctime was previously an explicit trap, so an application
// that logged a timestamp through it stopped rather than formatting one.
test('the wide ctime/asctime forms write UTF-16 with their own time widths', async (t) => {
  const { r, call } = await setup(t);
  // 0 seconds since the epoch is 1970-01-01 00:00:00 UTC in this runtime.
  const seconds32 = r.allocate(4);
  r.write32(seconds32, 0);
  const pointer = (await call('_wctime32', seconds32)).result >>> 0;
  assert.notEqual(pointer, 0);
  assert.match(r.wideString(pointer), /^[A-Z][a-z]{2} [A-Z][a-z]{2} /);
  // _wasctime takes a tm* and reports the same shape.
  // MSVC's tm is { sec, min, hour, mday, mon, year, wday, yday, isdst }.
  const tm = r.allocate(36);
  for (const [index, value] of [
    [3, 1], // tm_mday
    [4, 0], // tm_mon: January
    [5, 70], // tm_year: 1970
  ])
    r.write32(tm + index * 4, value);
  const asctime = (await call('_wasctime', tm)).result >>> 0;
  assert.notEqual(asctime, 0);
  // The runtime formats asctime the way C does: a two-digit day, and the
  // weekday taken from tm_wday (zero for Sunday here, which the caller did not
  // set), so the shape is what matters.
  assert.match(r.wideString(asctime), /^[A-Z][a-z]{2} Jan 01 00:00:00 1970\n$/);
  // A 64-bit argument form reads a full FILETIME-width value.
  const seconds64 = r.allocate(8);
  new DataView(r.data.buffer, r.data.byteOffset).setBigInt64(seconds64, 0n, true);
  assert.notEqual((await call('_wctime64', seconds64)).result >>> 0, 0);
});
