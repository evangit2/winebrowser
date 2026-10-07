# Native process synchronization fixture

MIT project-owned PE32 executable compiled against MinGW Windows headers. It
starts unchanged copies of itself via ordinary CreateProcessW, exchanges named
events and semaphore counts, tests owned recursive mutexes and queries their
native layout. It verifies abandoned mutexes after normal/forced thread exit,
child exit, parent exit and main-thread exit with a surviving worker.

Build with `npm run build:process-sync`, then run `npm run test:process-sync`.
The browser test also renames the executable, moves it into nested directories,
stops a parked wait and uploads a fresh copy. No special runtime entry points
or filename checks are used. See [the implementation scope](../../../docs/process-synchronization.md).
