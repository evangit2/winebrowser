// Keep formatting semantics in Wine guest code. These adapters only translate
// the caller's x86 varargs stack to Wine's va_list entry point and preserve ABI.
export async function format(r, a, wide, variadic) {
  const args = [a(0), a(1), variadic ? (r.cpu.r[4].value >>> 0) + 12 : a(2)];
  const symbol = `wvsprintf${wide ? 'W' : 'A'}`;
  r.wineFormatExports ??= new Map();
  let address = r.wineFormatExports.get(symbol);
  if (address === undefined) {
    if (!r.wineFormatModule) {
      await r.loadLibrary('wine-format.dll');
      r.wineFormatModule = r.graph.modules.get('wine-format.dll');
    }
    const module = r.wineFormatModule;
    address = await r.resolveExport(module, symbol);
    r.wineFormatExports.set(symbol, address);
  }
  return {
    result: await r.callGuest(address, args),
    argc: variadic ? 0 : 3,
    convention: variadic ? 'cdecl' : 'stdcall',
  };
}
export const formatApis = {};
for (const wide of [false, true]) {
  const suffix = wide ? 'W' : 'A';
  formatApis[`user32.dll!wsprintf${suffix}`] = (r, a) => format(r, a, wide, true);
  formatApis[`user32.dll!wvsprintf${suffix}`] = (r, a) => format(r, a, wide, false);
}

// The msvcrt printf family shares the same real Wine wvsprintf body. sprintf
// and vsprintf take the format in argument 1, so the varargs pointer sits at
// the same stack offset wsprintf uses.
formatApis['msvcrt.dll!sprintf'] = (r, a) => format(r, a, false, true);
formatApis['msvcrt.dll!vsprintf'] = (r, a) => format(r, a, false, false);
formatApis['msvcrt.dll!swprintf'] = (r, a) => format(r, a, true, true);
formatApis['msvcrt.dll!vswprintf'] = (r, a) => format(r, a, true, false);
