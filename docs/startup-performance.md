# Browser startup performance

WineBrowser translates the uploaded program's x86 blocks to WebAssembly during
execution in the browser worker. Its guest shaders compile there as well.
That does not imply the program reaches its first frame in a few seconds.

Progress and final results expose `x86TranslationMs`: cumulative time decoding
and lowering x86 blocks, validating and instantiating their Wasm, including
failed attempts. It excludes guest execution, cache hits, shader compilation
and downloads. Engine background optimization is outside this synchronous
measurement. `totalCompiledBlocks` includes blocks later invalidated or evicted;
`compiledBlocks` is the number currently cached.

An ordinary headed Chromium 153 run measured Dynamic Branching at 9.22–9.32
seconds of x86 translation over 67.7–68.1 seconds through clean exit, with
first frames at 60.5–61.0 seconds. The compiler cost is substantial but is
only part of that elapsed time. See
`evidence/humus-translation-timing-browser-results.json`.

On October 2, ordinary headed Chromium 153, without unsafe WebGPU flags, passed
both catalog ZIP and uploaded ZIP paths for the unchanged Humus Dynamic Branching
and RollerCoaster demos. Dynamic Branching reached frames after 60.6–61.8 seconds;
RollerCoaster's scene samples completed after 94.1–97.6 seconds. Both animated and
exited with code zero. These tests use static Pages-layout hosting locally:

- `evidence/humus-d3d9-optimized-browser-results.json`
- `evidence/rollercoaster-optimized-browser-results.json`

Profiles of the original applications showed hundreds of millions of guest
instructions executing model preprocessing and geometry math before a window
appeared. The blank initial period therefore includes substantial guest
execution, rather than solely compiler work.

The x87 dispatcher now runs initialized blocks synchronously. SoftFloat result
buffers and unchanged rounding/precision settings are reused; classification
reads the original ext80 bits directly. Arithmetic continues to use deterministic
SoftFloat ext80, preserving the guest control word and exceptions. Shared-heap
growth, multiple instances, control changes and integer truncation are tested.

In the same 500,000-block, 5,000,000-instruction vec3 microbenchmark, reducing
allocations took the initialized loop from 1091.7 ms to 722.4 ms. This is a
34% reduction in that loop's elapsed time, not a full-application speed claim.
`npm run benchmark:x87-dispatch` reproduces the current dispatcher benchmark.

Startup in a few seconds and broad Windows application compatibility remain
unfinished. Program-specific precomputed geometry or replacement EXEs are not
used to obtain these results.

DLL unload and failed-load rollback now invalidate only blocks overlapping
discarded images. Restoring a bootstrapped NTDLL image also invalidates that
image. Generated blocks read guest memory and dispatch branch targets at
execution time, so unrelated code can remain compiled. Native DLL lifecycle
tests verify retention, removal, rejected execution at unloaded addresses,
and fresh code when rollback reuses an address.

An unchanged Water upload in ordinary Chromium compiled 13,522 blocks instead
of 46,616 with the previous whole-cache policy. The most repeatedly compiled
addresses dropped from seven compilations to one. These single developer
profile runs measured 2.96 versus 13.90 seconds of x86 translation and 17.7
versus 33.1 seconds through 30 scene frames; they are not a repeated startup
benchmark. Both exited zero with about 304 million guest instructions.
See `evidence/module-cache-browser-results.json`; the full Water scene tests
separately check original ZIP/catalog paths, animated pixels and clean exit.
