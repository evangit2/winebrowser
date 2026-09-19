import { PROCESS_USER_SID } from './process-identity.js';
import { decodeAnsi, encodeAnsi } from './encoding.js';

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
  return (mask & ~SUPPORTED_ACCESS) === 0;
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

function regOpenKeyA(runtime, argument) {
  const resultAddress = argument(2);
  if (!checkedOutput(runtime, resultAddress)) return response(ERROR_INVALID_PARAMETER, 3);
  const subkeyAddress = argument(1);
  if (!subkeyAddress || guestString(runtime, subkeyAddress, true) === '') {
    writeOutput(runtime, resultAddress, argument(0));
    return response(ERROR_SUCCESS, 3);
  }
  const args = [argument(0), subkeyAddress, 0, SUPPORTED_ACCESS, resultAddress];
  const result = regOpenKeyExA(runtime, (index) => args[index]);
  return response(result.result, 3);
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

function regEnumValueA(runtime, argument) {
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
  const name = encodeAnsi(value.name).bytes;
  const data = unicodeValueData(value.type, value.data);
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
    if (capacity <= name.length) {
      status = ERROR_MORE_DATA;
      if (capacity) {
        runtime.check(nameAddress, capacity, true);
        runtime.data.set(name.subarray(0, capacity - 1), nameAddress);
        runtime.data[nameAddress + capacity - 1] = 0;
      }
    } else {
      runtime.check(nameAddress, name.length + 1, true);
      runtime.data.set(name, nameAddress);
      runtime.data[nameAddress + name.length] = 0;
      writeOutput(runtime, nameSizeAddress, name.length);
    }
  }
  if (typeAddress) writeOutput(runtime, typeAddress, value.type);
  if (dataSizeAddress) writeOutput(runtime, dataSizeAddress, data.length);
  return response(status, 8);
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
export const registryApis = {
  'advapi32.dll!RegCreateKeyExA': regCreateKeyExA,
  'advapi32.dll!RegCreateKeyExW': regCreateKeyExW,
  'advapi32.dll!RegOpenKeyA': regOpenKeyA,
  'advapi32.dll!RegOpenKeyExA': regOpenKeyExA,
  'advapi32.dll!RegOpenKeyExW': regOpenKeyExW,
  'advapi32.dll!RegQueryValueExA': regQueryValueExA,
  'advapi32.dll!RegQueryValueExW': regQueryValueExW,
  'advapi32.dll!RegSetValueExA': regSetValueExA,
  'advapi32.dll!RegSetValueExW': regSetValueExW,
  'advapi32.dll!RegEnumValueA': regEnumValueA,
  'advapi32.dll!RegDeleteKeyW': regDeleteKeyW,
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
  KEY_QUERY_VALUE,
  KEY_SET_VALUE,
  MAX_KEY_NAME_LENGTH,
  MAX_VALUE_NAME_LENGTH,
  MAX_VALUE_BYTES,
});
