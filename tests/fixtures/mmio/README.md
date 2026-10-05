# Native multimedia file and window contracts

MIT fixture built from `main.c` with MinGW. `tone.wav` is generated PCM test data,
with odd-sized padding and a LIST chunk; no game data is included. Rebuild with
`npm run build:mmio`.

The unchanged PE32 executable reads RIFF/WAV chunks through WinMM, crosses an
8192-byte caller-visible buffer boundary, synchronizes `MMIOINFO`, checks seek,
EOF, ANSI/Unicode file opens and handle closure. Native C static assertions verify
the 72-byte MMIOINFO and 20-byte MMCKINFO ABI. It also checks virtual cursor
clipping, minimize/restore of a maximized window and retained restore geometry.
