// User32 and SHLWAPI export these functions through KernelBase in Wine. Keep
// their NLS, code-page, UTF-16 and path behavior in the native guest bodies.
async function forward(r, a, symbol, argc) {
  let module = r.graph.findLoaded('kernelbase.dll');
  if (!module) {
    await r.loadLibrary('kernelbase.dll');
    module = r.graph.findLoaded('kernelbase.dll');
  }
  if (!module?.mapped || module.host)
    throw Error(`${symbol} requires the native Wine kernelbase.dll component`);
  const address = await r.resolveExport(module, symbol);
  const args = Array.from({ length: argc }, (_, index) => a(index));
  return { result: await r.callGuest(address, args), argc };
}

export const nativeForwarderApis = {};
nativeForwarderApis['user32.dll!CharPrevExA'] = (r, a) => forward(r, a, 'CharPrevExA', 4);
for (const suffix of ['A', 'W'])
  nativeForwarderApis[`kernel32.dll!CreateProcess${suffix}`] = (r, a) =>
    forward(r, a, `CreateProcess${suffix}`, 10);
for (const [name, argc] of [
  ['PathCanonicalize', 2],
  ['PathCombine', 3],
  ['PathSkipRoot', 1],
])
  for (const suffix of ['A', 'W']) {
    const symbol = name + suffix;
    nativeForwarderApis[`shlwapi.dll!${symbol}`] = (r, a) => forward(r, a, symbol, argc);
  }
for (const direction of ['Lower', 'Upper'])
  for (const suffix of ['A', 'W'])
    for (const buffer of [false, true]) {
      const symbol = `Char${direction}${buffer ? 'Buff' : ''}${suffix}`;
      nativeForwarderApis[`user32.dll!${symbol}`] = (r, a) => forward(r, a, symbol, buffer ? 2 : 1);
    }
