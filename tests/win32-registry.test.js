import test from 'node:test';
import assert from 'node:assert/strict';
import { registryApis } from '../src/win32-registry.js';
import { encodeAnsi } from '../src/encoding.js';

const registryApiSignatures = {
  RegCreateKeyExW: 9,
  RegCreateKeyExA: 9,
  RegOpenKeyExW: 5,
  RegOpenKeyExA: 5,
  RegOpenKeyA: 3,
  RegQueryValueExW: 6,
  RegQueryValueExA: 6,
  RegSetValueExW: 6,
  RegSetValueExA: 6,
  RegEnumValueA: 8,
  RegDeleteKeyW: 2,
  RegCloseKey: 1,
};

const HKCR = 0x80000000;
const HKCU = 0x80000001;
const HKLM = 0x80000002;
const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_KEY_DELETED = 1018;
const REG_CREATED_NEW_KEY = 1;
const REG_OPENED_EXISTING_KEY = 2;
const REG_SZ = 1;
const REG_DWORD = 4;
const KEY_QUERY_VALUE = 0x0001;
const KEY_SET_VALUE = 0x0002;
const KEY_READ = 0x20019;
const KEY_WRITE = 0x20006;

const API = Object.fromEntries(
  Object.entries(registryApis).map(([qualifiedName, handler]) => [
    qualifiedName.slice('advapi32.dll!'.length),
    handler,
  ]),
);

function fakeRuntime() {
  const data = new Uint8Array(2 * 1024 * 1024);
  const view = new DataView(data.buffer);
  let nextString = 0x1000;
  return {
    data,
    check(address, size, write = false) {
      const start = address >>> 0;
      assert.ok(Number.isSafeInteger(size) && size >= 0 && start + size <= data.length);
      if (write)
        assert.ok(start >= 0x1000, 'simulated output pointers must be writable guest data');
    },
    read32(address) {
      this.check(address, 4);
      return view.getUint32(address, true);
    },
    write32(address, value) {
      this.check(address, 4, true);
      view.setUint32(address, value >>> 0, true);
    },
    wideString(address) {
      if (!address) return '';
      let value = '';
      for (let offset = 0; offset < 0x4000; offset++) {
        const at = (address >>> 0) + offset * 2;
        this.check(at, 2);
        const codeUnit = view.getUint16(at, true);
        if (!codeUnit) return value;
        value += String.fromCharCode(codeUnit);
      }
      throw Error('Unterminated test string');
    },
    string(address) {
      if (!address) return '';
      const bytes = [];
      for (let offset = 0; offset < 0x8000; offset++) {
        const byte = data[(address >>> 0) + offset];
        if (!byte) return new TextDecoder('windows-1252').decode(Uint8Array.from(bytes));
        bytes.push(byte);
      }
      throw Error('Unterminated test ANSI string');
    },
    wide(value) {
      const address = nextString;
      for (let index = 0; index < value.length; index++)
        view.setUint16(address + index * 2, value.charCodeAt(index), true);
      view.setUint16(address + value.length * 2, 0, true);
      nextString += (value.length + 1) * 2 + 4;
      return address;
    },
    ansi(value) {
      const bytes = encodeAnsi(value).bytes;
      const address = nextString;
      data.set(bytes, address);
      data[address + bytes.length] = 0;
      nextString += bytes.length + 5;
      return address;
    },
    bytes(value) {
      const address = nextString;
      data.set(value, address);
      nextString += value.length + 4;
      return address;
    },
  };
}

function call(runtime, name, args) {
  const handler = API[name];
  assert.ok(handler, `missing registry API ${name}`);
  const actual = handler(runtime, (index) => args[index] ?? 0);
  assert.equal(actual.argc, registryApiSignatures[name]);
  return actual.result >>> 0;
}

function createKey(runtime, path, access = KEY_WRITE, root = HKCU) {
  const resultPointer = 0x2000;
  const dispositionPointer = 0x2004;
  const status = call(runtime, 'RegCreateKeyExW', [
    root,
    runtime.wide(path),
    0,
    0,
    0,
    access,
    0,
    resultPointer,
    dispositionPointer,
  ]);
  return {
    status,
    handle: runtime.read32(resultPointer),
    disposition: runtime.read32(dispositionPointer),
  };
}

function openKey(runtime, path, access = KEY_READ, root = HKCU) {
  const resultPointer = 0x2010;
  const status = call(runtime, 'RegOpenKeyExW', [
    root,
    runtime.wide(path),
    0,
    access,
    resultPointer,
  ]);
  return { status, handle: runtime.read32(resultPointer) };
}

function setValue(runtime, handle, name, type, bytes) {
  return call(runtime, 'RegSetValueExW', [
    handle,
    runtime.wide(name),
    0,
    type,
    bytes.length ? runtime.bytes(bytes) : 0,
    bytes.length,
  ]);
}

test('RegCreateKeyExW, RegOpenKeyExW and RegCloseKey retain process-local case-insensitive keys', () => {
  const runtime = fakeRuntime();
  assert.deepEqual(createKey(runtime, 'Software\\Tetris'), {
    status: ERROR_SUCCESS,
    handle: runtime.read32(0x2000),
    disposition: REG_CREATED_NEW_KEY,
  });
  const firstHandle = runtime.read32(0x2000);
  assert.notEqual(firstHandle, 0);

  const existing = createKey(runtime, 'software\\tETRIS');
  assert.equal(existing.status, ERROR_SUCCESS);
  assert.equal(existing.disposition, REG_OPENED_EXISTING_KEY);
  assert.notEqual(existing.handle, firstHandle, 'each open returns its own closeable handle');

  const opened = openKey(runtime, 'SOFTWARE\\TETRIS');
  assert.equal(opened.status, ERROR_SUCCESS);
  assert.equal(call(runtime, 'RegCloseKey', [opened.handle]), ERROR_SUCCESS);
  assert.equal(call(runtime, 'RegCloseKey', [opened.handle]), ERROR_INVALID_HANDLE);
  assert.equal(call(runtime, 'RegCloseKey', [HKCU]), ERROR_SUCCESS);
  assert.equal(
    call(runtime, 'RegOpenKeyExW', [0x80000004, 0, 0, KEY_READ, 0x2010]),
    ERROR_INVALID_HANDLE,
    'performance pseudo-roots are outside this key/value provider',
  );

  const missing = openKey(runtime, 'Software\\Missing');
  assert.equal(missing.status, ERROR_FILE_NOT_FOUND);
  const openRoot = call(runtime, 'RegOpenKeyExW', [HKCR, 0, 0, KEY_READ, 0x2010]);
  assert.equal(openRoot, ERROR_SUCCESS);
  assert.equal(
    runtime.read32(0x2010),
    HKCR,
    'empty predefined-root opens preserve the root handle',
  );
});

test('ANSI create/open APIs decode CP1252 names and share Unicode key handles', () => {
  const runtime = fakeRuntime();
  const result = 0x2000;
  const disposition = 0x2004;
  assert.equal(
    call(runtime, 'RegCreateKeyExA', [
      HKCU,
      runtime.ansi('Software\\Café €'),
      0,
      runtime.ansi('Class™'),
      0,
      KEY_READ,
      0,
      result,
      disposition,
    ]),
    ERROR_SUCCESS,
  );
  assert.equal(runtime.read32(disposition), REG_CREATED_NEW_KEY);
  assert.equal(openKey(runtime, 'software\\CAFÉ €').status, ERROR_SUCCESS);

  assert.equal(
    call(runtime, 'RegOpenKeyExA', [HKCU, runtime.ansi('SOFTWARE\\café €'), 0, KEY_READ, result]),
    ERROR_SUCCESS,
  );
  assert.equal(
    call(runtime, 'RegOpenKeyA', [HKCU, runtime.ansi('Software\\Café €'), result]),
    ERROR_SUCCESS,
  );
  assert.equal(call(runtime, 'RegOpenKeyA', [HKCU, 0, result]), ERROR_SUCCESS);
  assert.equal(runtime.read32(result), HKCU);
});

test('ANSI string values convert through CP1252 while binary data stays byte-exact', () => {
  const runtime = fakeRuntime();
  const { handle } = createKey(runtime, 'Software\\AnsiValues', KEY_READ | KEY_WRITE);
  const ansiText = Uint8Array.from([...encodeAnsi('€ café').bytes, 0]);
  assert.equal(
    call(runtime, 'RegSetValueExA', [
      handle,
      runtime.ansi('Label™'),
      0,
      REG_SZ,
      runtime.bytes(ansiText),
      ansiText.length,
    ]),
    ERROR_SUCCESS,
  );
  const binary = Uint8Array.of(0x80, 0, 0xff, 0x41);
  assert.equal(
    call(runtime, 'RegSetValueExA', [
      handle,
      runtime.ansi('Raw'),
      0,
      3,
      runtime.bytes(binary),
      binary.length,
    ]),
    ERROR_SUCCESS,
  );

  const type = 0x2020,
    size = 0x2024,
    output = 0x2040;
  runtime.write32(size, 64);
  assert.equal(
    call(runtime, 'RegQueryValueExW', [handle, runtime.wide('label™'), 0, type, output, size]),
    ERROR_SUCCESS,
  );
  const expectedWide = new Uint8Array('€ café\0'.length * 2);
  const expectedView = new DataView(expectedWide.buffer);
  [...'€ café\0'].forEach((character, index) =>
    expectedView.setUint16(index * 2, character.charCodeAt(0), true),
  );
  assert.deepEqual(runtime.data.slice(output, output + expectedWide.length), expectedWide);

  runtime.write32(size, ansiText.length - 1);
  runtime.data.fill(0xcc, output, output + ansiText.length);
  assert.equal(
    call(runtime, 'RegQueryValueExA', [handle, runtime.ansi('LABEL™'), 0, type, output, size]),
    ERROR_MORE_DATA,
  );
  assert.equal(runtime.read32(size), ansiText.length);
  assert.deepEqual(
    runtime.data.slice(output, output + ansiText.length),
    new Uint8Array(ansiText.length).fill(0xcc),
  );
  runtime.write32(size, ansiText.length);
  assert.equal(
    call(runtime, 'RegQueryValueExA', [handle, runtime.ansi('Label™'), 0, type, output, size]),
    ERROR_SUCCESS,
  );
  assert.deepEqual(runtime.data.slice(output, output + ansiText.length), ansiText);

  runtime.write32(size, binary.length);
  assert.equal(
    call(runtime, 'RegQueryValueExA', [handle, runtime.ansi('Raw'), 0, type, output, size]),
    ERROR_SUCCESS,
  );
  assert.deepEqual(runtime.data.slice(output, output + binary.length), binary);
});

test('RegEnumValueA enumerates named/default values with independent name and data byte sizing', () => {
  const runtime = fakeRuntime();
  const { handle } = createKey(runtime, 'Software\\Enumeration', KEY_READ | KEY_WRITE);
  const first = Uint8Array.from([...encodeAnsi('€').bytes, 0]);
  assert.equal(
    call(runtime, 'RegSetValueExA', [handle, 0, 0, REG_SZ, runtime.bytes(first), first.length]),
    ERROR_SUCCESS,
  );
  assert.equal(
    call(runtime, 'RegSetValueExW', [
      handle,
      runtime.wide('Café'),
      0,
      REG_DWORD,
      runtime.bytes(Uint8Array.of(0x78, 0x56, 0x34, 0x12)),
      4,
    ]),
    ERROR_SUCCESS,
  );

  const name = 0x2040,
    nameSize = 0x2020,
    type = 0x2024,
    data = 0x2080,
    dataSize = 0x2028;
  runtime.write32(nameSize, 1);
  runtime.write32(dataSize, first.length);
  assert.equal(
    call(runtime, 'RegEnumValueA', [handle, 0, name, nameSize, 0, type, data, dataSize]),
    ERROR_SUCCESS,
  );
  assert.equal(runtime.read32(nameSize), 0);
  assert.equal(runtime.data[name], 0);
  assert.deepEqual(runtime.data.slice(data, data + first.length), first);

  runtime.write32(nameSize, 4);
  runtime.write32(dataSize, 4);
  runtime.data.fill(0xcc, name, name + 8);
  assert.equal(
    call(runtime, 'RegEnumValueA', [handle, 1, name, nameSize, 0, type, data, dataSize]),
    ERROR_MORE_DATA,
  );
  assert.equal(runtime.read32(nameSize), 4, 'short name capacity is unchanged');
  assert.deepEqual(runtime.data.slice(name, name + 4), Uint8Array.from([0x43, 0x61, 0x66, 0]));

  runtime.write32(nameSize, 5);
  assert.equal(
    call(runtime, 'RegEnumValueA', [handle, 1, name, nameSize, 0, type, data, dataSize]),
    ERROR_SUCCESS,
  );
  assert.equal(runtime.read32(nameSize), 4);
  assert.deepEqual(
    runtime.data.slice(name, name + 5),
    Uint8Array.from([0x43, 0x61, 0x66, 0xe9, 0]),
  );
  assert.equal(
    call(runtime, 'RegEnumValueA', [handle, 2, name, nameSize, 0, type, data, dataSize]),
    ERROR_NO_MORE_ITEMS,
  );
});

test('RegSetValueExW and RegQueryValueExW preserve types and exact bytes with Win32 buffer sizing', () => {
  const runtime = fakeRuntime();
  const { handle } = createKey(runtime, 'Software\\Tetris');
  const playerName = Uint8Array.from([0x41, 0x00, 0x6c, 0x00, 0x00, 0x00]);
  const highScore = Uint8Array.from([0x78, 0x56, 0x34, 0x12]);
  assert.equal(setValue(runtime, handle, 'PlayerName', REG_SZ, playerName), ERROR_SUCCESS);
  assert.equal(setValue(runtime, handle, 'HighScore', REG_DWORD, highScore), ERROR_SUCCESS);

  const opened = openKey(runtime, 'SOFTWARE\\TETRIS', KEY_READ);
  assert.equal(opened.status, ERROR_SUCCESS);
  const typePointer = 0x2020;
  const sizePointer = 0x2024;
  const dataPointer = 0x2030;
  runtime.write32(sizePointer, 0xdeadbeef);
  assert.equal(
    call(runtime, 'RegQueryValueExW', [
      opened.handle,
      runtime.wide('playername'),
      0,
      typePointer,
      0,
      sizePointer,
    ]),
    ERROR_SUCCESS,
  );
  assert.equal(runtime.read32(typePointer), REG_SZ);
  assert.equal(runtime.read32(sizePointer), playerName.length);

  assert.equal(
    call(runtime, 'RegQueryValueExW', [opened.handle, runtime.wide('PlayerName'), 0, 0, 0, 0]),
    ERROR_SUCCESS,
    'both optional output pointers may be null when data is not requested',
  );

  runtime.write32(sizePointer, playerName.length - 1);
  runtime.data.fill(0xcc, dataPointer, dataPointer + playerName.length);
  assert.equal(
    call(runtime, 'RegQueryValueExW', [
      opened.handle,
      runtime.wide('PLAYERNAME'),
      0,
      typePointer,
      dataPointer,
      sizePointer,
    ]),
    ERROR_MORE_DATA,
  );
  assert.equal(runtime.read32(sizePointer), playerName.length);
  assert.deepEqual(
    runtime.data.slice(dataPointer, dataPointer + playerName.length),
    new Uint8Array(playerName.length).fill(0xcc),
    'too-small query reports required bytes without partial data writes',
  );

  runtime.write32(sizePointer, playerName.length);
  assert.equal(
    call(runtime, 'RegQueryValueExW', [
      opened.handle,
      runtime.wide('PlayerName'),
      0,
      typePointer,
      dataPointer,
      sizePointer,
    ]),
    ERROR_SUCCESS,
  );
  assert.deepEqual(runtime.data.slice(dataPointer, dataPointer + playerName.length), playerName);

  runtime.write32(sizePointer, 4);
  assert.equal(
    call(runtime, 'RegQueryValueExW', [
      opened.handle,
      runtime.wide('highscore'),
      0,
      typePointer,
      dataPointer,
      sizePointer,
    ]),
    ERROR_SUCCESS,
  );
  assert.equal(runtime.read32(typePointer), REG_DWORD);
  assert.deepEqual(runtime.data.slice(dataPointer, dataPointer + 4), highScore);
  assert.equal(call(runtime, 'RegCloseKey', [opened.handle]), ERROR_SUCCESS);
});

test('registry operations enforce requested access and reject unsupported flags', () => {
  const runtime = fakeRuntime();
  const writable = createKey(runtime, 'Software\\Tetris');
  assert.equal(writable.status, ERROR_SUCCESS);
  assert.equal(
    setValue(runtime, writable.handle, 'score', REG_DWORD, Uint8Array.of(1, 0, 0, 0)),
    ERROR_SUCCESS,
  );
  assert.equal(
    call(runtime, 'RegQueryValueExW', [writable.handle, runtime.wide('score'), 0, 0, 0, 0x2024]),
    ERROR_ACCESS_DENIED,
  );
  assert.equal(
    call(runtime, 'RegSetValueExW', [
      openKey(runtime, 'Software\\Tetris', KEY_QUERY_VALUE).handle,
      runtime.wide('score'),
      0,
      REG_DWORD,
      runtime.bytes(Uint8Array.of(2, 0, 0, 0)),
      4,
    ]),
    ERROR_ACCESS_DENIED,
  );

  const unsupported = call(runtime, 'RegOpenKeyExW', [
    HKCU,
    runtime.wide('Software'),
    0,
    0x20019 | 0x200,
    0x2010,
  ]);
  assert.equal(unsupported, ERROR_INVALID_PARAMETER, 'WOW64 view flags are explicitly unsupported');
  assert.equal(
    call(runtime, 'RegOpenKeyExW', [HKCU, runtime.wide('Software'), 1, KEY_READ, 0x2010]),
    ERROR_INVALID_PARAMETER,
    'symbolic-link open options are unsupported',
  );
  assert.equal(
    call(runtime, 'RegSetValueExW', [writable.handle, runtime.wide('score'), 1, REG_DWORD, 0, 0]),
    ERROR_INVALID_PARAMETER,
  );
  assert.equal(
    call(runtime, 'RegOpenKeyExW', [0x1234, 0, 0, KEY_READ, 0x2010]),
    ERROR_INVALID_HANDLE,
  );
  assert.equal(
    call(runtime, 'RegQueryValueExW', [0x1234, 0xffffffff, 0, 0, 0, 0]),
    ERROR_INVALID_HANDLE,
    'invalid handles are rejected before dereferencing value-name pointers',
  );
});

test('RegDeleteKeyW removes only leaf subkeys and values disappear with their key', () => {
  const runtime = fakeRuntime();
  const parent = createKey(runtime, 'Software\\Tetris');
  const child = createKey(runtime, 'Software\\Tetris\\Session', KEY_READ | KEY_WRITE);
  assert.equal(
    setValue(runtime, child.handle, 'score', REG_DWORD, Uint8Array.of(9, 0, 0, 0)),
    ERROR_SUCCESS,
  );
  assert.equal(
    call(runtime, 'RegDeleteKeyW', [HKCU, runtime.wide('Software\\Tetris')]),
    ERROR_ACCESS_DENIED,
  );
  const readOnlyParent = openKey(runtime, 'Software\\Tetris', KEY_READ);
  assert.equal(
    call(runtime, 'RegDeleteKeyW', [readOnlyParent.handle, runtime.wide('Session')]),
    ERROR_SUCCESS,
    'RegDeleteKeyW checks the key security descriptor, not the handle access mask',
  );
  assert.equal(
    call(runtime, 'RegQueryValueExW', [child.handle, runtime.wide('score'), 0, 0, 0, 0x2030]),
    ERROR_KEY_DELETED,
    'existing handles to a deleted key return ERROR_KEY_DELETED',
  );
  assert.equal(call(runtime, 'RegCloseKey', [child.handle]), ERROR_SUCCESS);
  assert.equal(openKey(runtime, 'Software\\Tetris\\Session').status, ERROR_FILE_NOT_FOUND);
  const childAgain = createKey(runtime, 'Software\\Tetris\\Session', KEY_READ | KEY_WRITE);
  assert.equal(childAgain.status, ERROR_SUCCESS);
  assert.equal(call(runtime, 'RegCloseKey', [childAgain.handle]), ERROR_SUCCESS);
  assert.equal(
    call(runtime, 'RegDeleteKeyW', [HKCU, runtime.wide('Software\\Tetris\\Session')]),
    ERROR_SUCCESS,
  );
  assert.equal(
    call(runtime, 'RegDeleteKeyW', [HKCU, runtime.wide('Software\\Tetris')]),
    ERROR_SUCCESS,
  );
  assert.equal(
    call(runtime, 'RegOpenKeyExW', [HKCU, runtime.wide('Software\\Tetris'), 0, KEY_READ, 0x2010]),
    ERROR_FILE_NOT_FOUND,
  );
  assert.equal(call(runtime, 'RegCloseKey', [parent.handle]), ERROR_SUCCESS);
});

test('registry roots are isolated by runtime process', () => {
  const first = fakeRuntime();
  const second = fakeRuntime();
  assert.equal(createKey(first, 'Software\\Example').status, ERROR_SUCCESS);
  assert.equal(openKey(second, 'Software\\Example').status, ERROR_FILE_NOT_FOUND);
  assert.equal(createKey(first, 'DirectChild', KEY_WRITE, HKLM).status, ERROR_ACCESS_DENIED);
});

test('registry values and open handles have explicit process-local resource bounds', () => {
  const runtime = fakeRuntime();
  const { handle } = createKey(runtime, 'Software\\Limits');
  assert.equal(
    setValue(runtime, handle, 'large', REG_SZ, new Uint8Array(1024 * 1024 + 1)),
    ERROR_NOT_ENOUGH_MEMORY,
  );
  const handles = [];
  for (let index = 0; index < 4095; index++) {
    const opened = openKey(runtime, 'Software\\Limits');
    assert.equal(opened.status, ERROR_SUCCESS);
    handles.push(opened.handle);
  }
  assert.equal(openKey(runtime, 'Software\\Limits').status, ERROR_NOT_ENOUGH_MEMORY);
  for (const value of handles) assert.equal(call(runtime, 'RegCloseKey', [value]), ERROR_SUCCESS);
  assert.equal(call(runtime, 'RegCloseKey', [handle]), ERROR_SUCCESS);
});
