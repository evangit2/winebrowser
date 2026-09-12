const ERROR_SUCCESS = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_MORE_DATA = 234;
const ERROR_NOT_ENOUGH_MEMORY = 8;
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
  state = {
    roots,
    handles: new Map(),
    nextHandle: 0x51000000,
    keyCount: 0,
    valueCount: 0,
    totalValueBytes: 0,
  };
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

function readPath(runtime, address, allowNull = false) {
  if (!address) return allowNull ? [] : null;
  const value = runtime.wideString(address);
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

function regCreateKeyExW(runtime, argument) {
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
  const path = readPath(runtime, subkeyAddress);
  if (!path) return response(ERROR_INVALID_PARAMETER, 9);
  const className = classAddress ? runtime.wideString(classAddress) : '';
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

function regOpenKeyExW(runtime, argument) {
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
  const path = readPath(runtime, subkeyAddress, true);
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

function regQueryValueExW(runtime, argument) {
  const state = stateFor(runtime);
  const opened = keyFor(argument(0), state);
  if (!opened) return response(ERROR_INVALID_HANDLE, 6);
  if (opened.node.deletePending) return response(ERROR_KEY_DELETED, 6);
  const valueName = runtime.wideString(argument(1));
  const reserved = argument(2);
  const typeAddress = argument(3);
  const dataAddress = argument(4);
  const sizeAddress = argument(5);
  if (reserved || (dataAddress && !sizeAddress)) return response(ERROR_INVALID_PARAMETER, 6);
  if (valueName.length > MAX_VALUE_NAME_LENGTH) return response(ERROR_INVALID_PARAMETER, 6);
  if (accessDenied(opened, KEY_QUERY_VALUE)) return response(ERROR_ACCESS_DENIED, 6);

  const value = opened.node.values.get(valueName.toUpperCase());
  if (!value) return response(ERROR_FILE_NOT_FOUND, 6);
  if (typeAddress) runtime.check(typeAddress, 4, true);
  if (sizeAddress) runtime.check(sizeAddress, 4, true);
  if (!dataAddress) {
    if (typeAddress) writeOutput(runtime, typeAddress, value.type);
    if (sizeAddress) writeOutput(runtime, sizeAddress, value.data.byteLength);
    return response(ERROR_SUCCESS, 6);
  }

  const capacity = runtime.read32(sizeAddress);
  if (capacity < value.data.byteLength) {
    if (typeAddress) writeOutput(runtime, typeAddress, value.type);
    writeOutput(runtime, sizeAddress, value.data.byteLength);
    return response(ERROR_MORE_DATA, 6);
  }
  runtime.check(dataAddress, value.data.byteLength, true);
  if (typeAddress) writeOutput(runtime, typeAddress, value.type);
  runtime.data.set(value.data, dataAddress);
  writeOutput(runtime, sizeAddress, value.data.byteLength);
  return response(ERROR_SUCCESS, 6);
}

function regSetValueExW(runtime, argument) {
  const state = stateFor(runtime);
  const opened = keyFor(argument(0), state);
  if (!opened) return response(ERROR_INVALID_HANDLE, 6);
  if (opened.node.deletePending) return response(ERROR_KEY_DELETED, 6);
  const valueName = runtime.wideString(argument(1));
  const reserved = argument(2);
  const type = argument(3) >>> 0;
  const dataAddress = argument(4) >>> 0;
  const byteCount = argument(5) >>> 0;
  if (reserved) return response(ERROR_INVALID_PARAMETER, 6);
  if (valueName.length > MAX_VALUE_NAME_LENGTH) return response(ERROR_INVALID_PARAMETER, 6);
  if (accessDenied(opened, KEY_SET_VALUE)) return response(ERROR_ACCESS_DENIED, 6);
  if (byteCount && !dataAddress) return response(ERROR_INVALID_PARAMETER, 6);
  if (byteCount > MAX_VALUE_BYTES) return response(ERROR_NOT_ENOUGH_MEMORY, 6);
  const oldValue = opened.node.values.get(valueName.toUpperCase());
  if (
    (!oldValue && state.valueCount >= MAX_VALUES) ||
    state.totalValueBytes - (oldValue?.data.byteLength ?? 0) + byteCount > MAX_TOTAL_VALUE_BYTES
  )
    return response(ERROR_NOT_ENOUGH_MEMORY, 6);
  if (byteCount) runtime.check(dataAddress, byteCount);
  const bytes = byteCount
    ? runtime.data.slice(dataAddress, dataAddress + byteCount)
    : new Uint8Array();
  if (!oldValue) state.valueCount++;
  state.totalValueBytes += byteCount - (oldValue?.data.byteLength ?? 0);
  opened.node.values.set(valueName.toUpperCase(), { name: valueName, type, data: bytes });
  return response(ERROR_SUCCESS, 6);
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
  'advapi32.dll!RegCreateKeyExW': regCreateKeyExW,
  'advapi32.dll!RegOpenKeyExW': regOpenKeyExW,
  'advapi32.dll!RegQueryValueExW': regQueryValueExW,
  'advapi32.dll!RegSetValueExW': regSetValueExW,
  'advapi32.dll!RegDeleteKeyW': regDeleteKeyW,
  'advapi32.dll!RegCloseKey': regCloseKey,
};
