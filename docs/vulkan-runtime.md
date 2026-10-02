# Native Vulkan uploads in the browser

Two free Windows x86 Vulkan programs run through WineBrowser's ordinary
upload path and hosted catalog: Khronos Vulkan-Tools `vkcube` and Sascha
Willems's glTF skinning demo. The latter renders CesiumMan with textured,
lit indexed geometry, animated skeletal joints in storage buffers, node
transforms in push constants, and the original interactive ImGui overlay.
The native application, animation, assets and SPIR-V determine the scene.
The browser compiles x86 blocks to WebAssembly and SPIR-V to WGSL in its
runtime worker. GitHub Pages serves static files.

Both executables are Windows x86 source builds from pinned upstream source,
not official SDK/release binaries. Vkcube uses startup/CRT glue and release
flags; its scene and shaders are unchanged. The skinning build retains the
upstream application and shaders, with a `SIZE_MAX` guard in the common
helper to avoid duplicate `size_t`/`uint32_t` overloads on PE32. Its compiler
flags select x87 math and static C++ runtime linkage. Source inputs, build
recipes, hashes and licenses accompany the downloads.

The cube revision is `f13d435dd50dc616db0c10e7bac87cd3aa7c82e3`, recorded in
`demos/vkcube/manifest.json`. The skinning revision is
`41a4410243fca7640a2dd0115a5ff5cb9a29494b`, with source, GLM, Vulkan-Headers,
assets and license pins in `runtime/target-builds/willems-skinning.json`.
CesiumMan is CC BY 4.0 with a separate logo/trademark notice; Roboto is
Apache-2.0. The package retains the upstream and library notices.

## Application libraries and DLL closure

The skinning EXE statically includes GLM, tinyglTF/STB/nlohmann JSON, KTX,
ImGui, libstdc++ and libgcc. Its complete static import closure comprises:

| Module                                                        | Provider                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| `gltfskinning.exe`                                            | Uploaded native Windows x86 application and linked libraries |
| `kernel32.dll`, `kernelbase.dll`, `ntdll.dll`, `ucrtbase.dll` | Bundled source-built Wine Windows x86 DLLs                   |
| `user32.dll`, `gdi32.dll`, `vulkan-1.dll`                     | WineBrowser browser-service implementations                  |

`public/examples/gltfskinning/dependencies.json` records every module hash
and static import. The ordinary module graph resolves all eight modules
with no missing DLLs or imports. Browser acceptance separately executes
startup, asset loading, animation, overlay rendering, keyboard/mouse input
and native shutdown. This verifies the selected application's dependencies;
it does not establish compatibility with every DLL or Vulkan game.

## Runtime path

- `vulkan-1.dll` exports load through the existing PE module graph. Both
  `vkGetInstanceProcAddr` and `vkGetDeviceProcAddr` return normal host thunks;
  unsupported commands return a null function pointer. Unused static imports
  for Vulkan 1.3 dynamic rendering resolve to explicit failure handlers,
  while optional loader queries still return null.
- `src/vulkan-abi.js` is generated with the Windows x86 compiler and pinned
  Vulkan-Headers. It records real structure offsets and stdcall stack widths,
  including 64-bit non-dispatchable handles and `VkDeviceSize` arguments.
  Vulkan SC-only parameters are excluded from Windows Vulkan signatures.
- `src/vulkan.js` implements bounded handles/memory, enumeration, Win32
  surfaces, swapchains, descriptors, command recording/submission, binary
  semaphores, fences and teardown. Graphics, compute and transfer share one
  ordered queue.
- `src/vulkan-renderer.js` uses the worker's WebGPU device. Native vertex and
  index buffers, shader modules, descriptor contents, blend state and push
  constants determine the pipeline and each draw. Host-coherent memory is
  uploaded for each submission; GPU-written storage buffers are read back
  before the submission completes. Buffer copies preserve GPU results and
  untouched destination bytes. Direct linear-image and staging-buffer image
  uploads are covered.
- Naga validates original SPIR-V and emitted WGSL. Vulkan binding N maps to
  binding 2*N, splitting combined texture/samplers into texture 2*N and sampler
  2*N+1. Descriptor set numbers are retained. Push constants become an immutable
  per-draw uniform at reserved group 3/binding 0; such layouts can use sets 0–2.
- GPU work completes before submission fences/semaphores are signaled. A
  present requires an acquired image and signaled wait semaphores. Canvas
  presentation and explicit pixel readback are supported. Temporary push and
  compute readback buffers are released on completion or failure.

## Verified scope

The advertised API version is Vulkan 1.0. Advertised extensions are
`VK_KHR_surface`, `VK_KHR_win32_surface` and device `VK_KHR_swapchain`.
Unsupported optional features are not advertised.

Supported graphics include triangle lists, indexed draws with 16/32-bit
indices, vertex/instance buffer bindings, vertex/fragment SPIR-V, uniform
and read-only graphics storage buffers, one-element combined 2D texture/sampler
descriptors, RGBA/BGRA textures, RGBA swapchain rendering, D16 depth,
culling, dynamic viewport/scissor, supported alpha blend factors/operations
and one render subpass. Vertex attributes include float32 and uint32 scalar,
vec2/vec3/vec4, and unorm8x4. Vertex-index-only geometry remains supported.

Compute pipelines execute native SPIR-V with storage/uniform descriptors and
push constants. A native PE32 fixture checks exact storage-buffer values over
repeated submissions; no CPU replacement computes the result. Buffer barriers
use the ordered queue and pass boundaries; cross-queue ownership is unavailable.
GPU-written buffer-to-image transfers fail explicitly.

Limits include 32 binding numbers, four sets (three with push constants),
128 push-constant bytes, eight vertex bindings, 16 vertex attributes,
256 commands per command buffer, 8 MiB per allocation/resource and
1024 live handles. Compute dispatch counts are at most 65535 per dimension;
workgroups are bounded by WebGPU validation and the advertised 256 invocation
and 16 KiB shared-memory limits.

Unsupported state returns an error or diagnostic. Remaining limits include
x64 executables, descriptor arrays, writable graphics storage buffers,
multisampling, wireframe, multiple subpasses, arbitrary barriers and Vulkan
1.1–1.4 extensions. The upstream skinning UI exposes wireframe even when
`fillModeNonSolid` is false: keep that optional checkbox unchecked. Browser
acceptance does not include window resizing.

## Reproduce and use

```sh
npm run build:vulkan
npm run build:skinning
npm run build:vulkan-compute
WINEBROWSER_BASE_PATH=/winebrowser/ npm run build
PORT=4193 npm run serve:pages
```

In a second terminal:

```sh
npm run test:vulkan
npm run test:vulkan-compute
npm run test:skinning
WINEBROWSER_FORCE_READBACK=1 npm run test:skinning
# On a desktop with WebGPU support, verify ordinary Chrome without GPU flags:
WINEBROWSER_NORMAL_CHROMIUM=1 npm run test:skinning
```

Select the skinning catalog entry, upload `gltfskinning.zip`, or open its entire
extracted folder and select `bin/gltfskinning.exe`. The adjacent assets/shaders
are required. P pauses/resumes animation, left drag rotates the camera, right
drag/wheel zooms, F1 toggles the overlay, and Escape exits.

Skinning acceptance covers ZIP upload, folder upload and hosted catalog;
actual lit/textured character pixels; bone animation outside the FPS text;
pause/resume; native camera input; browser compilation; DLL closure and native
exit zero. Pausing retains up to three earlier poses from the upstream
frames-in-flight joint buffers, so the test checks bounded native phases.
The alternate readback run repeats the same acceptance. Evidence is in
`evidence/skinning-browser-results.json`, `evidence/skinning-readback-results.json`
and `evidence/vulkan-compute-results.json`. Vkcube remains a regression gate
for EXE/ZIP/catalog and staging-buffer uploads.
