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
flags or attributes return failure. Named synchronization objects, registry state
and file-sharing locks remain process-local, so general cross-process IPC and
concurrent file-lock compatibility are not established. A never-resumed child
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

The user's unchanged AirXonix v1.36 archive now launches `program.exe` from
`AirXonix.exe` through native Wine. It gets past `NtCreateUserProcess`, then stops
at the shared native C++ exception-dispatch gap, code `0xe06d7363`. The game is
**not yet verified playable**; no game frame or gameplay acceptance has passed.
The archive is used only as private local acceptance input and is not published.
Native exception dispatch is a separate next milestone; no game-specific branch
was added to this process runtime.
