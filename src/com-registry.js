import { registryStore } from './win32-registry.js';

export function registryString(node, name = '', maxBytes = 65536) {
  const value = node?.values.get(name.toUpperCase());
  if (!value || value.type !== 1 || value.data.length % 2 || value.data.length > maxBytes)
    return null;
  const text = new TextDecoder('utf-16le', { ignoreBOM: true }).decode(value.data);
  const end = text.indexOf('\0');
  return end < 0 ? text : text.slice(0, end);
}

export function classRegistryKey(r, path) {
  const registry = registryStore.stateFor(r);
  // This runtime has an explicit HKCR store; also accept conventional per-user
  // and machine registrations. No host-machine registry is read.
  for (const [root, prefix] of [
    [0x80000000, []],
    [0x80000001, ['Software', 'Classes']],
    [0x80000002, ['Software', 'Classes']],
  ]) {
    const node = registryStore.openPath(registry.roots.get(root), [...prefix, ...path]);
    if (node) return node;
  }
  return null;
}
