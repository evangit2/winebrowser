# wesmar/Tetris release binary

This directory retains the unchanged x86 executable and x86 source files from
[wesmar/Tetris](https://github.com/wesmar/Tetris), copyright Marek Wesołowski,
under the accompanying MIT license.

- Upstream tag: `latest` (07.2026 release), resolved on 2026-09-12 to commit
  `19ffc5849931f4419230efb596be7f967b31a11c`.
- Binary: <https://github.com/wesmar/Tetris/releases/download/latest/tetris.exe>
- Binary size: 16,384 bytes.
- SHA-256: `3687bc1cfe9a7657ca9da1daacec9f97a92946f0b0440acdb70d3a71a4560007`.
- Sources: <https://github.com/wesmar/Tetris/tree/19ffc5849931f4419230efb596be7f967b31a11c>.

The binary is copied from the upstream release, not rebuilt or patched for
WineBrowser. A byte-identical build from source has not been established.
The retained source subset contains the x86 implementation, build script,
resource/manifest files, license and upstream README; it is not a complete
checkout of the other architectures or images.

`npm run build:examples` verifies the pinned EXE and packages it with this
notice and LICENSE.md. It also provides the retained source subset separately.
Registry values are process-local in WineBrowser and reset when the process
restarts. Font matching uses the browser's installed fonts. The shell icon is
absent because the bundled Shell32 subset has no icon resources.
