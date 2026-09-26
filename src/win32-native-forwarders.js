// User32 exports these functions through KernelBase in Wine. Keep their NLS,
// code-page and UTF-16 behavior in the native guest implementation.
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
for (const direction of ['Lower', 'Upper'])
  for (const suffix of ['A', 'W'])
    for (const buffer of [false, true]) {
      const symbol = `Char${direction}${buffer ? 'Buff' : ''}${suffix}`;
      nativeForwarderApis[`user32.dll!${symbol}`] = (r, a) => forward(r, a, symbol, buffer ? 2 : 1);
    }
