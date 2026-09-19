# WineBrowser SPIR-V to WGSL Wasm

Import `winebrowser_shader_wgsl.js`, await its default initializer, then call `spirv_to_wgsl(Uint8Array)` for a validated WGSL string. Invalid input throws. The original wrapper source, lockfile, build instructions and dependency licenses are retained in this directory.

Draw-parameter builtins use a 16-byte signed integer uniform at group 3, binding 0: `[baseVertex, baseInstance, 0, 0]`. The caller must bind the actual offsets for each draw. The Wasm memory is capped at 128 MiB.
