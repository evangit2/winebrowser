import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';

const exe = new Uint8Array(await readFile('public/demos/console/console.exe'));

async function setup(t, files = {}) {
  const r = new Runtime(iced, {
    files: new Map([['console.exe', exe], ...Object.entries(files)]),
    exe: 'console.exe',
  });
  t.after(() => {
    r.windows.dispose();
    r.cpu.dispose();
  });
  await r.cpu.initialize();
  const call = (name, ...args) =>
    r.apiProvider.get(`msvcrt.dll!${name}`)(r, (index) => args[index] ?? 0);
  return { r, call };
}

test('the character classifiers answer from the exported ctype table', async (t) => {
  const { r, call } = await setup(t);
  for (const [name, yes, no] of [
    ['isalpha', 0x41, 0x31],
    ['isdigit', 0x37, 0x41],
    ['isspace', 0x20, 0x78],
    ['isupper', 0x5a, 0x7a],
    ['islower', 0x7a, 0x5a],
    ['ispunct', 0x21, 0x61],
    ['isxdigit', 0x66, 0x67],
    ['iscntrl', 0x0a, 0x61],
    ['isgraph', 0x7e, 0x20],
    ['isprint', 0x20, 0x0a],
  ]) {
    assert.equal((await call(name, yes)).result, 1, `${name}(${yes})`);
    assert.equal((await call(name, no)).result, 0, `${name}(${no})`);
    // The classifier masks the index to a byte, exactly as the CRT does.
    assert.equal((await call(name, yes + 0x10000)).result, 1, `${name} masks its argument`);
  }
  // The exported tables are real data, not a zeroed stub.
  const ctype = (await call('_ctype')).result >>> 0;
  assert.equal(r.guestMemory.read(ctype + 2 + 0x41 * 2, 2), 0x0081, 'A is alpha|upper');
  assert.equal(r.guestMemory.read(ctype + 2 + 0x20 * 2, 2), 0x0048, 'space is blank|space');
  const pctype = r.read32((await call('__p__pctype')).result >>> 0);
  assert.equal(pctype, ctype + 2, '__p__pctype points at table+1');
});

test('wide classification and case mapping use the real _wctype table', async (t) => {
  const { r, call } = await setup(t);
  assert.equal((await call('iswalpha', 0x41)).result, 1);
  assert.equal((await call('iswdigit', 0x39)).result, 1);
  assert.equal((await call('iswspace', 0x20)).result, 1);
  assert.equal((await call('iswupper', 0x41)).result, 1);
  assert.equal((await call('iswlower', 0x61)).result, 1);
  assert.equal((await call('towupper', 0x61)).result, 0x41);
  assert.equal((await call('towlower', 0x41)).result, 0x61);
  assert.equal((await call('towctrans', 0x61, 1)).result, 0x41);
  // WEOF is never classified.
  assert.equal((await call('iswalpha', 0xffff)).result, 0);
  // wctype maps the property names Wine's table lists.
  assert.equal((await call('wctype', r.allocString('digit'))).result, 0x0004);
  assert.equal((await call('wctype', r.allocString('upper'))).result, 0x0001);
  assert.equal((await call('wctrans', r.allocString('toupper'))).result, 1);
  assert.equal(
    (await call('isleadbyte', 0x81)).result,
    0,
    'a single-byte code page has no lead bytes',
  );
});

test('strtol/strtod parse with the C rules, including overflow', async (t) => {
  const { r, call } = await setup(t);
  const end = r.allocate(4);
  assert.equal((await call('strtol', r.allocString('  -42xyz'), end, 10)).result, -42);
  assert.equal((await call('strtol', r.allocString('0x1f'), end, 16)).result, 31);
  assert.equal((await call('strtol', r.allocString('0x1f'), end, 0)).result, 31);
  assert.equal(
    (await call('strtol', r.allocString('0777'), end, 0)).result,
    511,
    'base 0 reads a leading 0 as octal',
  );
  assert.equal(
    (await call('strtol', r.allocString('777'), end, 0)).result,
    777,
    'no leading 0 stays decimal',
  );
  assert.equal((await call('strtol', r.allocString('9999999999'), end, 10)).result, 0x7fffffff);
  assert.equal(r.read32((await call('_errno')).result >>> 0) | 0, 34, 'overflow sets ERANGE');
  assert.equal((await call('atoi', r.allocString('12345'))).result, 12345);
  assert.equal((await call('atol', r.allocString('-77'))).result, -77);
  // The 64-bit forms return EAX:EDX.
  const big = await call('_strtoi64', r.allocString('4294967296'), end, 10);
  assert.equal(big.result, 0);
  assert.equal(big.resultHigh, 1);
  assert.equal((await call('strtod', r.allocString('2.5e3'))).result, 0);
  assert.equal(r.cpu.x87.popDouble(), 2500);
  assert.equal((await call('atof', r.allocString('-0.25'))).result, 0);
  assert.equal(r.cpu.x87.popDouble(), -0.25);
});

test('the _itoa family formats in the requested radix', async (t) => {
  const { r, call } = await setup(t);
  const buffer = r.allocate(64);
  assert.equal((await call('_itoa', -255, buffer, 16)).result, buffer);
  assert.equal(r.string(buffer), '-ff');
  await call('_itoa', 1000000, buffer, 10);
  assert.equal(r.string(buffer), '1000000');
  await call('_ltoa', 32, buffer, 2);
  assert.equal(r.string(buffer), '100000');
  await call('_ultoa', 255, buffer, 16);
  assert.equal(r.string(buffer), 'ff');
  const wide = r.allocate(64);
  await call('_itow', -7, wide, 10);
  assert.equal(r.wideString(wide), '-7');
  // A radix outside 2..36 leaves the buffer's own value alone.
  const sentinel = r.allocate(8);
  r.data[sentinel] = 0x5a;
  await call('_itoa', 10, sentinel, 40);
  assert.equal(r.data[sentinel], 0x5a);
});

test('rand/srand use the MSVC LCG stream', async (t) => {
  const { call } = await setup(t);
  await call('srand', 1);
  const first = (await call('rand')).result;
  const second = (await call('rand')).result;
  assert.equal(first, 41, 'srand(1); rand() == 41 in the MSVC generator');
  assert.ok(first >= 0 && first <= 0x7fff);
  assert.ok(second >= 0 && second <= 0x7fff);
  await call('srand', 1);
  assert.equal((await call('rand')).result, first, 'the same seed restarts the stream');
});

test('abs/div/ldiv follow the i386 return convention', async (t) => {
  const { call } = await setup(t);
  assert.equal((await call('abs', -5)).result, 5);
  assert.equal((await call('labs', -7)).result, 7);
  const big = await call('_abs64', 0xfffffffd, 0xffffffff);
  assert.equal(big.result, 3);
  const d = await call('div', -7, 2);
  assert.equal(d.result, -3, 'quotient in EAX');
  assert.equal(d.resultHigh, -1, 'remainder in EDX');
  const ld = await call('ldiv', 100, 7);
  assert.equal(ld.result, 14);
  assert.equal(ld.resultHigh, 2);
});

test('path splitting and joining round-trip a DOS path', async (t) => {
  const { r, call } = await setup(t);
  const drive = r.allocate(8),
    directory = r.allocate(64),
    filename = r.allocate(64),
    extension = r.allocate(16);
  assert.equal(
    (
      await call(
        '_splitpath_s',
        r.allocString('C:\\dir\\sub\\file.txt'),
        drive,
        8,
        directory,
        64,
        filename,
        64,
        extension,
        16,
      )
    ).result,
    0,
  );
  assert.equal(r.string(drive), 'C:');
  assert.equal(r.string(directory), '\\dir\\sub\\');
  assert.equal(r.string(filename), 'file');
  assert.equal(r.string(extension), '.txt');
  // An undersized directory destination clears everything and reports ERANGE
  // (a one-byte buffer cannot hold the separator plus its terminator).
  assert.equal(
    (
      await call(
        '_splitpath_s',
        r.allocString('C:\\x.txt'),
        drive,
        8,
        directory,
        1,
        filename,
        64,
        extension,
        16,
      )
    ).result,
    34,
  );
  assert.equal(r.string(directory), '');
  const path = r.allocate(64);
  await call(
    '_makepath_s',
    path,
    64,
    r.allocString('C:'),
    r.allocString('dir'),
    r.allocString('name'),
    r.allocString('exe'),
  );
  assert.equal(r.string(path), 'C:dir\\name.exe');
});

test('_getcwd/_fullpath describe the package volume', async (t) => {
  const { r, call } = await setup(t);
  const buffer = r.allocate(260);
  assert.equal((await call('_getcwd', buffer, 260)).result, buffer);
  assert.equal(r.string(buffer), 'C:\\winebrowser\\');
  const absolute = r.allocate(260);
  await call('_fullpath', absolute, r.allocString('sub\\x.txt'), 260);
  assert.equal(r.string(absolute), 'C:\\winebrowser\\sub\\x.txt');
  // A NULL destination is allocated for the caller.
  const allocated = (await call('_fullpath', 0, r.allocString('a'), 0)).result >>> 0;
  assert.notEqual(allocated, 0);
  assert.equal(r.string(allocated), 'C:\\winebrowser\\a');
  // A destination size under 4 reports ERANGE and returns NULL.
  assert.equal((await call('_fullpath', absolute, r.allocString('a'), 3)).result, 0);
  assert.equal((await call('_getdrive')).result, 3);
});

test('_stat fills the i386 layout from real file metadata', async (t) => {
  const { r, call } = await setup(t, { 'sub/a.txt': new Uint8Array([1, 2, 3, 4, 5]) });
  const buffer = r.allocate(64);
  r.cwd = 'sub/';
  assert.equal((await call('_stat', r.allocString('a.txt'), buffer)).result, 0);
  // ALL_IREAD/ALL_IWRITE spread each permission bit over the owner/group/other
  // triple, which is what Wine's _wstat64 stores.
  assert.equal(
    r.guestMemory.read(buffer + 6, 2),
    0x8000 | 0x0124 | 0x0092,
    'regular file, read and write',
  );
  assert.equal(r.read32(buffer + 20), 5, 'st_size');
  assert.equal(r.guestMemory.read(buffer + 8, 2), 1, 'st_nlink');
  // A missing file reports -1 and sets errno to ENOENT.
  assert.equal((await call('_stat', r.allocString('missing.txt'), buffer)).result, -1);
  assert.equal(r.read32((await call('_errno')).result >>> 0) | 0, 2);
  // A directory carries the directory bit.
  r.cwd = '';
  assert.equal((await call('_stat', r.allocString('sub'), buffer)).result, 0);
  assert.ok(r.guestMemory.read(buffer + 6, 2) & 0x4000);
  // _access agrees with the metadata.
  assert.equal((await call('_access', r.allocString('sub/a.txt'), 0)).result, 0);
  assert.equal((await call('_access', r.allocString('nope'), 0)).result, -1);
});

test('_findfirst/_findnext enumerate the package volume with DOS wildcards', async (t) => {
  const { r, call } = await setup(t, {
    'data/a.txt': new Uint8Array([1]),
    'data/b.txt': new Uint8Array([1, 2]),
    'data/c.bin': new Uint8Array([1, 2, 3]),
  });
  r.cwd = 'data/';
  const record = r.allocate(320);
  const handle = (await call('_findfirst', r.allocString('*.txt'), record)).result;
  assert.ok(handle >= 0, 'a handle is returned');
  const names = [r.string(record + 20)];
  const sizes = [r.read32(record + 16)];
  while ((await call('_findnext', handle, record)).result === 0) {
    names.push(r.string(record + 20));
    sizes.push(r.read32(record + 16));
  }
  assert.deepEqual(names.sort(), ['a.txt', 'b.txt']);
  assert.deepEqual(sizes.sort(), [1, 2]);
  assert.equal((await call('_findclose', handle)).result, 0);
  // A pattern with no matches fails without a handle.
  assert.equal((await call('_findfirst', r.allocString('*.zip'), record)).result, -1);
});

test('_get_environ and getenv describe the runtime environment', async (t) => {
  const { r, call } = await setup(t);
  const out = r.allocate(4);
  assert.equal((await call('_get_environ', out)).result, 0);
  const vector = r.read32(out);
  assert.notEqual(vector, 0);
  const first = r.string(r.read32(vector));
  assert.ok(first.startsWith('=') || first.startsWith('PATH'), first);
  const path = (await call('getenv', r.allocString('PATH'))).result >>> 0;
  assert.notEqual(path, 0);
  assert.equal(r.string(path), 'C:\\');
  assert.equal((await call('getenv', r.allocString('NOPE'))).result, 0);
});

test('the excluded math helpers return their value in ST(0)', async (t) => {
  const { r, call } = await setup(t);
  // A double argument occupies two stack slots, low half first.
  const doubleArgs = (value) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
  };
  await call('_logb', ...doubleArgs(8), 0);
  assert.equal(r.cpu.x87.popDouble(), 3);
  await call('_logb', ...doubleArgs(0.5), 0);
  assert.equal(r.cpu.x87.popDouble(), -1);
  await call('_hypot', ...doubleArgs(3), ...doubleArgs(4));
  assert.equal(r.cpu.x87.popDouble(), 5);
  // _finite takes its argument on the stack and returns a flag in EAX.
  assert.equal((await call('_finite', ...doubleArgs(1.5))).result, 1);
  assert.equal((await call('_finite', ...doubleArgs(Infinity))).result, 0);
  assert.equal((await call('_isnan', ...doubleArgs(NaN))).result, 1);
  // frexpf writes the exponent through its pointer.
  const exponent = r.allocate(4);
  const mantissaBits = r.allocate(4);
  new DataView(r.data.buffer, r.data.byteOffset).setFloat32(mantissaBits, 8, true);
  await call('frexpf', mantissaBits, exponent);
  assert.equal(r.read32(exponent) | 0, 4);
  assert.equal(r.cpu.x87.popDouble(), 0.5);
  // _copysignf takes two binary32 arguments and returns a float in ST(0).
  const floatBits = (value) => {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
  };
  await call('_copysignf', floatBits(2), floatBits(-1));
  assert.equal(r.cpu.x87.popDouble(), -2);
});
