import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import iced from 'iced-x86';
import { Runtime } from '../src/runtime.js';
import { ntServices } from '../src/wine-nt.js';
import { registryApis } from '../src/win32-registry.js';
import { PROCESS_USER_SID } from '../src/process-identity.js';

const exe = new Uint8Array(
  await readFile(new URL('../public/demos/console/console.exe', import.meta.url)),
);
const HKCU = 0x80000001;
const HKLM = 0x80000002;
const ALL_ACCESS = 0x000f003f;
const MAXIMUM_ALLOWED = 0x02000000;
const KEY_QUERY_VALUE = 1;
const KEY_SET_VALUE = 2;
const SUCCESS = 0;
const BUFFER_OVERFLOW = 0x80000005;
const ACCESS_VIOLATION = 0xc0000005;
const INVALID_HANDLE = 0xc0000008;
const INVALID_PARAMETER = 0xc000000d;
const NO_MEMORY = 0xc0000017;
const ACCESS_DENIED = 0xc0000022;
const BUFFER_TOO_SMALL = 0xc0000023;
const OBJECT_NAME_NOT_FOUND = 0xc0000034;

function runtime() {
  return new Runtime(iced, { files: new Map([['console.exe', exe]]), exe: 'console.exe' });
}

function wide(r, value) {
  const address = r.allocate(value.length * 2 + 2);
  for (let i = 0; i < value.length; i++)
    r.view.setUint16(address + i * 2, value.charCodeAt(i), true);
  return address;
}

function unicode(r, value) {
  const buffer = wide(r, value);
  const address = r.allocate(8);
  r.view.setUint16(address, value.length * 2, true);
  r.view.setUint16(address + 2, value.length * 2 + 2, true);
  r.write32(address + 4, buffer);
  return address;
}

function objectAttributes(r, name, root = 0) {
  const address = r.allocate(24);
  r.write32(address, 24);
  r.write32(address + 4, root);
  r.write32(address + 8, unicode(r, name));
  r.write32(address + 12, 0x40); // OBJ_CASE_INSENSITIVE.
  return address;
}

function nt(r, name, args) {
  const service = ntServices[name];
  assert.ok(service, `missing ${name}`);
  assert.equal(service.argc, args.length);
  return service.call(r, (index) => args[index]);
}

function create(r, path, access = ALL_ACCESS, root = 0) {
  const output = r.allocate(4);
  const disposition = r.allocate(4);
  const status = nt(r, 'NtCreateKey', [
    output,
    access,
    objectAttributes(r, path, root),
    0,
    0,
    0,
    disposition,
  ]);
  return { status, handle: r.read32(output), disposition: r.read32(disposition) };
}

test('NT create/open/set/query/close share process-local keys with Advapi32', () => {
  const r = runtime();
  const machine = create(r, '\\Registry\\Machine', MAXIMUM_ALLOWED);
  assert.equal(machine.status, SUCCESS);
  const first = create(r, 'Software\\WineBrowser', ALL_ACCESS, machine.handle);
  assert.equal(first.status, SUCCESS);
  assert.equal(first.disposition, 1);
  const existing = create(r, '\\registry\\machine\\software\\WINEBROWSER');
  assert.equal(existing.status, SUCCESS);
  assert.equal(existing.disposition, 2);
  assert.notEqual(existing.handle, first.handle);

  const name = unicode(r, 'Edition');
  const data = r.allocate(4);
  r.write32(data, 0x12345678);
  assert.equal(nt(r, 'NtSetValueKey', [first.handle, name, 0, 4, data, 4]), SUCCESS);

  const opened = r.allocate(4);
  r.write32(opened, 0xdeadbeef);
  assert.equal(
    nt(r, 'NtOpenKey', [
      opened,
      KEY_QUERY_VALUE,
      objectAttributes(r, 'winebrowser', machine.handle),
    ]),
    OBJECT_NAME_NOT_FOUND,
  );
  assert.equal(r.read32(opened), 0);
  assert.equal(
    nt(r, 'NtOpenKey', [
      opened,
      KEY_QUERY_VALUE,
      objectAttributes(r, 'Software\\winebrowser', machine.handle),
    ]),
    SUCCESS,
  );
  const query = r.allocate(16);
  const required = r.allocate(4);
  assert.equal(nt(r, 'NtQueryValueKey', [r.read32(opened), name, 2, query, 16, required]), SUCCESS);
  assert.equal(r.read32(required), 16);
  assert.deepEqual(
    [r.read32(query), r.read32(query + 4), r.read32(query + 8), r.read32(query + 12)],
    [0, 4, 4, 0x12345678],
  );

  const win32Output = r.allocate(4);
  const openedFromWin32 = registryApis['advapi32.dll!RegOpenKeyExW'](
    r,
    (index) => [HKLM, wide(r, 'Software\\WineBrowser'), 0, KEY_QUERY_VALUE, win32Output][index],
  );
  assert.equal(openedFromWin32.result, SUCCESS);
  const size = r.allocate(4);
  r.write32(size, 4);
  const win32Data = r.allocate(4);
  const queriedFromWin32 = registryApis['advapi32.dll!RegQueryValueExW'](
    r,
    (index) => [r.read32(win32Output), wide(r, 'edition'), 0, 0, win32Data, size][index],
  );
  assert.equal(queriedFromWin32.result, SUCCESS);
  assert.equal(r.read32(win32Data), 0x12345678);

  assert.equal(nt(r, 'NtClose', [first.handle]), SUCCESS);
  assert.equal(nt(r, 'NtClose', [first.handle]), INVALID_HANDLE);
  assert.equal(nt(r, 'NtClose', [existing.handle]), SUCCESS);
  assert.equal(nt(r, 'NtClose', [r.read32(opened)]), SUCCESS);
  assert.equal(nt(r, 'NtClose', [machine.handle]), SUCCESS);
});

test('NT value queries report exact required length and bounded partial data', () => {
  const r = runtime();
  const key = create(r, `\\Registry\\User\\${PROCESS_USER_SID}\\Values`);
  assert.equal(key.status, SUCCESS);
  const name = unicode(r, 'Payload');
  const data = r.allocate(4);
  r.data.set([1, 2, 3, 4], data);
  assert.equal(nt(r, 'NtSetValueKey', [key.handle, name, 0, 3, data, 4]), SUCCESS);
  const output = r.allocate(16);
  const length = r.allocate(4);

  r.data.fill(0xaa, output, output + 16);
  assert.equal(nt(r, 'NtQueryValueKey', [key.handle, name, 2, 0, 0, length]), BUFFER_TOO_SMALL);
  assert.equal(r.read32(length), 16);
  assert.deepEqual([...r.data.slice(output, output + 16)], Array(16).fill(0xaa));

  assert.equal(
    nt(r, 'NtQueryValueKey', [key.handle, name, 2, output, 14, length]),
    BUFFER_OVERFLOW,
  );
  assert.deepEqual([...r.data.slice(output + 12, output + 16)], [1, 2, 0xaa, 0xaa]);
  assert.equal(r.read32(length), 16);
  assert.equal(
    nt(r, 'NtQueryValueKey', [key.handle, name, 2, output, 8, length]),
    BUFFER_TOO_SMALL,
  );
  assert.equal(r.read32(output + 4), 3);
  assert.equal(
    nt(r, 'NtQueryValueKey', [key.handle, name, 3, output, 16, length]),
    INVALID_PARAMETER,
  );
  assert.equal(
    nt(r, 'NtQueryValueKey', [key.handle, unicode(r, 'Missing'), 2, output, 16, length]),
    OBJECT_NAME_NOT_FOUND,
  );
});

test('NT registry enforces handle access, pointers, value bounds and process isolation', () => {
  const r = runtime();
  const user = create(r, '\\Registry\\User');
  assert.equal(user.status, SUCCESS);
  const software = create(r, 'Software', ALL_ACCESS, user.handle);
  assert.equal(software.status, SUCCESS);
  const key = create(r, 'Permissions', KEY_QUERY_VALUE, software.handle);
  assert.equal(key.status, SUCCESS);
  const name = unicode(r, 'Value');
  assert.equal(nt(r, 'NtSetValueKey', [key.handle, name, 0, 4, 0, 0]), ACCESS_DENIED);
  assert.equal(
    nt(r, 'NtQueryValueKey', [key.handle, name, 2, 0, 0, r.allocate(4)]),
    OBJECT_NAME_NOT_FOUND,
  );
  assert.equal(
    nt(r, 'NtCreateKey', [0, ALL_ACCESS, objectAttributes(r, 'Bad', software.handle), 0, 0, 0, 0]),
    ACCESS_VIOLATION,
  );
  assert.equal(
    nt(r, 'NtOpenKey', [r.allocate(4), 0x10000000, objectAttributes(r, 'Software', user.handle)]),
    INVALID_PARAMETER,
  );
  assert.equal(
    nt(r, 'NtSetValueKey', [software.handle, name, 0, 4, 0, 1024 * 1024 + 1]),
    NO_MEMORY,
  );
  assert.equal(
    nt(r, 'NtQueryValueKey', [0x5100ffff, name, 2, 0, 0, r.allocate(4)]),
    INVALID_HANDLE,
  );
  assert.throws(() => nt(r, 'NtClose', [0x1234]), /Unsupported Wine NT service NtClose/);

  const other = runtime();
  const otherUser = create(other, '\\Registry\\User');
  const output = other.allocate(4);
  assert.equal(
    nt(other, 'NtOpenKey', [
      output,
      KEY_SET_VALUE,
      objectAttributes(other, 'Software\\Permissions', otherUser.handle),
    ]),
    OBJECT_NAME_NOT_FOUND,
  );
});

test('NT create requires an existing parent and native RootDirectory handles', () => {
  const r = runtime();
  const machine = create(r, '\\Registry\\Machine');
  assert.equal(machine.status, SUCCESS);
  assert.equal(
    create(r, 'Missing\\Leaf', ALL_ACCESS, machine.handle).status,
    OBJECT_NAME_NOT_FOUND,
  );
  const output = r.allocate(4);
  assert.equal(
    nt(r, 'NtOpenKey', [output, KEY_QUERY_VALUE, objectAttributes(r, 'Missing', machine.handle)]),
    OBJECT_NAME_NOT_FOUND,
  );
  assert.equal(create(r, 'Software\\Bad', ALL_ACCESS, HKLM).status, INVALID_HANDLE);
  assert.equal(create(r, 'Software\\Bad', ALL_ACCESS, HKCU).status, INVALID_HANDLE);
  assert.equal(
    nt(r, 'NtQueryValueKey', [HKCU, unicode(r, 'x'), 2, 0, 0, r.allocate(4)]),
    INVALID_HANDLE,
  );

  assert.equal(
    create(r, 'System\\CurrentControlSet\\Control\\Nls', ALL_ACCESS, machine.handle).status,
    SUCCESS,
  );
  assert.equal(
    create(
      r,
      'Software\\Microsoft\\Windows NT\\CurrentVersion\\Time Zones',
      ALL_ACCESS,
      machine.handle,
    ).status,
    SUCCESS,
  );
});

test('native current-user SID and Win32 HKCU share one key tree', () => {
  const r = runtime();
  const nativeUser = r.allocate(4);
  assert.equal(
    nt(r, 'NtOpenKey', [
      nativeUser,
      ALL_ACCESS,
      objectAttributes(r, `\\Registry\\User\\${PROCESS_USER_SID}`),
    ]),
    SUCCESS,
  );
  const nativeSoftware = create(r, 'Software', ALL_ACCESS, r.read32(nativeUser));
  assert.equal(nativeSoftware.status, SUCCESS);
  const win32Key = r.allocate(4);
  assert.equal(
    registryApis['advapi32.dll!RegOpenKeyExW'](
      r,
      (index) => [HKCU, wide(r, 'Software'), 0, KEY_QUERY_VALUE, win32Key][index],
    ).result,
    SUCCESS,
  );
  const valueName = unicode(r, 'CrossAbi');
  const valueData = r.allocate(4);
  r.write32(valueData, 0xdecafbad);
  assert.equal(
    nt(r, 'NtSetValueKey', [nativeSoftware.handle, valueName, 0, 4, valueData, 4]),
    SUCCESS,
  );
  const result = r.allocate(4);
  const length = r.allocate(4);
  r.write32(length, 4);
  assert.equal(
    registryApis['advapi32.dll!RegQueryValueExW'](
      r,
      (index) => [r.read32(win32Key), wide(r, 'CrossAbi'), 0, 0, result, length][index],
    ).result,
    SUCCESS,
  );
  assert.equal(r.read32(result), 0xdecafbad);
  assert.equal(
    registryApis['advapi32.dll!RegDeleteKeyW'](
      r,
      (index) => [0x80000003, wide(r, PROCESS_USER_SID)][index],
    ).result,
    5,
  );
});

test('NtOpenKeyEx shares native key lookup and rejects unsupported open options', () => {
  const r = runtime();
  const output = r.allocate(4);
  const attributes = objectAttributes(r, '\\Registry\\Machine');
  assert.equal(nt(r, 'NtOpenKeyEx', [output, KEY_QUERY_VALUE, attributes, 0]), SUCCESS);
  assert.equal(nt(r, 'NtClose', [r.read32(output)]), SUCCESS);
  assert.equal(nt(r, 'NtOpenKeyEx', [output, KEY_QUERY_VALUE, attributes, 8]), INVALID_PARAMETER);
});
