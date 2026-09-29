import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

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
