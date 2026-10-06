import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { createWin32ApiProvider, importKey } from '../src/win32.js';

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

test('rotations, _swab and the bounded itoa family', async (t) => {
  const { r, call } = await setup(t);
  assert.equal((await call('_rotl', 0x12345678, 4)).result >>> 0, 0x23456781);
  assert.equal((await call('_rotr', 0x12345678, 4)).result >>> 0, 0x81234567);
  assert.equal((await call('_rotl', 0x80000000, 1)).result >>> 0, 0x00000001);
  // A count of 32 masks to 0, leaving the value alone.
  assert.equal((await call('_rotl', 0xdeadbeef, 32)).result >>> 0, 0xdeadbeef);
  assert.equal((await call('_lrotl', 0x12345678, 8)).result >>> 0, 0x34567812);
  assert.equal((await call('_lrotr', 0x12345678, 8)).result >>> 0, 0x78123456);

  // _swab swaps whole adjacent pairs; Wine copies `len >> 1` pairs and does not
  // touch the odd trailing byte, so 'ABCDE' yields 'BADC' and a clear byte 4.
  const source = r.allocString('ABCDE'),
    destination = r.allocate(8);
  await call('_swab', source, destination, 5);
  assert.equal(r.string(destination), 'BADC');

  // The _s forms clear the buffer and report EINVAL/ERANGE instead of overrunning.
  const buffer = r.allocate(16);
  assert.equal((await call('_itoa_s', -255, buffer, 16, 16)).result, 0);
  assert.equal(r.string(buffer), '-ff');
  assert.equal((await call('_ultoa_s', 0xffffffff, buffer, 16, 10)).result, 0);
  assert.equal(r.string(buffer), '4294967295');
  // A too-small buffer is cleared and reported as ERANGE.
  assert.equal((await call('_itoa_s', 1000, buffer, 2, 10)).result, 34);
  assert.equal(r.string(buffer), '');
  // An invalid radix is EINVAL.
  assert.equal((await call('_itoa_s', 10, buffer, 16, 40)).result, 22);
  const wide = r.allocate(32);
  assert.equal((await call('_itow_s', -7, wide, 16, 10)).result, 0);
  assert.equal(r.wideString(wide), '-7');
  const big = r.allocate(32);
  assert.equal((await call('_i64toa_s', 0, 1, big, 32, 10)).result, 0);
  assert.equal(r.string(big), '4294967296');
});

test('the single-byte code-page conversions agree with the CRT contract', async (t) => {
  const { r, call } = await setup(t);
  const out = r.allocate(4);
  const ascii = r.allocString('A');
  assert.equal((await call('mbtowc', out, ascii, 1)).result, 1);
  assert.equal(r.guestMemory.read(out, 2), 0x41);
  // A byte at or above 0x80 has no single-byte UTF-16 mapping.
  const high = r.allocate(2);
  r.data[high] = 0x81;
  assert.equal((await call('mbtowc', out, high, 1)).result, -1);
  assert.equal(r.read32((await call('_errno')).result >>> 0) | 0, 42, 'EILSEQ');
  assert.equal((await call('btowc', 0x41)).result, 0x41);
  assert.equal((await call('btowc', 0x81)).result, 0xffff);
  assert.equal((await call('wctob', 0x41)).result, 0x41);
  assert.equal((await call('wctob', 0x100)).result, -1);

  // mbstowcs converts a whole string and NUL-terminates it.
  const wide = r.allocate(16);
  const text = r.allocString('Hi');
  assert.equal((await call('mbstowcs', wide, text, 16)).result, 2);
  assert.equal(r.wideString(wide), 'Hi');
  // wcstombs is the inverse.
  const bytes = r.allocate(16);
  assert.equal((await call('wcstombs', bytes, wide, 16)).result, 2);
  assert.equal(r.string(bytes), 'Hi');
});

test('localeconv reports the C locale and setlocale records the name', async (t) => {
  const { r, call } = await setup(t);
  const lconv = (await call('localeconv')).result >>> 0;
  assert.notEqual(lconv, 0);
  assert.equal(r.string(r.read32(lconv)), '.');
  assert.equal(r.string(r.read32(lconv + 4)), '');
  assert.equal(r.data[lconv + 40], 0x7f, 'int_frac_digits is CHAR_MAX');
  const name = (await call('setlocale', 0, r.allocString('C'))).result >>> 0;
  assert.equal(r.string(name), 'C');
  assert.notEqual((await call('_get_current_locale')).result >>> 0, 0);
  assert.notEqual((await call('_create_locale', 0, r.allocString('C'))).result >>> 0, 0);
});

test('_lsearch appends a key the comparator never matched', async (t) => {
  const { r, call } = await setup(t);
  // A guest comparator built from real machine code: return *(int*)a - *(int*)b.
  const code = new Uint8Array([
    0x8b,
    0x44,
    0x24,
    0x04, // mov eax,[esp+4]
    0x8b,
    0x4c,
    0x24,
    0x08, // mov ecx,[esp+8]
    0x8b,
    0x00, // mov eax,[eax]
    0x2b,
    0x01, // sub eax,[ecx]
    0xc3, // ret
  ]);
  const base = r.allocate(4096);
  r.data.set(code, base);
  r.cpu.ranges = [...r.cpu.ranges, [base, base + code.length, false]];
  const table = r.allocate(16);
  r.write32(table, 10);
  r.write32(table + 4, 20);
  const count = r.allocate(4);
  r.write32(count, 2);
  const key = r.allocate(4);
  r.write32(key, 30);
  const found = (await call('_lsearch', key, table, count, 4, base)).result >>> 0;
  assert.equal(found, table + 8, 'the new element is appended at the end');
  assert.equal(r.read32(count), 3);
  assert.equal(r.read32(table + 8), 30);
});

test('_strnset and __strncnt operate on the byte string', async (t) => {
  const { r, call } = await setup(t);
  const buffer = r.allocString('abcdef');
  await call('_strnset', buffer, 0x2a, 3);
  assert.equal(r.string(buffer), '***def');
  assert.equal((await call('__strncnt', r.allocString('abc def'), 0x20)).result, 3);
});

test('_setjmp records the register file and longjmp restores it', async (t) => {
  const { r, call } = await setup(t);
  const buffer = r.allocate(64);
  // Give the registers recognizable values, and point ESP at a stack word that
  // holds the return address setjmp is expected to record as the jump target.
  r.cpu.r[5].value = 0x11111111; // ebp
  r.cpu.r[3].value = 0x22222222; // ebx
  r.cpu.r[7].value = 0x33333333; // edi
  r.cpu.r[6].value = 0x44444444; // esi
  const stack = r.allocate(16);
  r.write32(stack, 0x0abcdef0);
  r.cpu.r[4].value = stack;

  assert.equal((await call('_setjmp', buffer)).result, 0);
  assert.equal(r.read32(buffer + 0) >>> 0, 0x11111111, 'Ebp');
  assert.equal(r.read32(buffer + 4) >>> 0, 0x22222222, 'Ebx');
  assert.equal(r.read32(buffer + 8) >>> 0, 0x33333333, 'Edi');
  assert.equal(r.read32(buffer + 12) >>> 0, 0x44444444, 'Esi');
  assert.equal(r.read32(buffer + 16) >>> 0, stack, 'Esp');
  assert.equal(r.read32(buffer + 20) >>> 0, 0x0abcdef0, 'Eip is the return address');

  // _setjmp3 decorates the buffer with the jump magic the CRT checks.
  const decorated = r.allocate(64);
  await call('_setjmp3', decorated, 0);
  assert.equal(r.read32(decorated + 32) >>> 0, 0x56433230, 'Cookie');

  // Clobber the registers, then longjmp: the saved values come back and the
  // reported result is the jump target (the runtime resumes there without
  // popping a return address of its own).
  r.cpu.r[5].value = 0;
  r.cpu.r[3].value = 0;
  r.cpu.r[7].value = 0;
  r.cpu.r[6].value = 0;
  r.cpu.r[4].value = 0;
  const jumped = await call('longjmp', buffer, 0);
  assert.equal(jumped.result, 1, 'a zero retval becomes 1');
  assert.equal(jumped.jumpTo >>> 0, 0x0abcdef0, 'control resumes at the saved Eip');
  assert.equal(jumped.convention, 'cdecl');
  assert.equal(r.cpu.r[5].value >>> 0, 0x11111111);
  assert.equal(r.cpu.r[3].value >>> 0, 0x22222222);
  assert.equal(r.cpu.r[7].value >>> 0, 0x33333333);
  assert.equal(r.cpu.r[6].value >>> 0, 0x44444444);
  assert.equal(r.cpu.r[4].value >>> 0, stack);

  // A non-zero retval is preserved.
  const explicit = await call('longjmp', buffer, 7);
  assert.equal(explicit.result, 7);
});

test('_dup/_dup2 share the descriptor with its original', async (t) => {
  const { r, call } = await setup(t);
  // Create a real file through the CRT's own _open so the descriptor table has
  // an entry backed by a Win32 handle.
  r.crtFds = new Map();
  r.crtFdNext = 3;
  const handle = r.nextHandle++;
  r.handles.set(handle, { path: 'dup.txt', position: 0, access: 0xc0000000, share: 0 });
  r.files.set('dup.txt', new Uint8Array(10));
  r.crtFds.set(3, handle);

  const duplicate = (await call('_dup', 3)).result;
  assert.equal(duplicate, 4, 'the next free descriptor is returned');
  assert.equal(r.crtFds.get(4), handle, 'the duplicate names the same Win32 handle');

  // _dup2 copies onto an explicit descriptor.
  const target = (await call('_dup2', 3, 9)).result;
  assert.equal(target, 9);
  assert.equal(r.crtFds.get(9), handle);

  // A descriptor that was never opened is EBADF.
  assert.equal((await call('_dup', 77)).result, -1);
  assert.equal(r.read32((await call('_errno')).result >>> 0) | 0, 9);

  // _eof reports the position against the file's length.
  r.handles.get(handle).position = 10;
  assert.equal((await call('_eof', 3)).result, 1);
  r.handles.get(handle).position = 4;
  assert.equal((await call('_eof', 3)).result, 0);

  // _tell and _telli64 report the same position.
  assert.equal((await call('_tell', 3)).result, 4);
  const wide = await call('_telli64', 3);
  assert.equal(wide.result, 4);
  assert.equal(wide.resultHigh, 0);
});

test('the CRT process and console helpers answer from the runtime model', async (t) => {
  const { r, call } = await setup(t);
  assert.equal((await call('_umask', 0o22)).result, 0, 'the previous umask');
  assert.equal((await call('_umask', 0)).result, 0o22, 'and it is remembered');
  assert.equal((await call('_getdrives')).result, 0b100, 'only C: exists');
  assert.equal((await call('_get_osplatform', r.allocate(4))).result, 0);
  // The disk-free figures come from the bounded volume's real usage.
  const info = r.allocate(20);
  assert.equal((await call('_getdiskfree', 3, info)).result, 0);
  assert.equal(r.read32(info), 32768, 'total clusters');
  assert.ok(r.read32(info + 4) <= r.read32(info), 'available clusters');
  assert.equal(r.read32(info + 8), 8, 'sectors per cluster');
  assert.equal(r.read32(info + 12), 512, 'bytes per sector');
  // Console input is not interactive: a poll reports no key, a read EOF.
  assert.equal((await call('_kbhit')).result, 0);
  assert.equal((await call('_getch')).result | 0, -1);
  assert.equal((await call('_getw', r.allocate(4))).result | 0, -1);
  // The new-handler and error-mode accessors round-trip their values.
  assert.equal((await call('_set_error_mode', 1)).result, 0);
  assert.equal((await call('_set_error_mode', 2)).result, 1);
  assert.equal((await call('_set_sbh_threshold', 4096)).result, 0);
  assert.equal((await call('_get_output_format')).result, 0);
  assert.equal((await call('_set_output_format', 1)).result, 0);
});

test('_aligned_malloc/_aligned_free/_msize round-trip a live block', async (t) => {
  const { r, call } = await setup(t);
  // A 64-byte-aligned block with a nonzero offset still lands on a live heap
  // address whose base _aligned_free can recover.
  const pointer = (await call('_aligned_malloc', 100, 64)).result >>> 0;
  assert.notEqual(pointer, 0);
  assert.equal(pointer % 64, 0, 'the returned address honours the alignment');
  const size = (await call('_msize', pointer)).result >>> 0;
  assert.ok(size >= 100, 'the usable size covers the request');
  // Writing through the block and freeing it must not fault.
  r.data.set(new Uint8Array([1, 2, 3, 4]), pointer);
  assert.equal((await call('_aligned_free', pointer)).result, 0);
  // _expand takes a raw heap pointer (malloc's), not an aligned one, and keeps
  // the block in place when the request already fits.
  const block = r.allocate(32);
  assert.equal((await call('_expand', block, 16)).result >>> 0, block, 'no growth needed');
  assert.equal(
    (await call('_expand', block, 0x800000)).result >>> 0,
    0,
    'an impossible growth fails',
  );
  // An invalid alignment is rejected.
  assert.equal((await call('_aligned_malloc', 16, 3)).result, 0);
});

test('remove/rename/_mkdir/_rmdir operate on the package volume', async (t) => {
  const { r, call } = await setup(t, { 'dir/a.txt': new Uint8Array([1, 2, 3]) });
  assert.equal((await call('remove', r.allocString('C:\\winebrowser\\dir\\a.txt'))).result, 0);
  assert.equal(r.files.has('dir/a.txt'), false, 'the file is gone');
  assert.equal((await call('remove', r.allocString('C:\\winebrowser\\dir\\a.txt'))).result, -1);
  assert.equal(r.read32((await call('_errno')).result >>> 0) | 0, 2, 'ENOENT');

  // rename moves the bytes to the new key.
  r.files.set('dir/b.txt', new Uint8Array([9, 9]));
  assert.equal(
    (
      await call(
        'rename',
        r.allocString('C:\\winebrowser\\dir\\b.txt'),
        r.allocString('C:\\winebrowser\\dir\\c.txt'),
      )
    ).result,
    0,
  );
  assert.equal(r.files.has('dir/b.txt'), false);
  assert.equal(r.files.has('dir/c.txt'), true);

  // _mkdir/_rmdir add and remove an empty directory.
  assert.equal((await call('_mkdir', r.allocString('C:\\winebrowser\\newdir'))).result, 0);
  assert.equal(r.virtualDirectories.has('newdir/'), true);
  assert.equal(
    (await call('_mkdir', r.allocString('C:\\winebrowser\\newdir'))).result,
    -1,
    'already exists',
  );
  assert.equal((await call('_rmdir', r.allocString('C:\\winebrowser\\newdir'))).result, 0);
  assert.equal(r.virtualDirectories.has('newdir/'), false);
  // A directory with contents cannot be removed.
  assert.equal((await call('_rmdir', r.allocString('C:\\winebrowser\\dir'))).result, -1);
  assert.equal(r.read32((await call('_errno')).result >>> 0) | 0, 41, 'ENOTEMPTY');
});

test('_strdate/_strtime/_strdate_s format the guest clock', async (t) => {
  const { r, call } = await setup(t);
  const buffer = r.allocate(16);
  assert.equal((await call('_strdate', buffer)).result, buffer);
  assert.match(r.string(buffer), /^\d\d\/\d\d\/\d\d$/);
  await call('_strtime', buffer);
  assert.match(r.string(buffer), /^\d\d:\d\d:\d\d$/);
  // The bounded form reports ERANGE for a buffer that cannot hold the text.
  const small = r.allocate(4);
  assert.equal((await call('_strdate_s', small, 4)).result, 34);
  const exact = r.allocate(16);
  assert.equal((await call('_strdate_s', exact, 16)).result, 0);
});

test('_open_osfhandle wraps a Win32 handle as a CRT descriptor', async (t) => {
  const { r, call } = await setup(t);
  r.crtFds = new Map();
  r.crtFdNext = 3;
  const handle = r.nextHandle++;
  r.handles.set(handle, { path: 'x', position: 0, access: 0xc0000000, share: 0 });
  const descriptor = (await call('_open_osfhandle', handle, 0)).result;
  assert.ok(descriptor >= 3);
  assert.equal(r.crtFds.get(descriptor), handle, 'the descriptor names the handle');
  // A handle the runtime does not know is EBADF.
  assert.equal((await call('_open_osfhandle', 0xdeadbeef, 0)).result, -1);
});

test('_stricoll/_wcsicoll and _memccpy follow the C-locale contract', async (t) => {
  const { r, call } = await setup(t);
  assert.equal((await call('_stricoll', r.allocString('abc'), r.allocString('ABC'), 3)).result, 0);
  assert.equal((await call('_stricoll', r.allocString('abc'), r.allocString('abd'), 3)).result, -1);
  const wideLeft = r.allocString('ABC', true),
    wideRight = r.allocString('abc', true);
  assert.equal((await call('_wcsicoll', wideLeft, wideRight)).result, 0);

  // _memccpy copies through the found byte and returns just past it.
  const source = r.allocString('hello'),
    destination = r.allocate(16);
  const stop = (await call('_memccpy', destination, source, 0x6c /* 'l' */, 5)).result >>> 0;
  assert.equal(stop, destination + 3, 'the returned pointer is past the found byte');
  assert.equal(r.string(destination), 'hel');
});

test('_ecvt/_fcvt/_gcvt format with the CRT digit rules', async (t) => {
  const { r, call } = await setup(t);
  // A double argument occupies two stack slots, low half first.
  const doubleArgs = (value) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
  };
  const decpt = r.allocate(4),
    sign = r.allocate(4);

  // _ecvt returns ndigits significant digits and the point position.
  const ecvt = await call('_ecvt', ...doubleArgs(1234.5), 5, decpt, sign);
  assert.equal(r.string(ecvt.result >>> 0), '12345');
  assert.equal(r.read32(decpt) | 0, 4);
  assert.equal(r.read32(sign) | 0, 0);

  // A negative value below one reports the sign and a negative point position.
  const tiny = await call('_ecvt', ...doubleArgs(-0.00123), 3, decpt, sign);
  assert.equal(r.string(tiny.result >>> 0), '123');
  assert.equal(r.read32(decpt) | 0, -2);
  assert.equal(r.read32(sign) | 0, 1);

  // _fcvt returns the digits with no decimal point.
  const fcvt = await call('_fcvt', ...doubleArgs(1234.5), 2, decpt, sign);
  assert.equal(r.string(fcvt.result >>> 0), '123450');
  assert.equal(r.read32(decpt) | 0, 4);

  // _gcvt writes a compact decimal.
  const gcvt = await call('_gcvt', ...doubleArgs(-2.75), 4);
  assert.equal(r.string(gcvt.result >>> 0), '-2.75');

  // The _s forms write into the caller's buffer and report errno_t.
  const buffer = r.allocate(32);
  assert.equal((await call('_ecvt_s', buffer, 32, ...doubleArgs(99.5), 3, decpt, sign)).result, 0);
  assert.equal(r.string(buffer), '995');
  assert.equal((await call('_gcvt_s', buffer, 32, ...doubleArgs(1.5), 3)).result, 0);
  assert.equal(r.string(buffer), '1.5');
  // A buffer too small for the text reports ERANGE.
  assert.equal((await call('_ecvt_s', buffer, 2, ...doubleArgs(99.5), 3, decpt, sign)).result, 34);
});

test('the locale-suffixed and multibyte classifiers share the ctype tables', async (t) => {
  const { r, call } = await setup(t);
  // The `_l` forms take (c, locale) and classify identically; one locale is
  // modelled, so the extra argument changes nothing.
  assert.equal((await call('_isalpha_l', 0x41, 0)).result, 1);
  assert.equal((await call('_isdigit_l', 0x37, 0)).result, 1);
  assert.equal((await call('_iswalpha_l', 0x41, 0)).result, 1);
  assert.equal((await call('_iswdigit_l', 0x39, 0)).result, 1);
  // The multibyte predicates reduce to the byte classifier on a single-byte
  // code page.
  assert.equal((await call('_ismbcalnum', 0x41)).result, 1);
  assert.equal((await call('_ismbcdigit', 0x37)).result, 1);
  assert.equal((await call('_ismbcspace', 0x20)).result, 1);
  assert.equal((await call('_ismbcupper', 0x41)).result, 1);
  assert.equal((await call('_ismbclower', 0x61)).result, 1);
  assert.equal((await call('_ismbcpunct', 0x21)).result, 1);
  // A byte is never a Japanese-specific class under this code page.
  assert.equal((await call('_ismbchira', 0xa4)).result, 0);
  assert.equal((await call('_ismbbkana', 0xa1)).result, 0);
  // _mbstrlen counts characters, equal to bytes here.
  assert.equal((await call('_mbstrlen', r.allocString('hello'))).result, 5);
});

test('_ftime fills the timeb structures from the guest clock', async (t) => {
  const { r, call } = await setup(t);
  // struct __timeb32 is {time(4), millitm(2), timezone(2), dstflag(2)} = 12 bytes.
  const small = r.allocate(16);
  assert.equal((await call('_ftime32', small)).result, 0);
  const seconds = Math.floor(r.systemNow() / 1000);
  assert.equal(r.read32(small) | 0, seconds);
  assert.ok(r.guestMemory.read(small + 4, 2) < 1000, 'millitm is the millisecond part');
  // struct __timeb64 widens `time` to an 8-aligned int64, so millitm is at 8.
  const large = r.allocate(24);
  assert.equal((await call('_ftime64', large)).result, 0);
  assert.equal(Number(r.view.getBigInt64(large, true)), seconds);
  assert.ok(r.guestMemory.read(large + 8, 2) < 1000);
  // The _s forms validate the pointer.
  assert.equal((await call('_ftime_s', 0)).result, 22, 'EINVAL for a null pointer');
});

test('_utime/_futime set the file times the stat family reads back', async (t) => {
  const { r, call } = await setup(t, { 'f.txt': new Uint8Array([1]) });
  // struct __utimbuf32 {actime(4), modtime(4)}.
  const times = r.allocate(8);
  r.write32(times, 1000000);
  r.write32(times + 4, 2000000);
  const path = r.allocString('C:\\winebrowser\\f.txt');
  assert.equal((await call('_utime32', path, times)).result, 0);
  const stat = r.allocate(64);
  assert.equal((await call('_stat', path, stat)).result, 0);
  assert.equal(r.read32(stat + 24) | 0, 1000000, 'st_atime');
  assert.equal(r.read32(stat + 28) | 0, 2000000, 'st_mtime');
  // A null buffer means "now".
  assert.equal((await call('_utime32', path, 0)).result, 0);
  // _utime64 reads 8-aligned int64 fields.
  const wideTimes = r.allocate(16);
  r.view.setBigInt64(wideTimes, 3000000n, true);
  r.view.setBigInt64(wideTimes + 8, 4000000n, true);
  assert.equal((await call('_utime64', path, wideTimes)).result, 0);
  await call('_stat', path, stat);
  assert.equal(r.read32(stat + 24) | 0, 3000000);
  assert.equal(r.read32(stat + 28) | 0, 4000000);
  // A missing file is ENOENT.
  assert.equal((await call('_utime32', r.allocString('C:\\winebrowser\\nope'), times)).result, -1);
});

test('__threadid and __wcserror answer from the runtime model', async (t) => {
  const { r, call } = await setup(t);
  assert.equal((await call('__threadid')).result, r.threads.current.id | 0);
  const message = (await call('__wcserror', 42)).result >>> 0;
  assert.equal(r.wideString(message), 'Error 42');
  const buffer = r.allocate(64);
  assert.equal((await call('__wcserror_s', buffer, 32, 7)).result, 0);
  assert.equal(r.wideString(buffer), 'Error 7');
  assert.equal((await call('__uncaught_exception')).result, 0);
});

test('_Getdays/_Getmonths hand back the C locale name tables', async (t) => {
  const { r, call } = await setup(t);
  const days = (await call('_Getdays')).result >>> 0;
  assert.notEqual(days, 0);
  assert.equal(r.string(r.read32(days)), 'Sunday');
  const months = (await call('_Getmonths')).result >>> 0;
  assert.equal(r.string(r.read32(months)), 'January');
  assert.equal(r.string(r.read32(months + 8 * 4)), 'September');
  // The wide tables carry the same names.
  const wideDays = (await call('_W_Getdays')).result >>> 0;
  assert.equal(r.wideString(r.read32(wideDays + 6 * 4) >>> 0), 'Saturday');
});

test('the small process accessors report stable cells', async (t) => {
  const { r, call } = await setup(t);
  assert.equal((await call('___mb_cur_max_func')).result, 1);
  const mbCurMax = (await call('__p___mb_cur_max')).result >>> 0;
  assert.equal(r.read32(mbCurMax), 1);
  const amblksiz = (await call('__p__amblksiz')).result >>> 0;
  assert.notEqual(amblksiz, 0);
  assert.notEqual((await call('__p__tzname')).result >>> 0, 0);
  assert.equal((await call('_tzset')).result, 0);
});

test('the __libm_sse2 entry points read and write XMM0/XMM1', async (t) => {
  const { r, call } = await setup(t);
  const setXmm = (index, value) => {
    r.cpu.simd.registers[index].set(new Uint32Array(new Float64Array([value]).buffer));
  };
  const getXmm = (index) => {
    const view = new DataView(r.cpu.simd.registers[index].buffer);
    return view.getFloat64(0, true);
  };
  setXmm(0, 0);
  await call('__libm_sse2_sin');
  assert.equal(getXmm(0), 0);
  setXmm(0, Math.PI / 2);
  await call('__libm_sse2_cos');
  assert.ok(Math.abs(getXmm(0) - 6.123233995736766e-17) < 1e-30, 'cos(pi/2) is ~0');
  // The two-argument forms read XMM0 and XMM1 and leave the result in XMM0.
  setXmm(0, 2);
  setXmm(1, 10);
  await call('__libm_sse2_pow');
  assert.equal(getXmm(0), 1024);
  setXmm(0, 3);
  setXmm(1, 4);
  await call('__libm_sse2_atan2');
  assert.ok(Math.abs(getXmm(0) - Math.atan2(3, 4)) < 1e-15);
  // The binary32 forms use the low lane only.
  const setXmmF = (index, value) => {
    new DataView(r.cpu.simd.registers[index].buffer).setFloat32(0, value, true);
  };
  const getXmmF = (index) => new DataView(r.cpu.simd.registers[index].buffer).getFloat32(0, true);
  setXmmF(0, 1);
  await call('__libm_sse2_expf');
  assert.ok(Math.abs(getXmmF(0) - Math.E) < 1e-6, 'expf(1) is e');
  setXmmF(0, 1e30);
  setXmmF(1, 2);
  await call('__libm_sse2_powf');
  assert.equal(getXmmF(0), Infinity);
});

test('versioned CRT C++ operators are dispatched cdecl so the caller owns cleanup', async () => {
  // The decorated C++ names carry no @<bytes> suffix, so nothing in the name
  // distinguishes cdecl from stdcall. Wine's msvcr80..msvcr120 specs mark
  // operator new/delete cdecl, and dispatching them stdcall removes four bytes
  // the caller also removes, corrupting the stack of every C++ program.
  const provider = createWin32ApiProvider();
  const runtime = {
    check: () => 0,
    read32: () => 0,
    write32: () => {},
    allocate: () => 0x10000,
    free: () => true,
    cpu: { r: Array.from({ length: 8 }, () => ({ value: 0 })), x87: {} },
    data: new Uint8Array(0x20000),
    view: new DataView(new ArrayBuffer(0x20000)),
  };
  for (const [dll, name, argc] of [
    ['msvcr80.dll', '??2@YAPAXI@Z', 1],
    ['msvcr80.dll', '??3@YAXPAX@Z', 1],
    ['msvcr80.dll', '??_U@YAPAXI@Z', 1],
    ['msvcr80.dll', '??_V@YAXPAX@Z', 1],
    ['msvcr100.dll', '??2@YAPAXI@Z', 1],
    ['msvcr120.dll', '_except_handler4_common', 5],
  ]) {
    const handler = provider.get(importKey(dll, name));
    assert.ok(handler, `${dll}!${name} is registered`);
    const response = await handler(runtime, () => 0);
    assert.equal(response.convention, 'cdecl', `${name} is cdecl`);
    assert.equal(response.argc, argc, `${name} reports its slot count`);
  }
});
