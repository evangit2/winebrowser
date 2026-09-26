# D3D8/9 fixed-function lighting

Native PE32 D3D8 and D3D9 applications can set/query materials and lights, enable
lights, select material color sources and render lit XYZ geometry in the browser.
`src/d3d-lighting.js` implements the guest ABI, state snapshots and generated
vertex-lighting WGSL. `src/d3d-fvf.js` describes the supported native layouts.
This extends the ordinary EXE/ZIP JIT path; no application-specific Wasm payload
or offline game translation is used.

## Supported behavior

- Set/GetMaterial uses the 68-byte D3DMATERIAL8/9 layout. Set/GetLight uses the
  104-byte D3DLIGHT8/9 layout. Getters validate the full output before writing.
  Setters validate types and finite parameters before changing state.
- Up to eight directional, point and spot lights can be active. Up to 256 light
  indices can be stored, including sparse DWORD indices. LightEnable on an
  undefined index installs the default white directional light. GetLightEnable
  returns 128 for enabled lights, matching Wine's D3D8/9 behavior. Enabling a ninth
  light fails explicitly; the runtime does not silently discard one.
- LIGHTING, AMBIENT, COLORVERTEX, LOCALVIEWER, NORMALIZENORMALS, SPECULARENABLE
  and the four material-source states are implemented and queryable. DIFFUSE,
  AMBIENT, SPECULAR and EMISSIVE sources can use the material, vertex diffuse or
  vertex specular. Missing vertex colors fall back to the material; COLORVERTEX
  disabled selects material values. Default material fields are zero.
- The FVF path accepts unblended XYZ plus optional float3 normals, packed diffuse
  and specular colors and one float2 UV. Strides can include padding up to the
  existing 256-byte limit. Missing diffuse is white when lighting is disabled;
  missing specular is zero. XYZ-only lit vertices receive ambient/emissive terms.
- Normals use the inverse transpose of the world-view linear transform, with
  optional normalization. Lit normals require affine, invertible world/view
  transforms whose inverse fits finite Float32 values. The projection remains a
  separate clip transform. Singular/projective normal transforms fail explicitly.
- Lighting runs per vertex on the GPU. Point lights use range cutoff and
  constant/linear/quadratic attenuation; spotlights add inner/outer cone and
  falloff. Directional lights do not attenuate. Ambient and emissive contributions
  join diffuse color; diffuse and specular are separately clamped and interpolated.
  Specular uses the halfway vector, material power and local or infinite viewer.
  In the camera-space convention used here, the infinite viewer faces negative Z.
  Specular RGB is added after texture stages; it does not change alpha.
- Diffuse alpha comes from the selected diffuse material source. Texture-stage
  alpha operations still determine the fragment alpha. Window presentation remains
  opaque. RGB565 conversion/dithering occurs after the lit/textured/specular result.

Each queued draw owns its material, light list and state values. Editing or
re-enabling a light cannot change earlier draws. Dynamic material/light values
are uniforms and do not trigger new pipelines. Pipeline variants include only
the lighting mode/source selections. The ordinary texture resource caches remain
shared with the unlit path. Device caps advertise the implemented lighting modes,
eight active lights and Gouraud specular support. [Framebuffer blending](d3d-blending.md)
is implemented separately; caps do not claim
stencil, skinning, fog or general shader-model conformance.

The bounded light validator rejects negative range/attenuation for point/spot
lights, nonfinite fields, negative material power and unsupported types. Spots
require nonnegative falloff and `0 <= Theta <= Phi <= float32(pi)`. Parallel-point
legacy lights, vertex blending/skinning, multiple texture coordinates, transformed
XYZRHW vertices, fog and indexed vertex streams remain separate work.

## Verification

`npm run test:lighting-backend` and the same script with `--force-readback`
check 27 cases / 110,592 pixels per presentation mode. Hand-computed directional
and material-source cases are supplemented by an independent CPU vertex-lighting
and barycentric reference for point attenuation/range, spot cones/falloff, eight
mixed lights and specular viewer modes. Tests also cover inverse-transpose normals,
normalization, camera rotation, absent colors/normals, queued state, texture/specular
ordering, attachment alpha and RGB565 output. Results:
[canvas](../evidence/d3d-lighting-backend.json),
[readback](../evidence/d3d-lighting-backend-readback.json).

`npm run build:lighting` builds native D3D8/9 fixtures against their actual MinGW
headers. `npm run test:lighting` uploads each as EXE and ZIP through the normal UI.
They round-trip materials and lights, enable a sparse light index, select the
material specular source, and render XYZ/normal/UV geometry with two light and
texture revisions in one frame. All 32,768 displayed pixels per run are checked,
and Escape exits with code zero. [Native evidence](../evidence/lighting-browser-results.json).

Unit tests cover ABI sizes/slots, defaults, raw roundtrips, invalid structures,
enable limits, FVF offsets, state snapshots, and normal/tangent orthogonality under
shear, nonuniform scale and camera rotation. Existing texture, raster, programmable
shader and native DirectX 12 cube regressions remain passing.

The earlier report mislabeled render state 146 as NORMALIZENORMALS; its actual
name is SPECULARMATERIALSOURCE. The numeric trace was correct. Both D3D8/9 headers
identify NORMALIZENORMALS as 143. Original Hamsterball now passes state 146 and
stops at the x86 repeat prefix at `0x4a6988`, after mapping `shadow.png` (8,884,000 guest instructions).
No game frame has been presented; arbitrary-program compatibility is not established.

Semantics were checked against the pinned Wine headers and fixed-function state
implementation, the Hamsterball renderer, and Microsoft's
[diffuse](https://learn.microsoft.com/en-us/windows/win32/direct3d9/diffuse-lighting),
[specular](https://learn.microsoft.com/en-us/windows/win32/direct3d9/specular-lighting)
and [attenuation/spotlight](https://learn.microsoft.com/en-us/windows/win32/direct3d9/attenuation-and-spotlight-factor)
documentation. The adapter and WGSL are original implementations of those API
semantics; no reference project game payload is included.
