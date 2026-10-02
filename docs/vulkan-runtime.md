# Native Vulkan uploads in the browser

The free Khronos Vulkan-Tools `vkcube` Windows x86 executable runs through
WineBrowser's ordinary EXE/ZIP upload path and the hosted catalog. Its original
textured 3D cube, matrices, embedded LunarG image and SPIR-V shaders execute
from the native program. The browser compiles x86 basic blocks to WebAssembly
and SPIR-V to WGSL in the runtime worker. GitHub Pages serves static files;
there is no server compiler or pretranslated scene.

The upstream source is pinned at
`f13d435dd50dc616db0c10e7bac87cd3aa7c82e3`, with every retained file hashed in
`demos/vkcube/manifest.json`. This is a Windows x86 build from current upstream
source, with project startup/CRT glue and release flags. It is not an official
SDK-distributed binary. The upstream scene and shaders are unchanged, and the
Apache-2.0 license, original source and build recipe accompany the download.

## Runtime path

- `vulkan-1.dll` exports load through the existing PE module graph. Both
  `vkGetInstanceProcAddr` and `vkGetDeviceProcAddr` return normal host thunks;
  unsupported commands return a null function pointer.
- `src/vulkan-abi.js` is generated with the Windows x86 compiler and pinned
  Vulkan-Headers. It records real structure offsets and stdcall stack widths,
  including 64-bit non-dispatchable handles and `VkDeviceSize` arguments.
- `src/vulkan.js` implements bounded handle/memory storage, enumeration,
  Win32 surfaces, swapchains, uniform/image descriptors, command recording,
  submission, binary semaphores, fences and teardown.
- `src/vulkan-renderer.js` uses the worker's WebGPU device. Native shaders and
  descriptor contents determine the render pipeline and every draw. The guest
  writes host-coherent memory; submission snapshots its uniforms and texture
  bytes into GPU resources. Direct linear-image uploads and staging-buffer
  copies are covered.
- Naga validates the original SPIR-V and emitted WGSL. Vulkan binding N maps
  to binding 2*N, with combined texture/sampler descriptors split into texture
  2*N and sampler 2*N+1. Descriptor set numbers are retained. This mapping
  avoids a sampler colliding with another shader stage's uniform binding.
- GPU work completes before submission fences/semaphores are signaled. A
  present requires an acquired swapchain image and signaled wait semaphores.
  Hardware canvas presentation and explicit pixel readback are supported.

## Verified scope

The advertised API version is Vulkan 1.0. The current upstream cube uses that
API subset. Advertised extensions are `VK_KHR_surface`,
`VK_KHR_win32_surface`, and device `VK_KHR_swapchain`; unsupported optional
features are not advertised.

Supported graphics are triangle lists without vertex-input buffers, with
vertex/fragment SPIR-V, uniform buffers, one-element combined 2D
image/sampler descriptors, RGBA/BGRA textures, RGBA swapchain rendering,
D16 depth testing, culling, dynamic viewport/scissor and one render subpass.
Geometry may come from shader uniform arrays and the vertex index, as in the
upstream cube. Limits include 32 descriptor bindings, 4 sets, 256 commands per
command buffer, 8 MiB per allocation/resource and 1024 live handles.

Unsupported state returns an error or diagnostic. This milestone does not
cover x64 Windows executables, compute, descriptor arrays, push constants,
multisampling, blending, indexed/vertex-buffer drawing, multiple subpasses,
arbitrary barriers, Vulkan 1.1–1.4 extensions or arbitrary Vulkan games.
Window resizing is not included in the browser acceptance test.

## Reproduce

```sh
sh scripts/build-vkcube.sh
python3 scripts/package-vkcube.py
python3 scripts/generate-vulkan-abi.py
npx prettier --write src/vulkan-abi.js
npm run build:shader-wgsl
WINEBROWSER_BASE_PATH=/winebrowser/ npm run build
PORT=4193 npm run serve:pages
```

In a second terminal:

```sh
npm run test:vulkan
WINEBROWSER_FORCE_READBACK=1 npm run test:vulkan
```

The browser regression checks EXE upload, ZIP upload, hosted catalog loading
and a staging-buffer upload, actual cube/texture pixels, changing frame
hashes, compiled x86 blocks, Vulkan API provenance and clean native teardown.
The readback run repeats those checks through the alternate presentation path.
Evidence is in `evidence/vulkan-browser-results.json` and
`evidence/vulkan-readback-results.json`; screenshots use matching filenames.
