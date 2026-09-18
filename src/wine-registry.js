import { registryStore } from './win32-registry.js';

const SUCCESS = 0;
const BUFFER_OVERFLOW = 0x80000005;
const ACCESS_VIOLATION = 0xc0000005;
const INVALID_HANDLE = 0xc0000008;
const INVALID_PARAMETER = 0xc000000d;
const NO_MEMORY = 0xc0000017;
const ACCESS_DENIED = 0xc0000022;
const BUFFER_TOO_SMALL = 0xc0000023;
const OBJECT_NAME_NOT_FOUND = 0xc0000034;
const OBJECT_PATH_NOT_FOUND = 0xc000003a;
const KEY_DELETED = 0xc000017c;

const HKLM = 0x80000002;
const HKU = 0x80000003;
const KEY_CREATE_SUB_KEY = 0x0004;
const KEY_ALL_ACCESS = 0x000f003f;
const MAXIMUM_ALLOWED = 0x02000000;
const OBJ_CASE_INSENSITIVE = 0x40;
const OBJ_OPENIF = 0x80;
const MAX_PATH_PARTS = 32;

function checked(runtime, address, length, write = false) {
  try {
    if (!address) return false;
    runtime.check(address, length, write);
    return true;
  } catch {
    return false;
  }
}

function unicodeString(runtime, address, maxLength) {
  if (!checked(runtime, address, 8)) return { status: ACCESS_VIOLATION };
  const length = runtime.view.getUint16(address, true);
  const maximumLength = runtime.view.getUint16(address + 2, true);
  const buffer = runtime.read32(address + 4);
  if (length & 1 || length > maximumLength || length > maxLength * 2)
    return { status: INVALID_PARAMETER };
  if (length && !checked(runtime, buffer, length)) return { status: ACCESS_VIOLATION };
  let text = '';
  for (let offset = 0; offset < length; offset += 2)
    text += String.fromCharCode(runtime.view.getUint16(buffer + offset, true));
  return { text };
}

function objectPath(runtime, address) {
  if (!checked(runtime, address, 24)) return { status: ACCESS_VIOLATION };
  if (runtime.read32(address) !== 24) return { status: INVALID_PARAMETER };
  const rootHandle = runtime.read32(address + 4);
  const nameAddress = runtime.read32(address + 8);
  const attributes = runtime.read32(address + 12);
  if (
    attributes & ~(OBJ_CASE_INSENSITIVE | OBJ_OPENIF) ||
    runtime.read32(address + 16) ||
    runtime.read32(address + 20)
  )
    return { status: INVALID_PARAMETER };
  const name = unicodeString(
    runtime,
    nameAddress,
    MAX_PATH_PARTS * (registryStore.MAX_KEY_NAME_LENGTH + 1),
  );
  if (name.status) return name;
  const state = registryStore.stateFor(runtime);
  let root;
  let path = name.text;
  if (path.startsWith('\\')) {
    if (rootHandle) return { status: INVALID_PARAMETER };
    const parts = path.slice(1).split('\\');
    if (parts[0]?.toUpperCase() !== 'REGISTRY') return { status: OBJECT_PATH_NOT_FOUND };
    const hive = parts[1]?.toUpperCase();
    const predefined = hive === 'MACHINE' ? HKLM : hive === 'USER' ? HKU : 0;
    if (!predefined) return { status: OBJECT_PATH_NOT_FOUND };
    root = registryStore.keyFor(predefined, state);
    path = parts.slice(2).join('\\');
  } else {
    // Win32 HKEY pseudo roots are not object-manager handles. Native callers
    // must first open \\Registry\\Machine or \\Registry\\User and use that handle.
    root = state.handles.get(rootHandle >>> 0);
    if (!root) return { status: INVALID_HANDLE };
  }
  const parts = path ? path.split('\\') : [];
  if (
    parts.length > MAX_PATH_PARTS ||
    parts.some((part) => !part || part.length > registryStore.MAX_KEY_NAME_LENGTH)
  )
    return { status: INVALID_PARAMETER };
  return { state, root, parts };
}

function desiredAccess(mask) {
  if (mask & MAXIMUM_ALLOWED) return mask === MAXIMUM_ALLOWED ? KEY_ALL_ACCESS : null;
  return (mask & ~KEY_ALL_ACCESS) === 0 ? mask : null;
}

function openOrCreate(runtime, argument, create) {
  const output = argument(0);
  if (!checked(runtime, output, 4, true)) return ACCESS_VIOLATION;
  runtime.write32(output, 0);
  const access = desiredAccess(argument(1) >>> 0);
  if (access === null) return INVALID_PARAMETER;
  const path = objectPath(runtime, argument(2));
  if (path.status) return path.status;
  if (path.root.node.deletePending) return KEY_DELETED;
  if (create) {
    if (argument(3) || argument(5)) return INVALID_PARAMETER; // TitleIndex and create options.
    if (argument(6) && !checked(runtime, argument(6), 4, true)) return ACCESS_VIOLATION;
  }

  let node;
  let created = false;
  if (create) {
    const className = argument(4)
      ? unicodeString(runtime, argument(4), registryStore.MAX_KEY_NAME_LENGTH)
      : { text: '' };
    if (className.status) return className.status;
    const parent = path.parts.length
      ? registryStore.openPath(path.root.node, path.parts.slice(0, -1))
      : path.root.node;
    if (!parent) return OBJECT_NAME_NOT_FOUND;
    if (
      path.parts.length &&
      !registryStore.openPath(parent, path.parts.slice(-1)) &&
      registryStore.accessDenied(path.root, KEY_CREATE_SUB_KEY)
    )
      return ACCESS_DENIED;
    const outcome = registryStore.createPath(
      path.state,
      0,
      parent,
      path.parts.slice(-1),
      className.text,
    );
    if (outcome.error)
      return outcome.error === 8 ? NO_MEMORY : outcome.error === 1018 ? KEY_DELETED : ACCESS_DENIED;
    node = outcome.node;
    created = outcome.created;
  } else {
    node = registryStore.openPath(path.root.node, path.parts);
    if (!node) return OBJECT_NAME_NOT_FOUND;
  }
  if (node.deletePending) return KEY_DELETED;
  const handle = registryStore.createHandle(path.state, node, access);
  if (!handle) return NO_MEMORY;
  runtime.write32(output, handle);
  if (create && argument(6)) runtime.write32(argument(6), created ? 1 : 2);
  return SUCCESS;
}

function keyValue(runtime, handle, requiredAccess) {
  const state = registryStore.stateFor(runtime);
  const opened = state.handles.get(handle >>> 0);
  if (!opened) return { status: INVALID_HANDLE };
  if (opened.node.deletePending) return { status: KEY_DELETED };
  if (registryStore.accessDenied(opened, requiredAccess)) return { status: ACCESS_DENIED };
  return { state, opened };
}

function queryValue(runtime, argument) {
  const key = keyValue(runtime, argument(0), registryStore.KEY_QUERY_VALUE);
  if (key.status) return key.status;
  const name = unicodeString(runtime, argument(1), registryStore.MAX_VALUE_NAME_LENGTH);
  if (name.status) return name.status;
  if (argument(2) !== 2) return INVALID_PARAMETER; // KeyValuePartialInformation.
  const resultLength = argument(5);
  if (!checked(runtime, resultLength, 4, true)) return ACCESS_VIOLATION;
  const value = key.opened.node.values.get(name.text.toUpperCase());
  if (!value) return OBJECT_NAME_NOT_FOUND;
  const capacity = argument(4) >>> 0;
  const output = argument(3);
  if (capacity && !checked(runtime, output, capacity, true)) return ACCESS_VIOLATION;
  const required = 12 + value.data.length;
  runtime.write32(resultLength, required);
  if (capacity) {
    const header = new Uint8Array(12);
    const view = new DataView(header.buffer);
    view.setUint32(4, value.type, true);
    view.setUint32(8, value.data.length, true);
    runtime.data.set(header.subarray(0, Math.min(capacity, 12)), output);
    if (capacity > 12)
      runtime.data.set(
        value.data.subarray(0, Math.min(capacity - 12, value.data.length)),
        output + 12,
      );
  }
  if (capacity < 12) return BUFFER_TOO_SMALL;
  return capacity < required ? BUFFER_OVERFLOW : SUCCESS;
}

function setValue(runtime, argument) {
  const key = keyValue(runtime, argument(0), registryStore.KEY_SET_VALUE);
  if (key.status) return key.status;
  const name = unicodeString(runtime, argument(1), registryStore.MAX_VALUE_NAME_LENGTH);
  if (name.status) return name.status;
  if (argument(2)) return INVALID_PARAMETER; // TitleIndex.
  const byteCount = argument(5) >>> 0;
  if (byteCount > registryStore.MAX_VALUE_BYTES) return NO_MEMORY;
  const address = argument(4);
  if (byteCount && !checked(runtime, address, byteCount)) return ACCESS_VIOLATION;
  const bytes = byteCount ? runtime.data.slice(address, address + byteCount) : new Uint8Array();
  const result = registryStore.storeValue(
    key.state,
    key.opened,
    name.text,
    argument(3) >>> 0,
    bytes,
  );
  return result === 0 ? SUCCESS : result === 8 ? NO_MEMORY : INVALID_PARAMETER;
}

export function closeRegistryHandle(runtime, handle) {
  const value = handle >>> 0;
  if ((value & 0xff000000) !== 0x51000000) return null;
  return registryStore.releaseHandle(registryStore.stateFor(runtime), value)
    ? SUCCESS
    : INVALID_HANDLE;
}

export const registryNtServices = {
  NtCreateKey: { argc: 7, call: (r, a) => openOrCreate(r, a, true) },
  NtOpenKey: { argc: 3, call: (r, a) => openOrCreate(r, a, false) },
  NtOpenKeyEx: {
    argc: 4,
    call: (r, a) => (a(3) ? INVALID_PARAMETER : openOrCreate(r, a, false)),
  },
  NtQueryValueKey: { argc: 6, call: queryValue },
  NtSetValueKey: { argc: 6, call: setValue },
};
