# Native Vulkan compute verification

This project-owned Windows x86 client executes the original SPIR-V compiled
from `increment.comp`. It writes a storage buffer, supplies a push constant,
dispatches on the advertised compute queue, and reads exact GPU results from
host-coherent mapped memory. Repeating the command buffer checks that the first
dispatch's result survives a second submission. A partial GPU buffer copy
checks exact computed bytes and untouched destination bytes in both
submissions. No CPU replacement is used.

The fixture is MIT licensed with this repository. After `npm run build:vulkan`
fetches the pinned Vulkan headers, run `npm run build:vulkan-compute` with
i686 MinGW and glslangValidator installed. The script compiles the shader,
generates its little-endian DWORD header and builds a native Windows x86
executable with the real stdcall import widths. Run `npm run test:vulkan-compute`
against the Pages style static server. The deployed application translates
both x86 and SPIR-V.
