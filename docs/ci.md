# Browser regression and Pages deployment

The verification job runs formatting, the unit suite, native x86 oracle checks,
SoftFloat and the browser backend checks, then builds `/winebrowser/` for static
hosting. Eight independent jobs download that exact build and run the remaining
Pages-style browser checks. Deployment requires the verification job and every
browser group to succeed.

| Group           | Checks                                                                  |
| --------------- | ----------------------------------------------------------------------- |
| core            | 19: native packed SSE, LAME, FOSS tools, DLL loading, processes and CRT |
| controls        | 28: GUI controls, pointer capture, menus, lists and windows             |
| gdi-shapes      | 9: region, shape, bitmap, cursor, scrollbar and frame rendering         |
| gdi-pixels      | 9: brush, alpha, path, transfer and bitmap examples                     |
| dialogs         | 24: dialogs, native fonts, Metapad, toolbar and property sheets         |
| legacy-graphics | 15: DirectDraw, D3D8/9, OpenGL, Humus demos and 7-Zip                   |
| directx12       | 13: DX12 demos, buffers, textures and render targets                    |
| vulkan          | 6: Vulkan, skinning, exceptions and executable memory                   |

`runtime/test-suites/static-host.json` lists 123 distinct invocations with their
required environment options: 122 retained checks plus clipboard acceptance.
The original serialized
workflow block is retained verbatim with its hash and commit. The runner checks
that every original test remains present; the two duplicate packed-SSE/LAME
invocations are each run once. The legacy group also fetches its pinned 7-Zip
input, which was previously inherited from an earlier step's cache.

```sh
node scripts/run-static-suite.mjs --check
WINEBROWSER_BASE_PATH=/winebrowser/ npm run build
npm run test:static-group -- core
```

The runner starts the static server unless `WINEBROWSER_TEST_URL` is supplied.
It prints each test's status and duration; full subprocess output is preserved
in `.scratch/ci-logs/` and uploaded with browser evidence for every group.
Failures print the final diagnostic output and fail the group. A subprocess has
a 15-minute limit, and each group has a 40-minute job limit; these limits do not
turn timeouts into successful tests. Matrix failures leave the other groups
running so they can report independent regressions.
