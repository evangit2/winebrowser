# Independent PE targets

The manifest records exact target versions, SHA-256 values, test arguments, and evidence-backed status. `passed` applies only to the recorded case and arguments; `partial` means some cases on the same executable passed while other probes remain blocked. Downloaded binaries and reference files stay in ignored `.cache/targets/` unless already part of a separately licensed runtime component.

On Chrome 152.0.7977.84 (2026-09-12), the unchanged upstream 3,584-byte **winapiexec 1.2** binary passed these browser cases: exact console output, creating/writing a virtual file, a `MessageBoxW` dialog, a measured 440 Hz/20 ms `Beep`, synchronous `PlaySoundW` with an 80-frame packaged PCM WAV, and GDI `PatBlt` plus `SetPixel` over a 640×480 RGBA canvas. The GDI test checked all pixels and matched its recorded SHA-256 exactly. The PCM WAV and ZIP are generated test data; the executable bytes remain unchanged upstream. The audio check observes WebAudio decode and scheduling, not physical speaker output. The target remains `partial`: the `SystemAsterisk` alias probe requests unsupported asynchronous alias playback, and the separate `TextOutA` probe is blocked because that API is not implemented.

The same unchanged winapiexec binary now also passes three desktop-service cases: a registry REG_BINARY roundtrip with exact data/type/size bytes, Wine's `wvsprintfW` producing exact UTF-16LE text through a relocated guest DLL, and offscreen compatible-bitmap drawing followed by `BitBlt(SRCCOPY)` with every output pixel checked. The current browser report contains 11 default cases and five passing optional whole-Wine DLL cases. These are service-level acceptance cases, not evidence that Tetris is playable.

The independent **pts-tinype hh4t** GUI binary passed with exit code 0, the expected `Hello,\nWorld!` / `World!` dialog, and a `LoadLibraryA` → `GetProcAddress` → `MessageBoxA` → `ExitProcess` trace. Its upstream repository has no license file, so it remains cache-only. The 402-byte hh2 console binary runs under native Wine 11.0, but the browser loader rejects its nonstandard raw section pointer that overlaps PE headers; its import directory also exceeds `SizeOfImage`.

The unchanged [wesmar/Tetris](https://github.com/wesmar/Tetris) release now runs in the public harness, with browser checks for controls, gameplay, dialogs, sustained execution and clean exit. Its original 16 KB EXE remains unchanged and MIT-licensed. [wesmar/minesweeper](https://github.com/wesmar/minesweeper) is a separate pinned target that remains blocked on broader controls, menus and GDI; passing Tetris does not establish Minesweeper compatibility. See [desktop compatibility scope](desktop-compatibility.md) and [the current task list](../TASKS.md).

The unchanged **wesmar/minesweeper** release now runs through the ordinary
browser harness. It resolved 29 unresolved imports to zero, opens its
`Minesweeper` window at a 240x310 client area, receives its own message flow
(WM_CREATE, WM_NCCALCSIZE, WM_WINDOWPOSCHANGED, WM_SIZE, WM_SHOWWINDOW,
WM_PAINT, WM_ERASEBKGND) and paints a 75-colour dialog: the classic
`#c8c8d2` face, white client, black grid and text, and red accents. This is
window-and-paint evidence, not a playability claim: menu commands and cell
interaction are not yet driven by a test. See
[the browser report](../evidence/minesweeper-browser-results.json).

The unchanged upstream **7-Zip console archiver** (7zr 26.03) now runs a complete `add` under the ordinary harness: its CRT starts (`_initterm`, `argc`/`argv`, the stdio `FILE*` layer and the low-level `_open`/`_read`/`_write` descriptor layer), it scans the drive, creates `out.7z`, compresses the supplied input, prints "Everything is Ok" and exits 0, and the 98-byte output is a real 7z stream (`37 7a bc af 27 1c 00 04`). `npm run test:7zr` is its regression gate and [the browser report](../evidence/7zr-browser-results.json) records the run. The remaining independent targets are blocked at known prerequisites, before any compatibility claim: PuTTY and the source-built SGI OpenGL sample now pass TLS-directory parsing, exposing 259 and 54 unresolved imports respectively; their GUI, API-set CRT and WGL/OpenGL requirements still prevent execution; Humus Inferno's entire import closure now resolves (ADVAPI32, MSVCR80, DXGI and D3D10 are all answered; 129 imports, 0 unsupported), and it runs its CRT startup through 161k guest instructions to its own entry point, where its frame-chain helper faults on a write to 0x102cc. The faulting store is `mov %edi,0x102cc(%esi)` at inferno.exe+0x2562; the computed address is exactly 0x102cc, so the base register is zero at the store even though the sequence that reaches it compared that same register against zero and did not take the zero-allocator branch. That was fixed: the versioned Visual C++ runtime surface was dispatched entirely as stdcall, and Wine's msvcr70..msvcr120 specs mark 1,946 of those entries cdecl. Operator new (`??2@YAPAXI@Z`) is one of them, and its decorated name carries no `@<bytes>` suffix, so nothing in the name reveals the convention; every C++ allocation therefore removed four bytes the caller also removed and shifted the stack by four, which is what swapped the callee-saved registers in the epilogue. The export surface is now generated from the versioned specs with their conventions (scripts/generate-msvcrt-versioned-exports.py) and the runtime returns each entry's documented convention. Inferno now runs past its constructor, past its window creation and into its Direct3D setup: 184,313 instructions, out of 129 fully resolved imports. Four more general defects were found and fixed on the way: the versioned CRT data exports were not published to the versioned aliases (so `_acmdln` from msvcr80 resolved to a code thunk), seventeen helpers passed a plain object where an accessor _function_ is required (breaking strcmp and several conversions outright), the D3D10 creation-flag mask accepted only BGRA_SUPPORT and refused the SINGLETHREADED flag a framework passes first, and the D3D10 device did not answer IDXGIDevice, which is how a framework asks the shared DXGI factory for its swap chain. Two more general defects were then found by tracing the structures rather than the return values. GetMonitorInfo wrote its two RECTs four bytes apart (the header puts rcMonitor at 4 and rcWork at 20), so every caller read a monitor rectangle with a zero height and computed nonsense geometry from it — that is what gave Inferno a negative window height. And the D3D10 swap-chain rules rejected a single back buffer, which DXGI_SWAP_EFFECT_DISCARD explicitly permits. With both fixed, Inferno creates its window ('window created' is a reported phase), creates its D3D10 device, and reaches its own swap-chain call with a well-formed description; In the browser, where WebGPU is available, Inferno goes further still: it creates its device, its swap chain, its render-target view, a D24_UNORM_S8_UINT depth buffer and the depth-stencil view for it, and then reaches its own asset loading and stops on a texture it cannot find. Three more general defects were fixed to get there: the depth formats were flattened to D16_UNORM so every application asking for D32_FLOAT or D24S8 was refused, the shared backend would not host a 32-bit or combined depth attachment, and the view-description parser shared one dimension table across the three view kinds even though the headers number them differently (depth value 3 is TEXTURE2D, shader-resource value 3 is TEXTURE1DARRAY). Driving the target also exposed and fixed a second real CRT defect: _controlfp_s takes the accumulated control word as its _first_ argument, and the bounded definition was treating the mask word as a pointer. Three more general defects then came out of the same target: _stricmp and its family folded with `byte | 0x20`, which turns the NUL terminator into a space, so equal strings compared unequal and every extension dispatch was misrouted (Inferno's own texture loader skipped its DDS entry and reported the file missing while it sat in the package); the block-compressed BC1/BC2/BC3 formats a game's assets are stored in were refused, as were the D32_FLOAT and D24_UNORM_S8_UINT depth targets; and ID3D10Resource.GetType returns through its out-parameter, so answering in EAX left the caller's dimension uninitialized and its dispatch reported 'Unsupported type'. Humus Inferno now reaches 212,417 guest instructions: it opens the font's .dds, creates the compressed texture and the shader-resource view over it, compiles its shader-model 4 vertex, pixel and geometry shaders in the browser and creates all three devices from them, then reflects the result. Reaching that exposed four more defects, each of which would affect any D3D10 application: the native bridge refused every shader-model 4 profile even though the vkd3d-shader library it wraps resolves them; the D3D10CompileShader wrapper reported S_OK for every call, because it wrapped a helper that already built a complete response and an object coerces to zero; the compiler refused the whole D3D_SHADER_* flags word rather than the packaging hints it is; and the reflection IID was misspelled while every reflection object was created with no identities at all, so each answered only IUnknown.

The SGI sample is a local build of independently sourced OpenGL tutorial code, not a checked-in project fixture. Its archived source page has no separate license notice; keep its build and executable in the ignored cache. The pts-tinype executables likewise have no repository license file. Humus' included readme permits redistribution if retained; PuTTY is under its MIT-style license, 7zr under LGPL-2.1-or-later with the upstream unRAR restriction, and winapiexec under GPL-3.0. Check each upstream license before redistributing a binary.

Generic runtime work now exercised by independent code includes PE32 section-tail mapping, guest DLL mapping and relocation, named/ordinal/forwarded export linking, dynamic loading and function lookup, console/file/dialog/audio/GDI API paths, and execution of Wine's unchanged `CommandLineToArgvW` body as guest x86. These improvements reuse the same loader, CPU translator, and API providers across targets; they do not supply broad CRT startup, general windowing, OpenGL, or Direct3D drivers.

Run the test and target workflow from the repository root:

```sh
npm ci
npm test
npm run build
npm run test:browser
npm run test:external
npm run fetch:targets
npm run inspect:targets
npm run build:modules
npm run build:wine
```

`test:external` writes browser observations to [`evidence/external-browser-results.json`](../evidence/external-browser-results.json). `fetch:targets` downloads and hash-checks assets into `.cache/targets/`; `inspect:targets` records static loader/import blockers without executing binaries. DLL fixture and Wine component rebuilds are optional; they need the documented i686 MinGW toolchain and Python where applicable.

The optional `WINEBROWSER_NTDLL` experiment uploads the unchanged winapiexec executable with a whole hash-pinned installed Wine 11 i386 `ntdll.dll`. Chromium verifies real DLL initialization/relocation and CRC32 `0xcbf43926` for `123456789`. Node verifies additional fixed pure-export vectors; NT time/counter calls and virtual-page allocation/free now execute through the Wine dispatcher; page lifecycle, access and zeroing checks pass. The runtime now creates Wine’s process heap before DLL attach and publishes it in the PEB. Chromium verifies a private heap’s 32-byte zeroed allocation, successful free and destruction through the unchanged DLL. The newer NT boundary closes supported runtime file handles; complete Wine initialization and application lifecycle remain separate work. This is separate from the default CI cases because the installed DLL is not redistributed. See `evidence/wine-ntdll-results.json` and the optional case in the external browser report.

The test site now includes a repository-owned native TLS EXE/DLL pair. It checks separate initialized templates and zero-filled tails, ordered callbacks, and per-module writes. Portable tests also cover dynamic loading and failed-attach cleanup. These fixtures prove the new TLS path; they do not establish PuTTY or OpenGL compatibility. The full Wine CRT closure is captured separately in `evidence/wine-crt-results.json` and now passes the NLS mapping calls with explicitly supplied data but stops at a later guest read violation; see [the current task list](../TASKS.md).

The pinned **Humus Dynamic Branching** D3D9 archive now runs its scene in the browser as an unchanged EXE. After the source-built Wine loader registers the real guest DLLs and the application window opens, the demo creates its DXT1 base maps, DXT3 font atlas and `L8` glyph texture, compiles its vertex and pixel shaders, and plays the room scene with stencil shadow volumes and alpha-tested silhouettes. The Chromium probe presents three 798×570 frames of 39 indexed draws each with differing pixel hashes, and the captured frame decodes to a coherent pillar-room scene lit by the demo's five coloured lights (25,770 distinct colours, mean luminance 27.6). Evidence: [`evidence/wine-target-humus-dynamic-branching-browser.json`](../evidence/wine-target-humus-dynamic-branching-browser.json). Camera and menu input are not yet wired to the in-app browser harness, so this is a render-loop result, not full interactive parity. The public `d3d9-shader-cube` remains the minimal programmable fixture. The
same scene is now a checked regression: `npm run test:humus-d3d9` selects the
published example and uploads the unchanged upstream ZIP, and asserts a large,
richly shaded, animated 798x570 image plus the demo's own Direct3D 9 call
surface (vertex/index buffers, DXT textures, VS 1.1/PS 2.0 shaders, sampler
states and indexed draws) before the window closes with exit code 0.

Supporting runtime work this required: block-compressed DXT1/DXT3/DXT5 decode and `L8`/`A8L8`/`A4L4` luminance formats, D3D9 stencil shadow-volume state with a combined depth24plus-stencil8 attachment and stencil clears, alpha-test discard in both fixed-function and translated pixel shaders, vertex declarations that are a superset of the shader's inputs, and texture/sampler binding for translated legacy pixel shaders.

## October 1 continuation

The unchanged Inferno EXE now passes shader reflection in Chromium and reaches
its volume-texture creation. Reflection's constant-buffer, variable and type
interfaces do not inherit IUnknown: their first slot is GetDesc. The old three-slot
prefix misrouted that call to QueryInterface and corrupted the i386 stack.
Borrowed children now use the documented slots and stdcall arities, cache their
identity under the owning root, share its strings, and refuse calls after its
Release. The root remains a normal IUnknown interface. The regression invokes
all three child layouts and verifies descriptor bounds and root lifetime.

Validation: 772 unit tests and the production build pass. A fresh unchanged-EXE
Chromium probe gets through the font shader's constant-buffer descriptors and
then reports `Couldn't create texture` after `ID3D10Device.CreateTexture3D`.
No Inferno frames have been presented; volume resources and geometry shader
execution remain required. Probe inputs stay local and hash-checked.

Sampled Direct3D 10 volumes now allocate real WebGPU 3D textures and upload
single-mip RGBA8 data with independent row and slice pitches. Shader descriptor
scanning preserves the 3D binding dimension through pipeline creation. The
resource reports its native 36-byte descriptor and TEXTURE3D dimension; its SRV
retains the resource until the view is released. CPU-mapped volumes, volume render
targets, compressed volumes and multiple mip levels remain unsupported.
`npm run test:volume-backend` compiles SM4 HLSL in Chromium and reads exact red
and blue pixels from two different depth slices, with zero WebGPU errors.
775 unit tests and the production build pass. The unchanged Inferno EXE loads
its explosion volume and now fails creating the separate BC4 terrain texture.

Reflection also reads the shader program's version word, buffer/variable flags,
actual scalar/vector/matrix/aggregate type records, member offsets and default
values from DXBC RDEF metadata. Count, recursion and byte bounds are checked;
malformed type/default records are regression-tested. Borrowed descriptors still
share their root's lifetime.

BC4 and BC5 UNORM/SNORM texture storage now preserves their native 8/16-byte
block footprints and reaches WebGPU's BC texture formats. The browser regression
reads exact channel values for all four formats after a volume-texture pipeline.
This mixed sequence also exposed and fixes the shared pipeline-layout cache:
binding numbers alone did not distinguish texture dimensions or resource types;
its key now includes the complete layout entries. 776 unit tests, the real
browser volume/BC sampling test and the production build pass. Inferno's terrain
BC4 creation succeeds; its next sampled texture still needs mip-chain support.

Sampled D3D10 2D textures now retain every supplied mip, copying rows according
to each D3D10_SUBRESOURCE_DATA pitch. Zero MipLevels resolves the complete chain;
GetDesc and shader-resource-view mip ranges report the resulting allocation.
WebGPU creates the chain and uploads each actual level. The browser test samples
explicit mip 1 and mip 2 with exact green/blue pixels; unit coverage checks padded
source rows, the default full chain and bounded partial SRV ranges. CPU mapping,
attachment mip chains and automatic mip generation remain unsupported. All 777
unit tests, the volume/BC/mip browser regression and the production build pass.
Inferno passes the ten-level 512x512 RGBA chain and continues loading assets;
it has not presented frames yet.

D3D8/9 D24X8 now creates a depth-only WebGPU depth24plus attachment, preserves
its native surface format/32-bit storage and reports support through depth
matching. Clearing stencil on a depth-only attachment returns INVALIDCALL; the
browser regression verifies nearer geometry occludes farther geometry and
stencil use is rejected. Instancing passes device creation and next fails on its
multi-stream vertex declaration. 780 unit tests and the WebGPU backend regression
pass. The normal package path still has no verified Instancing scene.

The host heap retains its low address ABI and acquires additional committed
arenas from VirtualMemory when the initial 12 MiB is exhausted. The existing
bounded address space and allocation-size limits still apply. Tests exhaust the
initial arena, verify readable/writable expanded allocations, protect a separate
native reservation from overlap and reuse freed blocks. Inferno reaches its
six-face, ten-level cube-map request after this change.

Sampled D3D10 cube textures preserve all six faces in native slice-major mip
order. Texture creation, GetDesc and default/explicit cube SRVs retain the array
size, cube flag and mip range. The shared WebGPU renderer allocates six layers,
uploads each face/level and binds a true cube view with a dimension-specific
shader layout. The browser test reads exact red and blue pixels from +X/+Z at
mip 1. Inferno passes its 512x512 six-face ten-mip environment map.

Combined depth-stencil render passes now specify stencil load/store operations
as WebGPU requires, even for a depth-only clear. D3D10 depth, stencil and combined
clear flags reach the attachment. A browser regression draws nearer red geometry,
clears only stencil, then proves farther blue geometry stays occluded: the clear
preserves depth. Inferno now clears its attachment and proceeds into frame setup,
where it has a null guest pointer at inferno.exe+0x6130. It still has no frames.
785 unit tests, the extended volume/BC/mip/cube/depth browser regression and the
production build pass.

D3D9 now reports its supported VS 2.0 compiler path (D3D8 retains VS 1.1),
accepts indexed user-memory triangle lists/strips/fans with 16/32-bit indices,
and derives programmable vertex inputs from the supported FVF layouts when no
explicit declaration is bound. Indexed UP calls validate the declared vertex
window, snapshot its bytes and clear stream/index bindings. The real WebGPU
regression draws an SM2 shader triangle; 60 D3D9 unit tests pass. The unchanged
Sketch demo now presents frames, but its white image is not a verified scene.
RollerCoaster reaches CreateVolumeTexture in the ordinary dropped-ZIP worker;
no new demo is published as working on the strength of these results.

DrawText and DrawTextEx now measure through the configured GDI rasterizer,
read flags from the correct DrawTextEx argument and return measured height
for CALCRECT. Seven text tests cover centering, wrapping and rectangle results.
This removes the host descriptor.measure exception seen in Hamsterball's error
report window; the game's underlying fault and gameplay remain unverified.
Diagnostic probes use the worker's Canvas text rasterizer, bound exception traces
and capture the requested final frame as well as their initial frames. Their
frame goal is validated and retained in the result.

The Dynamic Branching acceptance gate also passes after these D3D9 changes:
the hosted unchanged ZIP and a fresh ZIP upload both render the animated room
and close with exit code 0. A 120-frame Hamsterball probe instead presents six
startup frames, enters its own Unexpected Error dialog after a handled read
fault at EXE+0x85c2c and reaches the diagnostic deadline. The fault uses index
0xfefe to read 0x507c950; this agrees with the earlier poison-buffer investigation
in TASKS.md. Startup frames are not gameplay verification. The optional
--stop-on-exception diagnostic retains the first guest fault's stack, frame
memory, VM ownership and recent APIs before the application's error handler
can replace that evidence with its dialog loop.

D3D8/9 volume textures now retain uncompressed mip storage with padded row
and independent slice pitches. Texture and volume views share LockBox storage,
report their version-specific native descriptors and keep their container alive.
Programmable draws snapshot and upload real WebGPU 3D textures; shader bindings
reject mismatched dimensions and preserve W addressing. The PS2 sampler3D
browser test reads exact red/blue depth slices without WebGPU errors. Unit tests
check mip extent, shared sub-box writes, immutable previous snapshots and freed
storage. Compressed volumes, fixed-function volume coordinates and automatic
mip generation remain unsupported. A fresh RollerCoaster ZIP passes volume
creation/filling and next reaches unsupported CreateCubeTexture, with no frames.


October 2 continuation: the pinned source-built base closure now starts through
ordinary `Runtime.run()` when its patched NTDLL is supplied. The source-base
gate also uploads a ZIP with the console EXE, six source DLLs and seven NLS
tables through the normal UI; native NT output and shutdown exit zero. It does
not yet make the worker supply the closure automatically. The example packager
now preserves and validates unrelated catalog entries when rebuilding Tetris.

Additional Humus PE32 candidates were downloaded from the upstream 3D archive.
Their readmes permit redistribution when retained. ASCII (540,843 bytes) and
RollerCoaster (910,932 bytes) reach the shared CreateCubeTexture blocker;
RollerCoaster now passes volume texture creation and filling. Water (714,714),
TransparentShadowMapping (1,206,184), and SelfShadowBump (1,138,848) remain
unverified. These local research archives have not been added to the public
catalog. Metaballs2 uses x64 Vulkan, outside the current PE32/D3D path.

The original Hamsterball still faults at EXE +0x85c2c after six transition frames.
A one-byte write trace finds the suspect FE byte written at EXE +0xadd32 and
subsequently processed by the PNG RGB/BGR swap at +0xa5151. This does not yet
establish why image data reaches the later table lookup; gameplay is unverified.
