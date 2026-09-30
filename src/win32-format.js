// Keep formatting semantics in Wine guest code. These adapters only translate
// the caller's x86 varargs stack to Wine's va_list entry point and preserve ABI.
//
// The Wine body is user32's *stdcall* `wvsprintfA/W`, which pops its three
// arguments itself. A guest entry point the ABI marks cdecl — Wine's
// msvcrt.spec lists `vsprintf`, `vswprintf` and `vsnprintf` as `@ cdecl`, and
// the `@ varargs` forms (`sprintf`, `swprintf`, `wsprintf`) clean up in the
// caller — must not have those words removed a second time: the runtime already
// leaves a cdecl caller's stack alone. Declaring the wrong convention pops words
// that belong to the caller and corrupts the stack of every program that used
// the function.
//
// On entry the thunk has not yet popped the return address, so ESP points at it:
// the first argument is at ESP+4, the nth at ESP+4+n*4, and the `...` block
// begins just past the last named argument.
export async function format(
  r,
  a,
  wide,
  {
    variadic = false,
    fixedArguments = variadic ? 2 : 3,
    convention = variadic ? 'cdecl' : 'stdcall',
  },
) {
  const args = [a(0), a(1), variadic ? (r.cpu.r[4].value >>> 0) + (fixedArguments + 1) * 4 : a(2)];
  const symbol = `wvsprintf${wide ? 'W' : 'A'}`;
  r.wineFormatExports ??= new Map();
  let address = r.wineFormatExports.get(symbol);
  if (address === undefined) {
    if (!r.wineFormatModule) {
      await r.loadLibrary('wine-format.dll');
      r.wineFormatModule = r.graph.modules.get('wine-format.dll');
    }
    address = await r.resolveExport(r.wineFormatModule, symbol);
    r.wineFormatExports.set(symbol, address);
  }
  return {
    result: await r.callGuest(address, args),
    // A cdecl caller removes its own arguments, so the handler must not.
    argc: convention === 'cdecl' ? 0 : fixedArguments,
    convention,
  };
}
export const formatApis = {};
for (const wide of [false, true]) {
  const suffix = wide ? 'W' : 'A';
  // wsprintfA/W are varargs (cdecl); wvsprintfA/W take a va_list and are stdcall.
  formatApis[`user32.dll!wsprintf${suffix}`] = (r, a) => format(r, a, wide, { variadic: true });
  formatApis[`user32.dll!wvsprintf${suffix}`] = (r, a) => format(r, a, wide, {});
}

// The msvcrt printf family shares the same real Wine wvsprintf body.
formatApis['msvcrt.dll!sprintf'] = (r, a) => format(r, a, false, { variadic: true });
formatApis['msvcrt.dll!swprintf'] = (r, a) => format(r, a, true, { variadic: true });
formatApis['msvcrt.dll!vsprintf'] = (r, a) =>
  format(r, a, false, { convention: 'cdecl', fixedArguments: 3 });
formatApis['msvcrt.dll!vswprintf'] = (r, a) =>
  format(r, a, true, { convention: 'cdecl', fixedArguments: 3 });
