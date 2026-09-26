# Native thread fixtures

Build with `npm run build:threads` using MinGW i686. These repository-owned PE32
programs execute through browser translation, with no pretranslated program Wasm.

- `threads.exe`: suspended creation, suspend counts, identities, stack bounds,
  private TEB/last-error values, priority updates, event barriers, interleaved
  CPU-only loops, return/ExitThread codes, joins, persistent thread signaling,
  close-before-exit and process cancellation of a blocked worker.
- `threads-native.exe`: the same tests through supplied native Wine DLLs, plus
  real Wine dynamic TLS values and FLS cleanup callbacks on both return and
  explicit thread exit.
- `worker-exit.exe`: a worker exits the process with code 77 while main waits.
- `main-exit.exe`: main exits its thread; the last worker exits the process with 77.
- `thread-fault.exe`: a worker executes UD2 while main waits. The expected result
  is an explicit unsupported-instruction failure, with all workers unwound.
- `thread-tls.dll`: static TLS template, zero fill, thread TLS/DllMain ordering,
  separate values and thread-detach checks used by the Node runtime tests.

Run `node --test tests/guest-threads.test.js`. For normal browser uploads, build
with `npm run build -- --base=/winebrowser/`, then `npm run test:threads`; it checks
EXE and ZIP imports, lifecycle exit codes and the expected fault UI.

The optional Wine tests require a matching rebuilt loader from
`npm run build:wine-loader`, a Wine i386 DLL directory and matching NLS files:

```sh
npm run test:threads-native -- /path/to/i386-windows /path/to/nls
npm run test:threads-native -- /path/to/i386-windows /path/to/nls --browser
```

Evidence is written to `evidence/threads-browser-results.json`,
`evidence/threads-native-results.json` and
`evidence/threads-native-browser-results.json`. A passed fault case means the
unsupported instruction was detected; it does not demonstrate SEH support.
The ordinary static TLS DLL is tested separately because the optional complete
Wine loader bridge still rejects static TLS PE images. See
[implementation and limits](../../../docs/thread-runtime.md).
