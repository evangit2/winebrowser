import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { createWin32ApiProvider, importKey } from '../src/win32.js';

const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));

// A stdio-layer unit test: fopen/fwrite/fread/fclose, fseek/ftell, and the
// three standard streams, driven through the same CRT handlers a guest calls.
// The CRT entries are cdecl, so the provider wraps each one and returns a
// promise; the helper awaits it.
function setup(t) {
  const stdout = [];
  const r = new Runtime(iced, {
    files: new Map([
      ['app/console.exe', exe],
      ['app/data.txt', new Uint8Array([104, 101, 108, 108, 111])], // "hello"
    ]),
    exe: 'app/console.exe',
    emit: (message) => {
      if (message.type === 'stdout') stdout.push(message.text);
    },
  });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  const api = async (name, ...args) =>
    await r.apiProvider.get(`msvcrt.dll!${name}`)(r, (index) => args[index] >>> 0);
  return { r, stdout, api };
}

test('fopen/fwrite/fclose write through the virtual filesystem', async (t) => {
  const { r, api } = setup(t);
  const stream = (await api('fopen', r.allocString('out.bin'), r.allocString('wb'))).result >>> 0;
  assert.notEqual(stream, 0, 'fopen returns a stream');
  const source = r.allocate(5);
  r.data.set([1, 2, 3, 4, 5], source);
  // fwrite(ptr, size, count, stream) returns the number of whole items written.
  assert.equal((await api('fwrite', source, 1, 5, stream)).result, 5);
  assert.equal((await api('fclose', stream)).result, 0);
  assert.deepEqual([...r.files.get('app/out.bin')], [1, 2, 3, 4, 5]);
});

test('fread returns the file contents and feof reports the end of the stream', async (t) => {
  const { r, api } = setup(t);
  const stream = (await api('fopen', r.allocString('data.txt'), r.allocString('rb'))).result >>> 0;
  assert.notEqual(stream, 0);
  const buffer = r.allocate(8);
  r.data.fill(0, buffer, buffer + 8);
  assert.equal((await api('fread', buffer, 1, 8, stream)).result, 5);
  assert.equal(r.data[buffer], 104); // 'h'
  assert.equal(r.data[buffer + 4], 111); // 'o'
  assert.equal((await api('feof', stream)).result, 1, 'a short read sets end-of-file');
  assert.equal((await api('fclose', stream)).result, 0);
});

test('fputs and fputc reach the guest standard output through _iob', async (t) => {
  const { r, stdout, api } = setup(t);
  // The _iob data export is the FILE array; its second element is stdout.
  const iob = (await api('_iob')).result >>> 0;
  assert.notEqual(iob, 0);
  const text = r.allocString('hi\n');
  assert.ok((await api('fputs', text, iob + 32)).result >= 0);
  assert.ok((await api('fputc', 0x41, iob + 32)).result >= 0); // 'A'
  assert.equal(stdout.join(''), 'hi\nA');
});

test('fseek and ftell move and report the stream position', async (t) => {
  const { r, api } = setup(t);
  const stream = (await api('fopen', r.allocString('data.txt'), r.allocString('rb'))).result >>> 0;
  assert.equal((await api('ftell', stream)).result, 0);
  assert.equal((await api('fseek', stream, 2, 0)).result, 0);
  assert.equal((await api('ftell', stream)).result, 2);
  assert.equal((await api('fgetc', stream)).result, 108); // 'l' at offset 2
  assert.equal((await api('fseek', stream, -1, 2)).result, 0);
  assert.equal((await api('ftell', stream)).result, 4);
  assert.equal((await api('fclose', stream)).result, 0);
});

test('the _iob data export is the stdio array and its stdout element is marked output', async (t) => {
  const { r, api } = setup(t);
  // The data export materializes real guest storage, not a code thunk address,
  // so a program that takes `_iob` and indexes it reaches the same FILE objects
  // the stdio entry points use.
  const iob = (await api('_iob')).result >>> 0;
  assert.ok(iob >= 0x2000000 && iob < 0x10000000, `_iob is guest data (0x${iob.toString(16)})`);
  assert.equal(r.read32(iob + 32 + 12) & 0x1, 1, 'the stdout FILE is marked output');
  // __p__iob and __iob_func return that same array address, which is what a
  // program indexing `FILE**` for stdout expects.
  assert.equal((await api('__p__iob')).result >>> 0, iob);
  assert.equal((await api('__iob_func')).result >>> 0, iob);
});

test('_initterm calls every initializer; only _initterm_e stops on a failure', async (t) => {
  const { r } = setup(t);
  const api = async (name, ...args) =>
    await r.apiProvider.get(`msvcrt.dll!${name}`)(r, (index) => args[index] >>> 0);
  const ran = [];
  const originalCall = r.callGuest.bind(r);
  // Both entries must land in mapped executable memory: the runtime rejects a
  // table entry it cannot decode, which is a malformed-image guard, not the
  // return-value rule under test. The fixture maps console.exe's code.
  const first = r.cpu.ranges[0][0] >>> 0;
  const second = (first + 16) >>> 0;
  r.callGuest = async (address) => {
    ran.push(address >>> 0);
    // The first initializer reports failure, the second succeeds.
    return address === first ? 1 : 0;
  };
  t.after(() => {
    r.callGuest = originalCall;
  });
  const table = r.allocate(12);
  r.write32(table, first);
  r.write32(table + 4, 0); // null entries are skipped
  r.write32(table + 8, second);

  ran.length = 0;
  assert.equal((await api('_initterm', table, table + 12)).result, 0);
  assert.deepEqual(ran, [first, second], '_initterm runs every non-null entry');

  ran.length = 0;
  assert.equal((await api('_initterm_e', table, table + 12)).result, 1);
  assert.deepEqual(ran, [first], '_initterm_e stops at the first non-zero result');
});

test('the CRT argument accessors describe the real process vector, not an unset property', async () => {
  // The runtime stores the argument list as `args`; the CRT accessors used to
  // read a never-set `arguments` property, so every MSVC program saw argc 0 and
  // an empty argv. They now share the process command-line helpers.
  const r = new Runtime(iced, {
    files: new Map([['console.exe', exe]]),
    exe: 'console.exe',
    args: ['alpha', 'beta gamma'],
  });
  const call = async (name, ...args) =>
    await r.apiProvider.get(`msvcrt.dll!${name}`)(r, (i) => args[i] ?? 0);
  const argcCell = r.allocate(4),
    argvCell = r.allocate(4);
  assert.equal((await call('__getmainargs', argcCell, argvCell, 0, 0, 0)).result, 0);
  assert.equal(r.read32(argcCell), 3, 'argv[0] plus two arguments');
  const argv = r.read32(argvCell) >>> 0;
  const strings = [];
  for (let i = 0; i < 4; i++) {
    const pointer = r.read32(argv + i * 4) >>> 0;
    if (!pointer) break;
    strings.push(r.string(pointer));
  }
  assert.deepEqual(strings, ['console.exe', 'alpha', 'beta gamma']);
  // The vector is NUL-terminated.
  assert.equal(r.read32(argv + 3 * 4), 0);
  // __argc and _acmdln agree with the same vector and the quoted command line.
  assert.equal(r.read32((await call('__argc')).result >>> 0), 3);
  const commandLineCell = (await call('__p__acmdln')).result >>> 0;
  assert.equal(r.string(r.read32(commandLineCell) >>> 0), 'console.exe alpha "beta gamma"');
  const wideArgv = r.read32((await call('__p___wargv')).result >>> 0) >>> 0;
  assert.equal(r.wideString(r.read32(wideArgv + 4) >>> 0), 'alpha');
  r.windows.dispose();
  r.cpu.dispose();
});

test('fgetpos/fsetpos and rewind move the stream position', async (t) => {
  const { r, api } = setup(t);
  const stream = (await api('fopen', r.allocString('data.txt'), r.allocString('rb'))).result >>> 0;
  const position = r.allocate(8);
  // Read three bytes, then save the position.
  const buffer = r.allocate(8);
  assert.equal((await api('fread', buffer, 1, 3, stream)).result, 3);
  assert.equal((await api('fgetpos', stream, position)).result, 0);
  assert.equal(Number(r.view.getBigInt64(position, true)), 3);
  // Move with fseek, then restore with fsetpos.
  assert.equal((await api('fseek', stream, 5, 0)).result, 0);
  assert.equal((await api('ftell', stream)).result, 5);
  assert.equal((await api('fsetpos', stream, position)).result, 0);
  assert.equal((await api('ftell', stream)).result, 3);
  assert.equal((await api('fgetc', stream)).result, 108); // 'l' at offset 3
  // rewind returns to the start and clears the end-of-file indicator.
  assert.equal((await api('rewind', stream)).result, 0);
  assert.equal((await api('ftell', stream)).result, 0);
  assert.equal((await api('feof', stream)).result, 0);
  assert.equal((await api('fclose', stream)).result, 0);
});

test('_fseeki64/_ftelli64 use the 64-bit position pair', async (t) => {
  const { r, api } = setup(t);
  const stream = (await api('fopen', r.allocString('data.txt'), r.allocString('rb'))).result >>> 0;
  // _fseeki64(stream, offsetLow, offsetHigh, origin)
  assert.equal((await api('_fseeki64', stream, 4, 0, 0)).result, 0);
  const position = await api('_ftelli64', stream);
  assert.equal(position.result, 4);
  assert.equal(position.resultHigh, 0);
  assert.equal((await api('fgetc', stream)).result, 111); // 'o' at offset 4
  assert.equal((await api('fclose', stream)).result, 0);
});

test('tmpfile creates a real, writable, temporary stream', async (t) => {
  const { r, api } = setup(t);
  const stream = (await api('tmpfile')).result >>> 0;
  assert.notEqual(stream, 0, 'tmpfile returns a stream');
  const source = r.allocate(4);
  r.data.set([9, 8, 7, 6], source);
  assert.equal((await api('fwrite', source, 1, 4, stream)).result, 4);
  assert.equal((await api('fseek', stream, 0, 0)).result, 0);
  const buffer = r.allocate(4);
  assert.equal((await api('fread', buffer, 1, 4, stream)).result, 4);
  assert.deepEqual([...r.data.slice(buffer, buffer + 4)], [9, 8, 7, 6]);
  assert.equal((await api('fclose', stream)).result, 0);
  // A temp file name is produced and each call is unique.
  const first = r.string((await api('tmpnam', 0)).result >>> 0);
  const second = r.string((await api('tmpnam', 0)).result >>> 0);
  assert.notEqual(first, second);
});

test('the wide stream forms operate on the same byte streams', async (t) => {
  const { r, api } = setup(t);
  const stream = (await api('fopen', r.allocString('data.txt'), r.allocString('rb'))).result >>> 0;
  // fgetwc maps a byte below 0x80 to the same UTF-16 unit.
  assert.equal((await api('fgetwc', stream)).result, 104); // 'h'
  const buffer = r.allocate(16);
  assert.equal((await api('fgetws', buffer, 8, stream)).result, buffer);
  assert.equal(r.wideString(buffer), 'ello');
  assert.equal((await api('fclose', stream)).result, 0);

  // fputwc/fputws write through to stdout.
  const { r: r2, stdout, api: api2 } = setup(t);
  const iob = (await api2('_iob')).result >>> 0;
  assert.ok((await api2('fputwc', 0x42, iob + 32)).result >= 0); // 'B'
  const wide = r2.allocString('hi', true);
  assert.ok((await api2('fputws', wide, iob + 32)).result >= 0);
  assert.equal(stdout.join(''), 'Bhi');
});

test('string helpers that forward a built argument list call it as an accessor', async () => {
  // `a` is an accessor function, not a table. A helper that passes
  // `{ 0: () => a(1) }` hands the callee a plain object, and the callee's first
  // `a(0)` throws before the operation runs. strcmp is the one that reached a
  // real program first, so it is pinned here alongside the other forwarders.
  const provider = createWin32ApiProvider();
  const buffer = new Uint8Array(0x10000);
  const view = new DataView(buffer.buffer);
  let next = 0x1000;
  const runtime = {
    data: buffer,
    view,
    view: view,
    guestMemory: {
      read: (address, width) => (width === 1 ? buffer[address] : view.getUint16(address, true)),
      write: (address, value, width) => {
        if (width === 1) buffer[address] = value;
        else view.setUint16(address, value, true);
      },
    },
    check: (p, n) => p,
    read32: (p) => view.getUint32(p, true),
    write32: (p, v) => view.setUint32(p, v >>> 0, true),
    allocate: (n) => {
      const p = next;
      next = (next + n + 3) & ~3;
      return p;
    },
    free: () => true,
    cpu: { r: Array.from({ length: 8 }, () => ({ value: 0 })), x87: {} },
  };
  const put = (text) => {
    const p = runtime.allocate(text.length + 1);
    for (let i = 0; i < text.length; i++) buffer[p + i] = text.charCodeAt(i);
    return p;
  };
  const call = async (name, ...args) =>
    provider.get(importKey('msvcrt.dll', name))(runtime, (i) => args[i] ?? 0);

  const apple = put('apple'),
    banana = put('banana'),
    apple2 = put('apple');
  assert.equal((await call('strcmp', apple, apple2)).result, 0);
  assert.equal((await call('strcmp', apple, banana)).result, -1);
  assert.equal((await call('strcmp', banana, apple)).result, 1);
  assert.equal((await call('strncmp', apple, banana, 1)).result, -1); // 'a' < 'b'
  // _getcwd and _fullpath reach the same helper through an argument list.
  const cwd = runtime.allocate(260);
  assert.equal((await call('_getcwd', cwd, 260)).result, cwd);
});
