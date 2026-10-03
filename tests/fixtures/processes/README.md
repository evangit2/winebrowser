# Launcher fixtures

These original MIT-licensed, freestanding PE32 clients test native Wine child
process creation without redistributed games or executable-name special cases.
The parent uses CreateProcessW/A and WinExec; the child checks its identity,
environment, working directory and shared package files, and exposes an ordinary
window for input and parent-exit acceptance. The browser test changes their names
and package paths. Build with `npm run build:processes`; upload and verify with
`npm run test:processes`.
