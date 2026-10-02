import { PROCESS_USER_SID } from './process-identity.js';
import { decodeAnsi, encodeAnsi } from './encoding.js';
import { resolveGuestPath } from './guest-paths.js';

const ok = (result = 0, argc = 0) => ({ result, argc });
const fail = (r, error, argc = 0, value = 0) => {
  r.lastError = error;
  return ok(value, argc);
};

const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_KEY_DELETED = 1018;

const REG_CREATED_NEW_KEY = 1;
const REG_OPENED_EXISTING_KEY = 2;

const KEY_QUERY_VALUE = 0x0001;
const KEY_SET_VALUE = 0x0002;
const KEY_CREATE_SUB_KEY = 0x0004;
const KEY_ENUMERATE_SUB_KEYS = 0x0008;
const KEY_NOTIFY = 0x0010;
const READ_CONTROL = 0x00020000;
const SUPPORTED_ACCESS =
  KEY_QUERY_VALUE |
  KEY_SET_VALUE |
  KEY_CREATE_SUB_KEY |
  KEY_ENUMERATE_SUB_KEYS |
  KEY_NOTIFY |
  READ_CONTROL;
// Like the NT registry boundary, process-owned keys permit the standard
// KEY_ALL_ACCESS mask. Granted rights do not create APIs for security editing
// or symbolic links; those operations still require their implementations.
const KEY_ALL_ACCESS = 0x000f003f;
const ROOT_ACCESS = 0xffffffff;
const MAX_KEYS = 4096;
const MAX_HANDLES = 4096;
const MAX_VALUES = 65536;
const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_TOTAL_VALUE_BYTES = 16 * 1024 * 1024;
const MAX_KEY_NAME_LENGTH = 255;
const MAX_VALUE_NAME_LENGTH = 16383;
const STRING_TYPES = new Set([1, 2, 7]); // REG_SZ, REG_EXPAND_SZ, REG_MULTI_SZ

const PREDEFINED_ROOTS = [
  [0x80000000, 'HKEY_CLASSES_ROOT'],
  [0x80000001, 'HKEY_CURRENT_USER'],
  [0x80000002, 'HKEY_LOCAL_MACHINE'],
  [0x80000003, 'HKEY_USERS'],
  [0x80000005, 'HKEY_CURRENT_CONFIG'],
];

const states = new WeakMap();

function response(status, argc) {
  return { result: status, argc };
}

function createNode(name, parent = null, className = '') {
  return {
    name,
    className,
    parent,
    children: new Map(),
    values: new Map(),
    openHandles: 0,
    deletePending: false,
  };
}

function stateFor(runtime) {
  let state = states.get(runtime);
  if (state) return state;
  const roots = new Map(PREDEFINED_ROOTS.map(([handle, name]) => [handle, createNode(name)]));
  const users = roots.get(0x80000003);
  const currentUser = createNode(PROCESS_USER_SID, users);
  users.children.set(PROCESS_USER_SID.toUpperCase(), currentUser);
  roots.set(0x80000001, currentUser);
  state = {
    roots,
    handles: new Map(),
    nextHandle: 0x51000000,
    keyCount: 1,
    valueCount: 0,
    totalValueBytes: 0,
  };
  // The Wine server normally loads these parent keys from its registry prefix.
  // This process-local store has no prefix, so seed only the parents that Wine
  // locale initialization opens beneath HKLM before the guest can create them.
  const machine = roots.get(0x80000002);
  for (const path of [
    ['System', 'CurrentControlSet', 'Control'],
    ['Software', 'Microsoft', 'Windows NT', 'CurrentVersion'],
  ]) {
    let parent = machine;
    for (const name of path) {
      let child = parent.children.get(name.toUpperCase());
      if (!child) {
        child = createNode(name, parent);
        parent.children.set(name.toUpperCase(), child);
        state.keyCount++;
      }
      parent = child;
    }
  }
  states.set(runtime, state);
  return state;
}

function keyFor(handle, state) {
  const value = handle >>> 0;
  if (state.roots.has(value))
    return { node: state.roots.get(value), access: ROOT_ACCESS, predefined: true };
  return state.handles.get(value) ?? null;
}

function createHandle(state, node, access) {
  if (state.handles.size >= MAX_HANDLES) return 0;
  while (
    !state.nextHandle ||
    state.roots.has(state.nextHandle) ||
    state.handles.has(state.nextHandle)
  )
    state.nextHandle = (state.nextHandle + 1) >>> 0;
  const value = state.nextHandle >>> 0;
  state.nextHandle = (state.nextHandle + 1) >>> 0;
  node.openHandles++;
  state.handles.set(value, { node, access: access >>> 0, predefined: false });
  return value;
}

function releaseHandle(state, handle) {
  const opened = state.handles.get(handle >>> 0);
  if (!opened) return false;
  state.handles.delete(handle >>> 0);
  opened.node.openHandles--;
  if (opened.node.deletePending && opened.node.openHandles === 0)
    removeDeletedNode(state, opened.node);
  return true;
}

function removeDeletedNode(state, node) {
  if (node.parent?.children.get(node.name.toUpperCase()) === node)
    node.parent.children.delete(node.name.toUpperCase());
  state.keyCount--;
  for (const value of node.values.values()) {
    state.valueCount--;
    state.totalValueBytes -= value.data.byteLength;
  }
  node.values.clear();
}

function guestString(runtime, address, ansi) {
  return address ? (ansi ? runtime.string(address) : runtime.wideString(address)) : '';
}

function readPath(runtime, address, allowNull = false, ansi = false) {
  if (!address) return allowNull ? [] : null;
  const value = guestString(runtime, address, ansi);
  if (!value) return [];
  const parts = value.split('\\');
  if (
    parts.some((part) => part.length === 0 || part.length > MAX_KEY_NAME_LENGTH) ||
    parts.length > 32
  )
    return null;
  return parts;
}

function childOf(node, name) {
  return node.children.get(name.toUpperCase()) ?? null;
}

function openPath(node, parts) {
  let current = node;
  for (const part of parts) {
    current = childOf(current, part);
    if (!current || current.deletePending) return null;
  }
  return current;
}

function createPath(state, rootHandle, node, parts, className) {
  let missingCount = 0;
  let scan = node;
  for (let index = 0; index < parts.length; index++) {
    if (!scan) {
      missingCount += parts.length - index;
      break;
    }
    const child = childOf(scan, parts[index]);
    if (child?.deletePending) return { error: ERROR_KEY_DELETED };
    if (!child) {
      if (index === 0 && scan === node && (rootHandle === 0x80000002 || rootHandle === 0x80000003))
        return { error: ERROR_ACCESS_DENIED };
      missingCount += parts.length - index;
      break;
    }
    scan = child;
  }
  if (state.keyCount + missingCount > MAX_KEYS) return { error: ERROR_NOT_ENOUGH_MEMORY };

  let current = node;
  let finalCreated = false;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    let child = childOf(current, part);
    if (!child) {
      child = createNode(part, current, index === parts.length - 1 ? className : '');
      current.children.set(part.toUpperCase(), child);
      state.keyCount++;
      finalCreated = index === parts.length - 1;
    }
    current = child;
  }
  return { node: current, created: finalCreated };
}

function supportedAccess(mask) {
  // This runtime exposes a 32-bit Windows registry. As on 32-bit Windows,
  // either WOW64 view selector is ignored; contradictory selectors are invalid.
  const view = mask & 0x300;
  return view !== 0x300 && (mask & ~(KEY_ALL_ACCESS | 0x300)) === 0;
}

function accessDenied(opened, required) {
  return (opened.access & required) !== required;
}

function checkedOutput(runtime, address, optional = false) {
  if (!address) return optional;
  runtime.check(address, 4, true);
  return true;
}

function writeOutput(runtime, address, value) {
  runtime.write32(address, value);
}

function regCreateKeyEx(runtime, argument, ansi) {
  const rootHandle = argument(0) >>> 0;
  const subkeyAddress = argument(1);
  const reserved = argument(2);
  const classAddress = argument(3);
  const options = argument(4) >>> 0;
  const desiredAccess = argument(5) >>> 0;
  const securityAttributes = argument(6);
  const resultAddress = argument(7);
  const dispositionAddress = argument(8);
  if (
    !subkeyAddress ||
    reserved !== 0 ||
    options !== 0 ||
    securityAttributes !== 0 ||
    !supportedAccess(desiredAccess) ||
    !checkedOutput(runtime, resultAddress) ||
    !checkedOutput(runtime, dispositionAddress, true)
  )
    return response(ERROR_INVALID_PARAMETER, 9);

  const opened = keyFor(rootHandle, stateFor(runtime));
  if (!opened) return response(ERROR_INVALID_HANDLE, 9);
  if (opened.node.deletePending) return response(ERROR_KEY_DELETED, 9);
  const path = readPath(runtime, subkeyAddress, false, ansi);
  if (!path) return response(ERROR_INVALID_PARAMETER, 9);
  const className = guestString(runtime, classAddress, ansi);
  const state = stateFor(runtime);
  if (state.handles.size >= MAX_HANDLES) return response(ERROR_NOT_ENOUGH_MEMORY, 9);
  const outcome = createPath(state, rootHandle, opened.node, path, className);
  if (outcome.error) return response(outcome.error, 9);
  const handle = createHandle(state, outcome.node, desiredAccess);
  if (!handle) return response(ERROR_NOT_ENOUGH_MEMORY, 9);
  writeOutput(runtime, resultAddress, handle);
  if (dispositionAddress)
    writeOutput(
      runtime,
      dispositionAddress,
      outcome.created ? REG_CREATED_NEW_KEY : REG_OPENED_EXISTING_KEY,
    );
  return response(ERROR_SUCCESS, 9);
}

function regCreateKeyExW(runtime, argument) {
  return regCreateKeyEx(runtime, argument, false);
}

function regCreateKeyExA(runtime, argument) {
  return regCreateKeyEx(runtime, argument, true);
}

function regOpenKeyEx(runtime, argument, ansi) {
  const rootHandle = argument(0) >>> 0;
  const subkeyAddress = argument(1);
  const options = argument(2) >>> 0;
  const desiredAccess = argument(3) >>> 0;
  const resultAddress = argument(4);
  if (options !== 0 || !supportedAccess(desiredAccess) || !checkedOutput(runtime, resultAddress))
    return response(ERROR_INVALID_PARAMETER, 5);

  const state = stateFor(runtime);
  const opened = keyFor(rootHandle, state);
  if (!opened) return response(ERROR_INVALID_HANDLE, 5);
  if (opened.node.deletePending) return response(ERROR_KEY_DELETED, 5);
  const path = readPath(runtime, subkeyAddress, true, ansi);
  if (!path) return response(ERROR_INVALID_PARAMETER, 5);
  if (!path.length && opened.predefined) {
    writeOutput(runtime, resultAddress, rootHandle);
    return response(ERROR_SUCCESS, 5);
  }
  const node = openPath(opened.node, path);
  if (!node) return response(ERROR_FILE_NOT_FOUND, 5);
  const handle = createHandle(state, node, desiredAccess);
  if (!handle) return response(ERROR_NOT_ENOUGH_MEMORY, 5);
  writeOutput(runtime, resultAddress, handle);
  return response(ERROR_SUCCESS, 5);
}

function regOpenKeyExW(runtime, argument) {
  return regOpenKeyEx(runtime, argument, false);
}

function regOpenKeyExA(runtime, argument) {
  return regOpenKeyEx(runtime, argument, true);
}

function regOpenKey(runtime, argument, ansi) {
  const resultAddress = argument(2);
  if (!checkedOutput(runtime, resultAddress)) return response(ERROR_INVALID_PARAMETER, 3);
  const subkeyAddress = argument(1);
  if (!subkeyAddress || guestString(runtime, subkeyAddress, ansi) === '') {
    writeOutput(runtime, resultAddress, argument(0));
    return response(ERROR_SUCCESS, 3);
  }
  const args = [argument(0), subkeyAddress, 0, SUPPORTED_ACCESS, resultAddress];
  const result = regOpenKeyEx(runtime, (index) => args[index], ansi);
  return response(result.result, 3);
}

function regCreateKey(runtime, argument, ansi) {
  // Legacy RegCreateKey requests MAXIMUM_ALLOWED. The process-local registry
  // has no ACLs; grant every access right implemented by this provider.
  const args = [argument(0), argument(1), 0, 0, 0, SUPPORTED_ACCESS, 0, argument(2), 0];
  return response(regCreateKeyEx(runtime, (index) => args[index], ansi).result, 3);
}

function ansiValueData(type, bytes) {
  if (!STRING_TYPES.has(type)) return bytes;
  const value = decodeAnsi(bytes);
  const result = new Uint8Array(value.length * 2);
  const view = new DataView(result.buffer);
  for (let index = 0; index < value.length; index++)
    view.setUint16(index * 2, value.charCodeAt(index), true);
  return result;
}

function unicodeValueData(type, bytes) {
  if (!STRING_TYPES.has(type)) return bytes;
  let value = '';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 1 < bytes.length; offset += 2)
    value += String.fromCharCode(view.getUint16(offset, true));
  return encodeAnsi(value).bytes;
}

function regQueryValueEx(runtime, argument, ansi) {
  const state = stateFor(runtime);
  const opened = keyFor(argument(0), state);
  if (!opened) return response(ERROR_INVALID_HANDLE, 6);
  if (opened.node.deletePending) return response(ERROR_KEY_DELETED, 6);
  const valueName = guestString(runtime, argument(1), ansi);
  const reserved = argument(2);
  const typeAddress = argument(3);
  const dataAddress = argument(4);
  const sizeAddress = argument(5);
  if (reserved || (dataAddress && !sizeAddress)) return response(ERROR_INVALID_PARAMETER, 6);
  if (valueName.length > MAX_VALUE_NAME_LENGTH) return response(ERROR_INVALID_PARAMETER, 6);
  if (accessDenied(opened, KEY_QUERY_VALUE)) return response(ERROR_ACCESS_DENIED, 6);

  const value = opened.node.values.get(valueName.toUpperCase());
  if (!value) return response(ERROR_FILE_NOT_FOUND, 6);
  const data = ansi ? unicodeValueData(value.type, value.data) : value.data;
  if (typeAddress) runtime.check(typeAddress, 4, true);
  if (sizeAddress) runtime.check(sizeAddress, 4, true);
  if (!dataAddress) {
    if (typeAddress) writeOutput(runtime, typeAddress, value.type);
    if (sizeAddress) writeOutput(runtime, sizeAddress, data.byteLength);
    return response(ERROR_SUCCESS, 6);
  }

  const capacity = runtime.read32(sizeAddress);
  if (capacity < data.byteLength) {
    if (typeAddress) writeOutput(runtime, typeAddress, value.type);
    writeOutput(runtime, sizeAddress, data.byteLength);
    return response(ERROR_MORE_DATA, 6);
  }
  runtime.check(dataAddress, data.byteLength, true);
  if (typeAddress) writeOutput(runtime, typeAddress, value.type);
  runtime.data.set(data, dataAddress);
  writeOutput(runtime, sizeAddress, data.byteLength);
  return response(ERROR_SUCCESS, 6);
}

function regQueryValueExW(runtime, argument) {
  return regQueryValueEx(runtime, argument, false);
}

function regQueryValueExA(runtime, argument) {
  return regQueryValueEx(runtime, argument, true);
}

function regSetValueEx(runtime, argument, ansi) {
  const state = stateFor(runtime);
  const opened = keyFor(argument(0), state);
  if (!opened) return response(ERROR_INVALID_HANDLE, 6);
  if (opened.node.deletePending) return response(ERROR_KEY_DELETED, 6);
  const valueName = guestString(runtime, argument(1), ansi);
  const reserved = argument(2);
  const type = argument(3) >>> 0;
  const dataAddress = argument(4) >>> 0;
  const byteCount = argument(5) >>> 0;
  if (reserved) return response(ERROR_INVALID_PARAMETER, 6);
  if (valueName.length > MAX_VALUE_NAME_LENGTH) return response(ERROR_INVALID_PARAMETER, 6);
  if (accessDenied(opened, KEY_SET_VALUE)) return response(ERROR_ACCESS_DENIED, 6);
  if (byteCount && !dataAddress) return response(ERROR_INVALID_PARAMETER, 6);
  if (byteCount > MAX_VALUE_BYTES) return response(ERROR_NOT_ENOUGH_MEMORY, 6);
  if (byteCount) runtime.check(dataAddress, byteCount);
  let bytes = byteCount
    ? runtime.data.slice(dataAddress, dataAddress + byteCount)
    : new Uint8Array();
  if (ansi) bytes = ansiValueData(type, bytes);
  return response(storeValue(state, opened, valueName, type, bytes), 6);
}

function regSetValueExW(runtime, argument) {
  return regSetValueEx(runtime, argument, false);
}

function regSetValueExA(runtime, argument) {
  return regSetValueEx(runtime, argument, true);
}

function deleteValue(state, opened, name) {
  if (name.length > MAX_VALUE_NAME_LENGTH) return ERROR_INVALID_PARAMETER;
  const key = name.toUpperCase(),
    value = opened.node.values.get(key);
  if (!value) return ERROR_FILE_NOT_FOUND;
  opened.node.values.delete(key);
  state.valueCount--;
  state.totalValueBytes -= value.data.byteLength;
  return ERROR_SUCCESS;
}

function regDeleteValue(runtime, argument, ansi) {
  const state = stateFor(runtime),
    opened = keyFor(argument(0), state);
  if (!opened) return response(ERROR_INVALID_HANDLE, 2);
  if (opened.node.deletePending) return response(ERROR_KEY_DELETED, 2);
  if (accessDenied(opened, KEY_SET_VALUE)) return response(ERROR_ACCESS_DENIED, 2);
  return response(deleteValue(state, opened, guestString(runtime, argument(1), ansi)), 2);
}

function regEnumValue(runtime, argument, ansi) {
  const nameAddress = argument(2) >>> 0;
  const nameSizeAddress = argument(3) >>> 0;
  const reserved = argument(4) >>> 0;
  const typeAddress = argument(5) >>> 0;
  const dataAddress = argument(6) >>> 0;
  const dataSizeAddress = argument(7) >>> 0;
  if (!nameAddress || !nameSizeAddress || reserved || (dataAddress && !dataSizeAddress))
    return response(ERROR_INVALID_PARAMETER, 8);

  const state = stateFor(runtime);
  const opened = keyFor(argument(0), state);
  if (!opened) return response(ERROR_INVALID_HANDLE, 8);
  if (opened.node.deletePending) return response(ERROR_KEY_DELETED, 8);
  if (accessDenied(opened, KEY_QUERY_VALUE)) return response(ERROR_ACCESS_DENIED, 8);
  runtime.check(nameSizeAddress, 4, true);
  if (typeAddress) runtime.check(typeAddress, 4, true);
  if (dataSizeAddress) runtime.check(dataSizeAddress, 4, true);

  const value = [...opened.node.values.values()][argument(1) >>> 0];
  if (!value) return response(ERROR_NO_MORE_ITEMS, 8);
  const name = ansi
    ? encodeAnsi(value.name).bytes
    : new Uint8Array(
        Uint16Array.from({ length: value.name.length }, (_, i) => value.name.charCodeAt(i)).buffer,
      );
  const nameLength = ansi ? name.length : value.name.length;
  const unit = ansi ? 1 : 2;
  const data = ansi ? unicodeValueData(value.type, value.data) : value.data;
  let status = ERROR_SUCCESS;

  if (dataAddress) {
    const capacity = runtime.read32(dataSizeAddress) >>> 0;
    if (capacity < data.length) status = ERROR_MORE_DATA;
    else {
      runtime.check(dataAddress, data.length, true);
      runtime.data.set(data, dataAddress);
    }
  }
  if (status === ERROR_SUCCESS) {
    const capacity = runtime.read32(nameSizeAddress) >>> 0;
    if (capacity <= nameLength) {
      status = ERROR_MORE_DATA;
      if (capacity) {
        runtime.check(nameAddress, capacity * unit, true);
        runtime.data.set(name.subarray(0, (capacity - 1) * unit), nameAddress);
        runtime.data.fill(0, nameAddress + (capacity - 1) * unit, nameAddress + capacity * unit);
      }
    } else {
      runtime.check(nameAddress, name.length + unit, true);
      runtime.data.set(name, nameAddress);
      runtime.data.fill(0, nameAddress + name.length, nameAddress + name.length + unit);
      writeOutput(runtime, nameSizeAddress, nameLength);
    }
  }
  if (typeAddress) writeOutput(runtime, typeAddress, value.type);
  if (dataSizeAddress) writeOutput(runtime, dataSizeAddress, data.length);
  return response(status, 8);
}

function regQueryInfoKey(runtime, argument, ansi) {
  const opened = keyFor(argument(0), stateFor(runtime));
  if (!opened) return response(ERROR_INVALID_HANDLE, 12);
  if (opened.node.deletePending) return response(ERROR_KEY_DELETED, 12);
  if (argument(3) || (argument(1) && !argument(2))) return response(ERROR_INVALID_PARAMETER, 12);
  if (accessDenied(opened, KEY_QUERY_VALUE)) return response(ERROR_ACCESS_DENIED, 12);
  if (argument(10)) throw Error('Registry security descriptor sizing is unsupported');
  const node = opened.node,
    children = [...node.children.values()].filter((n) => !n.deletePending),
    values = [...node.values.values()];
  const length = (name) => (ansi ? encodeAnsi(name).bytes.length : name.length);
  const maximum = (items, project) => items.reduce((n, item) => Math.max(n, project(item)), 0);
  for (const [index, value] of [
    [4, children.length],
    [5, maximum(children, (n) => length(n.name))],
    [6, maximum(children, (n) => length(n.className))],
    [7, values.length],
    [8, maximum(values, (v) => length(v.name))],
    [9, maximum(values, (v) => (ansi ? unicodeValueData(v.type, v.data) : v.data).length)],
  ])
    if (argument(index)) writeOutput(runtime, argument(index), value);
  if (argument(11)) {
    runtime.check(argument(11), 8, true);
    runtime.write32(argument(11), 0);
    runtime.write32(argument(11) + 4, 0);
  }
  let status = ERROR_SUCCESS;
  if (argument(2)) {
    const needed = length(node.className),
      capacity = runtime.read32(argument(2));
    if (argument(1)) {
      if (capacity <= needed) status = ERROR_MORE_DATA;
      else {
        const bytes = ansi
          ? encodeAnsi(node.className).bytes
          : new Uint8Array(
              Uint16Array.from({ length: node.className.length }, (_, i) =>
                node.className.charCodeAt(i),
              ).buffer,
            );
        const unit = ansi ? 1 : 2;
        runtime.check(argument(1), bytes.length + unit, true);
        runtime.data.set(bytes, argument(1));
        runtime.data.fill(0, argument(1) + bytes.length, argument(1) + bytes.length + unit);
      }
    }
    writeOutput(runtime, argument(2), needed);
  }
  return response(status, 12);
}

function storeValue(state, opened, valueName, type, bytes) {
  if (valueName.length > MAX_VALUE_NAME_LENGTH) return ERROR_INVALID_PARAMETER;
  if (!(bytes instanceof Uint8Array)) return ERROR_INVALID_PARAMETER;
  if (bytes.length > MAX_VALUE_BYTES) return ERROR_NOT_ENOUGH_MEMORY;
  const oldValue = opened.node.values.get(valueName.toUpperCase());
  if (
    (!oldValue && state.valueCount >= MAX_VALUES) ||
    state.totalValueBytes - (oldValue?.data.byteLength ?? 0) + bytes.length > MAX_TOTAL_VALUE_BYTES
  )
    return ERROR_NOT_ENOUGH_MEMORY;
  if (!oldValue) state.valueCount++;
  state.totalValueBytes += bytes.length - (oldValue?.data.byteLength ?? 0);
  opened.node.values.set(valueName.toUpperCase(), { name: valueName, type, data: bytes });
  return ERROR_SUCCESS;
}

// RegDeleteKeyA and RegEnumKeyA/W complete the legacy ANSI registry surface
// PuTTY's configuration code uses. RegDeleteKeyA shares RegDeleteKeyW's
// semantics with ANSI path decoding; RegEnumKey enumerates subkey names.
function regDeleteKeyA(runtime, argument) {
  const state = stateFor(runtime);
  const parent = keyFor(argument(0), state);
  if (!parent) return response(ERROR_INVALID_HANDLE, 2);
  if (parent.node.deletePending) return response(ERROR_KEY_DELETED, 2);
  const raw = guestString(runtime, argument(1), true);
  if (!raw) return response(ERROR_INVALID_PARAMETER, 2);
  let path;
  try {
    path = normalizePath(raw).split('/').filter(Boolean);
  } catch {
    return response(ERROR_INVALID_PARAMETER, 2);
  }
  if (!path.length) return response(ERROR_INVALID_PARAMETER, 2);
  let current = parent.node;
  for (let index = 0; index < path.length - 1; index++) {
    current = childOf(current, path[index]);
    if (!current || current.deletePending) return response(ERROR_FILE_NOT_FOUND, 2);
  }
  const key = childOf(current, path.at(-1));
  if (!key || key.deletePending) return response(ERROR_FILE_NOT_FOUND, 2);
  if (key.children.size) return response(ERROR_ACCESS_DENIED, 2);
  key.deletePending = true;
  if (key.openHandles === 0) removeDeletedNode(state, key);
  return response(ERROR_SUCCESS, 2);
}
// RegEnumKeyA/W(HKEY, DWORD Index, LPTSTR Name, DWORD NameSize). Only the name
// is returned; the extended form reports the last-write time on request.
function regEnumKey(runtime, argument, ansi) {
  const state = stateFor(runtime);
  const opened = keyFor(argument(0), state);
  if (!opened) return response(ERROR_INVALID_HANDLE, 4);
  if (opened.node.deletePending) return response(ERROR_KEY_DELETED, 4);
  if (accessDenied(opened, KEY_ENUMERATE_SUB_KEYS)) return response(ERROR_ACCESS_DENIED, 4);
  const nameAddress = argument(2) >>> 0;
  const size = argument(3) >>> 0;
  if (!nameAddress || !size) return response(ERROR_INVALID_PARAMETER, 4);
  runtime.check(nameAddress, ansi ? size : size * 2, true);
  const children = [...opened.node.children.values()]
    .filter((child) => !child.deletePending)
    .sort((left, right) => left.name.localeCompare(right.name));
  const child = children[argument(1) >>> 0];
  if (!child) return response(ERROR_NO_MORE_ITEMS, 4);
  const encoded = ansi ? encodeAnsi(child.name).bytes : null;
  const needed = ansi ? encoded.length + 1 : child.name.length + 1;
  if ((ansi ? size : size) < needed) return response(ERROR_MORE_DATA, 4);
  if (ansi) {
    runtime.data.set(encoded, nameAddress);
    runtime.data[nameAddress + encoded.length] = 0;
  } else {
    for (let i = 0; i < child.name.length; i++)
      runtime.guestMemory.write(nameAddress + i * 2, child.name.charCodeAt(i), 2);
    runtime.guestMemory.write(nameAddress + child.name.length * 2, 0, 2);
  }
  return response(ERROR_SUCCESS, 4);
}
function regEnumKeyEx(runtime, argument, ansi) {
  const status = regEnumKey(runtime, argument, ansi);
  if (status.result !== ERROR_SUCCESS) return { result: status.result, argc: 9 };
  // The Ex form's trailing outputs are (class, classSize, lastWriteTime); the
  // runtime has no per-key class, so the class is empty and the time is the
  // shared process file time.
  const classAddress = argument(4) >>> 0;
  const classSizeAddress = argument(5) >>> 0;
  const timeAddress = argument(6) >>> 0;
  if (classSizeAddress) {
    runtime.check(classSizeAddress, 4, true);
    runtime.write32(classSizeAddress, 0);
  }
  if (classAddress) {
    runtime.check(classAddress, ansi ? 1 : 2, true);
    runtime.guestMemory.write(classAddress, 0, 1);
  }
  if (timeAddress) {
    runtime.check(timeAddress, 8, true);
    runtime.write32(timeAddress, 0);
    runtime.write32(timeAddress + 4, 0);
  }
  return { result: ERROR_SUCCESS, argc: 9 };
}

// ---------------------------------------------------------------------------
// The advapi32 security helpers a GUI tool calls when it builds a SID or a
// security descriptor. The runtime has exactly one guest identity, so these
// describe that identity precisely instead of fabricating an object.
// A SID is Revision, SubAuthorityCount, six authority bytes, then the
// sub-authorities as little-endian DWORDs. AllocateAndInitializeSid builds one
// from the caller's authority and sub-authority values.
const SECURITY_NULL_SID_AUTHORITY = 0;
const SECURITY_NT_SID_AUTHORITY = 5;
function allocateAndInitializeSid(r, a) {
  const identifierAuthority = a(0) >>> 0;
  const subAuthorityCount = a(1) >>> 0;
  if (subAuthorityCount < 1 || subAuthorityCount > 8) return response(ERROR_INVALID_PARAMETER, 11);
  const output = a(10);
  if (!output) return response(ERROR_INVALID_PARAMETER, 11);
  // A six-byte big-endian authority is read from guest memory.
  r.check(identifierAuthority, 6);
  let authority = 0n;
  for (let i = 0; i < 6; i++)
    authority = (authority << 8n) | BigInt(r.data[identifierAuthority + i]);
  r.check(a(2), 12);
  const subAuthorities = [];
  for (let i = 0; i < subAuthorityCount; i++) subAuthorities.push(r.read32(a(2) + i * 4) >>> 0);
  if (authority > 0xffffffffn) return response(ERROR_INVALID_PARAMETER, 11);
  const size = 8 + subAuthorityCount * 4;
  const pointer = r.allocate(size);
  r.data.fill(0, pointer, pointer + 8);
  r.data[pointer] = 1;
  r.data[pointer + 1] = subAuthorityCount;
  const view = new DataView(r.data.buffer, r.data.byteOffset);
  view.setUint16(pointer + 6, Number(authority), false);
  subAuthorities.forEach((value, index) => view.setUint32(pointer + 8 + index * 4, value, true));
  r.check(output, 4, true);
  r.write32(output, pointer);
  return response(ERROR_SUCCESS, 11);
}
function sidLength(r, a) {
  const pointer = a(0) >>> 0;
  if (!pointer) return response(ERROR_INVALID_SID, 1);
  try {
    r.check(pointer, 8);
  } catch {
    return response(ERROR_INVALID_SID, 1);
  }
  const count = r.data[pointer + 1];
  if (r.data[pointer] !== 1 || count > 15) return response(ERROR_INVALID_SID, 1);
  return { result: 8 + count * 4, argc: 1 };
}
function copySid(r, a) {
  const length = a(0) >>> 0;
  const source = a(1) >>> 0;
  const target = a(2);
  const measured = sidLength(r, () => source);
  if (typeof measured !== 'number') return { result: measured.result, argc: 3 };
  if (length < measured || !target) return response(ERROR_INSUFFICIENT_BUFFER, 3);
  r.check(source, measured);
  r.check(target, measured, true);
  r.data.copyWithin(target, source, source + measured);
  return response(ERROR_SUCCESS, 3);
}
function equalSid(r, a) {
  const first = a(0) >>> 0,
    second = a(1) >>> 0;
  if (!first || !second) return response(ERROR_INVALID_SID, 2);
  try {
    r.check(first, 8);
    r.check(second, 8);
  } catch {
    return response(ERROR_INVALID_SID, 2);
  }
  const length = r.data[first + 1] * 4 + 8;
  const other = r.data[second + 1] * 4 + 8;
  if (length !== other) return { result: 0, argc: 2 };
  for (let i = 0; i < length; i++)
    if (r.data[first + i] !== r.data[second + i]) return { result: 0, argc: 2 };
  return { result: 1, argc: 2 };
}
// GetUserNameA/W reports the guest process's own user name, which is the
// account the isolated registry and SID describe.
function getUserName(r, a, wide) {
  const name = processUserName;
  const buffer = a(0);
  const sizeAddress = a(1);
  if (!sizeAddress) return response(ERROR_INVALID_PARAMETER, 2);
  r.check(sizeAddress, 4, true);
  const encoded = wide
    ? Uint8Array.from([...name].flatMap((ch) => [ch.charCodeAt(0) & 0xff, ch.charCodeAt(0) >> 8]))
    : encodeAnsi(name).bytes;
  const needed = wide ? (name.length + 1) * 2 : encoded.length + 1;
  const capacity = r.read32(sizeAddress) >>> 0;
  if (!buffer || capacity < needed) {
    r.write32(sizeAddress, needed);
    return response(ERROR_INSUFFICIENT_BUFFER, 2);
  }
  r.check(buffer, needed, true);
  if (wide) {
    for (let i = 0; i <= name.length; i++)
      r.guestMemory.write(buffer + i * 2, i === name.length ? 0 : name.charCodeAt(i), 2);
  } else {
    r.data.set(encoded, buffer);
    r.data[buffer + encoded.length] = 0;
  }
  r.write32(sizeAddress, wide ? name.length : encoded.length);
  return response(ERROR_SUCCESS, 2);
}
const processUserName = 'WineBrowser';
const ERROR_INVALID_SID = 1307;
// A SECURITY_DESCRIPTOR is Revision, Sbz1, Control, then four DWORD offsets.
// The runtime models the all-access descriptor an isolated guest owns.
const SECURITY_DESCRIPTOR_REVISION = 1;
function initializeSecurityDescriptor(r, a) {
  const pointer = a(0) >>> 0;
  const revision = a(1) >>> 0;
  if (!pointer || revision !== SECURITY_DESCRIPTOR_REVISION)
    return response(ERROR_INVALID_PARAMETER, 2);
  r.check(pointer, 20, true);
  r.data.fill(0, pointer, pointer + 20);
  r.data[pointer] = SECURITY_DESCRIPTOR_REVISION;
  return response(ERROR_SUCCESS, 2);
}
function securityDescriptorField(r, a, control) {
  const pointer = a(0) >>> 0;
  if (!pointer) return response(ERROR_INVALID_PARAMETER, 3);
  r.check(pointer, 20, true);
  r.data[pointer + 2] |= control;
  return response(ERROR_SUCCESS, 3);
}

function regDeleteKeyW(runtime, argument) {
  const state = stateFor(runtime);
  const parent = keyFor(argument(0), state);
  if (!parent) return response(ERROR_INVALID_HANDLE, 2);
  if (parent.node.deletePending) return response(ERROR_KEY_DELETED, 2);
  const path = readPath(runtime, argument(1));
  if (!path?.length) return response(ERROR_INVALID_PARAMETER, 2);
  let current = parent.node;
  for (let index = 0; index < path.length - 1; index++) {
    current = childOf(current, path[index]);
    if (!current || current.deletePending) return response(ERROR_FILE_NOT_FOUND, 2);
  }
  const key = childOf(current, path.at(-1));
  if (!key || key.deletePending) return response(ERROR_FILE_NOT_FOUND, 2);
  if (key === state.roots.get(0x80000001)) return response(ERROR_ACCESS_DENIED, 2);
  if (key.children.size) return response(ERROR_ACCESS_DENIED, 2);
  key.deletePending = true;
  if (key.openHandles === 0) removeDeletedNode(state, key);
  return response(ERROR_SUCCESS, 2);
}

function regCloseKey(runtime, argument) {
  const state = stateFor(runtime);
  const handle = argument(0) >>> 0;
  if (state.roots.has(handle)) return response(ERROR_SUCCESS, 1);
  return response(releaseHandle(state, handle) ? ERROR_SUCCESS : ERROR_INVALID_HANDLE, 1);
}

/**
 * Process-local key/value storage, never persisted. Security descriptors, ACLs,
 * transactions, performance hives, and WOW64 view redirection are outside the
 * provider boundary; parent create/delete operations therefore do not model ACLs.
 */
// ---------------------------------------------------------------------------
// Process token and file security. The guest runs in one isolated virtual
// process with a fixed identity; there is no logon session, no privilege list
// to enable and no ACL store behind the package volume. These answer from that
// model rather than fabricating a security descriptor, so a caller that only
// wants an access mask or a probe of its own privileges proceeds, while a
// request to read or write real security data fails explicitly.

// The process token handle is a real entry in the handle table so CloseHandle
// resolves it; its rights are the fixed set the runtime grants.
const TOKEN_HANDLE = 0x50000000;
function openProcessToken(r, a) {
  const process = a(0) >>> 0;
  const desired = a(1) >>> 0;
  const out = a(2);
  if (process !== 0xffffffff && !r.processes?.has?.(process)) return fail(r, 6, 3); // ERROR_INVALID_HANDLE
  if (!out) return fail(r, 87, 3);
  try {
    r.check(out, 4, true);
  } catch {
    return fail(r, 998, 3); // ERROR_NOACCESS
  }
  // Tokens are handles the same way files are; store one shared entry.
  r.handles.set(TOKEN_HANDLE, { kind: 'process-token', access: 0x000f01ff });
  r.write32(out, TOKEN_HANDLE);
  void desired; // Every access the runtime models is granted.
  r.lastError = 0;
  return ok(1, 3);
}

// LookupPrivilegeValueW resolves one of the named privileges the isolated
// process holds. A name it does not model fails with ERROR_NO_SUCH_PRIVILEGE.
const PRIVILEGES = new Map([
  ['SeShutdownPrivilege', 19],
  ['SeChangeNotifyPrivilege', 23],
  ['SeUndockPrivilege', 24],
  ['SeIncreaseWorkingSetPrivilege', 25],
  ['SeTimeZonePrivilege', 26],
]);
function lookupPrivilegeValue(r, a, wide) {
  const name = wide ? r.wideString(a(2)) : r.string(a(2));
  const out = a(1);
  const luid = PRIVILEGES.get(name);
  if (luid === undefined) return fail(r, 1313, 3); // ERROR_NO_SUCH_PRIVILEGE
  if (!out) return fail(r, 87, 3);
  try {
    r.check(out, 8, true);
  } catch {
    return fail(r, 998, 3);
  }
  // LUID: LowPart then HighPart, both little-endian.
  r.write32(out, luid);
  r.write32(out + 4, 0);
  r.lastError = 0;
  return ok(1, 3);
}

// AdjustTokenPrivileges records which modelled privileges the caller asked to
// enable or disable. GetLastError reports ERROR_NOT_ALL_ASSIGNED when a
// requested privilege is not one this process holds, matching Win32.
function adjustTokenPrivileges(r, a) {
  const token = a(0) >>> 0;
  const disableAll = a(1) >>> 0;
  const newState = a(2);
  const count = a(3) >>> 0;
  const previous = a(4);
  const returned = a(5);
  if (token !== TOKEN_HANDLE) return fail(r, 6, 6);
  r.tokenPrivileges ??= new Set([23, 19, 24, 25, 26]);
  if (count > 64 || newState) {
    // A caller that changes the set is accepted when every LUID is modelled;
    // the adjustment is recorded so a later query sees it.
    if (newState) {
      try {
        r.check(newState, count * 12, false);
      } catch {
        return fail(r, 998, 6);
      }
      let missing = false;
      for (let i = 0; i < count; i++) {
        const luid = r.read32(newState + i * 12) >>> 0;
        const attributes = r.read32(newState + i * 12 + 4) >>> 0;
        if (!r.tokenPrivileges.has(luid)) {
          missing = true;
          continue;
        }
        const enabled = disableAll ? false : !!(attributes & 0x2);
        if (enabled) r.enabledPrivileges?.add(luid);
        else r.enabledPrivileges?.delete(luid);
      }
      if (previous) {
        try {
          r.check(previous, count * 12, true);
          r.data.fill(0, previous, previous + count * 12);
        } catch {
          return fail(r, 998, 6);
        }
      }
      if (returned) {
        try {
          r.check(returned, 4, true);
          r.write32(returned, count);
        } catch {
          return fail(r, 998, 6);
        }
      }
      r.lastError = missing ? 1300 : 0; // ERROR_NOT_ALL_ASSIGNED
      return ok(1, 6);
    }
    return fail(r, 87, 6);
  }
  r.lastError = 0;
  return ok(1, 6);
}

// GetFileSecurityW/SetFileSecurityW. The virtual volume stores no ACLs, so a
// query reports the requested buffer size (or the too-small error) and a write
// is refused rather than pretending a descriptor was stored.
const SECURITY_INFORMATION_VALID = 0x0000003f;
function getFileSecurity(r, a, wide) {
  const path = wide ? r.wideString(a(0)) : r.string(a(0));
  const requested = a(1) >>> 0;
  const length = a(2) >>> 0;
  const needed = a(3);
  let resolved;
  try {
    resolved = resolveGuestPath(path, r.cwd);
  } catch {
    return fail(r, 3, 5);
  }
  if (requested & ~SECURITY_INFORMATION_VALID) return fail(r, 87, 5);
  if (!r.files.has(resolved) && !r.virtualDirectories?.has(resolved + '/')) return fail(r, 2, 5);
  // A self-relative SECURITY_DESCRIPTOR for the fixed identity: control word,
  // owner SID offset, then the SID. Report its size so a caller can size its
  // buffer before asking again.
  const size = 20 + 8 + 5 * 4;
  if (needed) {
    try {
      r.check(needed, 4, true);
      r.write32(needed, size);
    } catch {
      return fail(r, 998, 5);
    }
  }
  if (length < size) return fail(r, 122, 5); // ERROR_INSUFFICIENT_BUFFER
  r.lastError = 0;
  return ok(1, 5);
}
function setFileSecurity(r, a, wide) {
  const path = wide ? r.wideString(a(0)) : r.string(a(0));
  const requested = a(1) >>> 0;
  let resolved;
  try {
    resolved = resolveGuestPath(path, r.cwd);
  } catch {
    return fail(r, 3, 3);
  }
  if (requested & ~SECURITY_INFORMATION_VALID) return fail(r, 87, 3);
  if (!r.files.has(resolved) && !r.virtualDirectories?.has(resolved + '/')) return fail(r, 2, 3);
  // The descriptor pointer must be readable, but there is nowhere to store it.
  try {
    r.check(a(2), 20, false);
  } catch {
    return fail(r, 998, 3);
  }
  return fail(r, 5, 3); // ERROR_ACCESS_DENIED: no ACL store exists
}

export const registryApis = {
  'advapi32.dll!OpenProcessToken': openProcessToken,
  'advapi32.dll!LookupPrivilegeValueW': (r, a) => lookupPrivilegeValue(r, a, true),
  'advapi32.dll!LookupPrivilegeValueA': (r, a) => lookupPrivilegeValue(r, a, false),
  'advapi32.dll!AdjustTokenPrivileges': adjustTokenPrivileges,
  'advapi32.dll!GetFileSecurityW': (r, a) => getFileSecurity(r, a, true),
  'advapi32.dll!GetFileSecurityA': (r, a) => getFileSecurity(r, a, false),
  'advapi32.dll!SetFileSecurityW': (r, a) => setFileSecurity(r, a, true),
  'advapi32.dll!SetFileSecurityA': (r, a) => setFileSecurity(r, a, false),
  'advapi32.dll!RegCreateKeyExA': regCreateKeyExA,
  'advapi32.dll!RegCreateKeyExW': regCreateKeyExW,
  'advapi32.dll!RegCreateKeyA': (r, a) => regCreateKey(r, a, true),
  'advapi32.dll!RegCreateKeyW': (r, a) => regCreateKey(r, a, false),
  'advapi32.dll!RegOpenKeyA': (r, a) => regOpenKey(r, a, true),
  'advapi32.dll!RegOpenKeyW': (r, a) => regOpenKey(r, a, false),
  'advapi32.dll!RegOpenKeyExA': regOpenKeyExA,
  'advapi32.dll!RegOpenKeyExW': regOpenKeyExW,
  'advapi32.dll!RegQueryValueExA': regQueryValueExA,
  'advapi32.dll!RegQueryValueExW': regQueryValueExW,
  'advapi32.dll!RegSetValueExA': regSetValueExA,
  'advapi32.dll!RegSetValueExW': regSetValueExW,
  'advapi32.dll!RegDeleteValueA': (r, a) => regDeleteValue(r, a, true),
  'advapi32.dll!RegDeleteValueW': (r, a) => regDeleteValue(r, a, false),
  'advapi32.dll!RegEnumValueA': (r, a) => regEnumValue(r, a, true),
  'advapi32.dll!RegEnumValueW': (r, a) => regEnumValue(r, a, false),
  'advapi32.dll!RegQueryInfoKeyA': (r, a) => regQueryInfoKey(r, a, true),
  'advapi32.dll!RegQueryInfoKeyW': (r, a) => regQueryInfoKey(r, a, false),
  'advapi32.dll!AllocateAndInitializeSid': allocateAndInitializeSid,
  'advapi32.dll!GetLengthSid': sidLength,
  'advapi32.dll!CopySid': copySid,
  'advapi32.dll!EqualSid': equalSid,
  'advapi32.dll!GetUserNameA': (r, a) => getUserName(r, a, false),
  'advapi32.dll!GetUserNameW': (r, a) => getUserName(r, a, true),
  'advapi32.dll!InitializeSecurityDescriptor': initializeSecurityDescriptor,
  'advapi32.dll!SetSecurityDescriptorDacl': (r, a) => securityDescriptorField(r, a, 0x0004),
  'advapi32.dll!SetSecurityDescriptorOwner': (r, a) => securityDescriptorField(r, a, 0x0001),
  'advapi32.dll!RegDeleteKeyA': regDeleteKeyA,
  'advapi32.dll!RegDeleteKeyW': regDeleteKeyW,
  'advapi32.dll!RegEnumKeyA': (r, a) => regEnumKey(r, a, true),
  'advapi32.dll!RegEnumKeyW': (r, a) => regEnumKey(r, a, false),
  'advapi32.dll!RegEnumKeyExA': (r, a) => regEnumKeyEx(r, a, true),
  'advapi32.dll!RegEnumKeyExW': (r, a) => regEnumKeyEx(r, a, false),
  'advapi32.dll!RegCloseKey': regCloseKey,
};

// The NT registry adapter shares these exact nodes, handles, access checks and
// quotas with Advapi32. Only the wire ABI and result status differ.
export const registryStore = Object.freeze({
  stateFor,
  keyFor,
  createHandle,
  releaseHandle,
  openPath,
  createPath,
  supportedAccess,
  accessDenied,
  storeValue,
  deleteValue,
  KEY_QUERY_VALUE,
  KEY_SET_VALUE,
  MAX_KEY_NAME_LENGTH,
  MAX_VALUE_NAME_LENGTH,
  MAX_VALUE_BYTES,
});
