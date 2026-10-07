# Uploaded executable launchers

WineBrowser runs a family of PE32 processes for each uploaded package. Native
Wine `CreateProcessA/W` and `WinExec` reach the shared `NtCreateUserProcess`
bridge; the runtime does not redirect a launcher to a known filename or return
success without starting a child.

Each child has its own WebAssembly memory, x86 CPU, module graph, threads,
windows and graphics renderers. Process IDs and thread IDs differ between
processes. Window handles are unique within the family, so browser input reaches
the owning child even after its launcher exits. The session ends when the whole
family exits, faults, or the user presses Stop. A child fault remains visible.

Supported contracts include normalized Wine PE32 process parameters, package
DOS/NT image paths, current directory, exact command line, explicit/inherited
environment blocks, suspended initial creation and resume, process/initial-thread
waits, exit queries, handle close and same-process handle duplication. Uploaded
files and output changes are shared across the family and persisted after it
exits. Executables are loaded from the uploaded package; there are no host OS
processes. Each session is bounded to 16 created process records.

This is a bounded launcher milestone. Handle inheritance, redirected standard
handles, tokens, debug ports, parent-process/job attributes, remote memory/context
operations, and suspending a running child are unsupported. Unsupported creation
flags or attributes return failure. Named events, semaphores and owned recursive mutexes now share a process-family
namespace; see [process synchronization](process-synchronization.md). Registry
state and file-sharing locks remain process-local, so broader IPC and concurrent
file-lock compatibility are not established. A never-resumed child
keeps its session active until terminated or Stop is pressed. This does not imply
universal Windows or DLL compatibility.

## Acceptance

`npm run build:processes` reproducibly builds the independent MIT fixtures in
`tests/fixtures/processes`. `npm run test:processes` uploads their ZIP through the
ordinary browser UI. The GitHub Pages gate runs the same test against static
hosting without special isolation headers. Acceptance covers Unicode environment
and working directory, quoted command lines, renamed launchers in nested paths
with spaces, shared parent/child file writes, suspended startup, both child exit
handles, duplicate/close behavior, missing images, unsupported inheritance,
open/terminate-before-resume, ANSI creation, WinExec children that outlive their parents, simultaneous parent/child windows with unique handles, a child window
that receives the desktop close action after the launcher exits, and Stop/reupload
cleanup of the whole family.

`tests/process-session.test.js` separately checks argument quoting, process
identity, invalid buffers/handles, shared storage, fault propagation and
termination before resume. Browser results are saved in
`evidence/processes-browser-results.json`.

## Private game acceptance

The user's unchanged AirXonix v1.36 archive launches `program.exe` from
`AirXonix.exe` through native Wine. The [DirectDraw/D3D7 acceptance](directdraw.md)
now verifies its original startup dialog, animated menu, first level, movement,
pause/resume, return to the menu and native exit. Both process exit results are
checked. The archive is private local acceptance input and is not published.
The runtime fixes apply to arbitrary programs; there is no game-specific process
branch. See `evidence/directdraw-airxonix-results.json` for current gameplay evidence.

## Deployment regression repair

The recent native character-helper forwarding change also selected native Wine
KernelBase for 7-Zip. Its existing acceptance gate then exposed host token handles
that native CloseHandle could not close, and native directory and processor query
paths that were not yet implemented. The launcher deployment fixes those shared
contracts: token closure respects protection/invalid handles; NT directory
open/create and synchronous enumeration read the package tree; new file opens
recognize empty created directories; and ordinary file timestamp writes update
stored metadata. Directory/metadata state is shared within a process family.
The virtual process affinity mask is one. Extended topology queries explicitly
return STATUS_NOT_IMPLEMENTED so callers can take their documented fallback;
no host CPU topology is fabricated.

The unchanged public-domain 7-Zip binary now compresses both original files,
passes CRC validation, extracts byte-for-byte copies, and rejects a corrupted
archive. The GNU diff/cmp and OptiPNG acceptance cases also pass. See
`evidence/foss-tools-browser-results.json`.

## Live deployment

The complete GitHub gate and Pages deployment passed for
`041178f547a33495252a9cdf9a289be70cc6e989` in
[run 37096795046](https://github.com/evangit2/winebrowser/actions/runs/37096795046).
The live main/worker bundle hashes match the locally validated build. All six
launcher upload/window/Stop cases pass on the live site. The live OpenGL EXE/ZIP
shader compilation, animation, controls and shutdown regression also passes. The private AirXonix reports from that earlier deployment record the original
startup blocker; current gameplay acceptance is linked above. See `evidence/processes-live-deployment.json`,
`evidence/processes-live-browser-results.json`, and
`evidence/processes-airxonix-live-results.json`.

The later deployment `eb6deee11fcf00601ae0679b4f00daa1e97b0058` verifies playable
AirXonix through the unchanged launcher and direct game selection on live Pages.
The textured first level, arrow input, pause/resume, return to menu and every
process exit zero pass. Current evidence is
`evidence/directdraw-airxonix-live-deployment.json`; the earlier process reports
above retain the blockers observed at those earlier revisions.
