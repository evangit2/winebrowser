# wesmar Minesweeper

This is the unchanged PE32 x86 executable from the MIT-licensed
[wesmar/minesweeper release](https://github.com/wesmar/minesweeper/releases/tag/minesweeper).
It uses its original Win32 menu, dialog and GDI code. No application-specific
WebAssembly port or pretranslated x86 blocks are included.

- Upstream source commit: `a950b89de6946faa360dcd5febfcb4206a877af1`.
- Release URL: https://github.com/wesmar/minesweeper/releases/download/minesweeper/MineSweeper.zip
- Release ZIP SHA-256: `4f4d19f5004d5f70d2f94c2063928595dcedd47f730d7f0dd2e949d89874e547`.
- Original archive entry: `MineSweeper_x86.exe`.
- Executable SHA-256: `d97ab2cabe8e4eb9cfd95079fb743bdd9b762592e2774382bc0d032a22b2988e`.
- Source archive URL: https://github.com/wesmar/minesweeper/archive/a950b89de6946faa360dcd5febfcb4206a877af1.zip

`upstream-source.zip` preserves the source archive for that commit. The
upstream MIT notice is reproduced in `LICENSE.md`. This is the wesmar game,
with its vector graphics, and has no proprietary Microsoft Minesweeper binary.

Run `python3 scripts/package-minesweeper.py` to reproduce the public package.
Browser acceptance is recorded by `npm run test:minesweeper`.
