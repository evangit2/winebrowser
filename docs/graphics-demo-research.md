# Redistributable graphics demo research

Two unchanged Humus D3D9 archives now have ordinary-upload and catalog browser
regressions: RollerCoaster and Instancing. Their original readmes permit free
redistribution if retained. The catalog ships the complete original archives,
including their source, shaders, textures and notices. No executable is
patched or pretranslated.

Instancing is a small particle demonstration (432,605-byte ZIP). The original
program chooses its shader-constant batching path from the advertised caps.
Keys 2, 3 and 4 select that path, vertex-buffer upload and user-pointer arrays.
The browser regression checks all three paths, 48 animated frames and exit zero
in both ZIP-upload and hosted-catalog modes. Hardware stream-frequency
instancing remains unsupported; the demo's title does not establish that path.

- [Author's catalog](https://www.humus.name/index.php?page=3D)
- [Instancing archive](https://www.humus.name/3D/Instancing.zip)
- [RollerCoaster archive](https://www.humus.name/3D/RollerCoaster.zip)
- [Instancing browser evidence](../evidence/instancing-browser-results.json)
- [RollerCoaster browser evidence](../evidence/rollercoaster-browser-results.json)
- [Archive hashes and candidate findings](../evidence/graphics-demo-research.json)

## Candidates still requiring work

| Original archive         | ZIP bytes | Observed progress and requirements                                                                                                                                                        |
| ------------------------ | --------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Water                    |   714,714 | Browser reaches a dialog with no scene. Its blank text needs investigation; no rendering claim.                                                                                           |
| SelfShadowBump           | 1,138,848 | Browser reaches the upstream volumetric-texture precomputation prompt. The probe did not dismiss it. `Main.cpp` also requires six cubemap render-target passes.                           |
| TransparentShadowMapping | 1,206,184 | NORMAL semantic correction allows 33 frames / 785 draws. `Main.cpp` requires six cubemap render-target passes, which remain unsupported. Partial frames do not establish correct shadows. |
| MandelbrotSet            |   157,297 | Static imports require `MFC42.DLL`, which the archive does not supply. Its registry-value deletion import is now implemented, but the missing library still prevents startup.             |
| Metaballs2               | 1,645,308 | Vulkan demo with an x64 EXE. The PE32 frontend rejects it before execution; x64 translation and a Vulkan frontend remain required.                                                        |

These candidates remain in the ignored research cache. Inspecting source and
imports establishes prerequisites, not compatibility. The previous implicit-backbuffer routing gap is now fixed for selected
standalone, 2D and cube targets. Native regressions verify six faces, shared
D16 storage, exact sampling and RGB565 partial clears; see
[offscreen scope](d3d-render-targets.md). Transfers currently pass through CPU
readback at target boundaries. The original shadow candidate is undergoing
scene, animation and shutdown verification before catalog publication.

To reproduce Instancing after downloading the pinned archive into
`.cache/demo-research/Instancing.zip`, run `npm run package:instancing`, build
with the Pages base path, then run `npm run test:instancing` against the static
server. The packaging script rejects changed archive or EXE hashes. The
deployment workflow includes the scene regression.
