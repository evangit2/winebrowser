# Multimedia file compatibility

WineBrowser supplies read-only WinMM multimedia streams through `mmioOpenA/W`,
`mmioRead`, `mmioSeek`, `mmioGetInfo`, `mmioSetInfo`, `mmioAdvance`, `mmioDescend`,
`mmioAscend` and `mmioClose`. These resolve normally for uploaded PE32 executables.
There are no executable-name checks or patched import tables.

Package filenames use the shared DOS path resolver. Caller-owned memory streams
use `FOURCC_MEM`. `MMIO_ALLOCBUF` owns and frees a bounded guest buffer; direct
buffer readers see the PE32 72-byte `MMIOINFO`, synchronize consumed bytes with
`mmioSetInfo`, and refill with `mmioAdvance`. RIFF/LIST searches honor parent
boundaries and odd chunk padding. Seek, EOF, malformed chunks, pointer bounds and
invalid handles are checked. Writes, custom I/O callbacks and raw OS file handles
remain unsupported; RIFF reading itself does not add compressed audio codecs.

The associated window APIs support `CloseWindow` minimize and `OpenIcon` restore,
including return to a maximized state. The browser hides minimized guest windows
while retaining their native visibility, geometry and lifetime. `ClipCursor`
constrains the virtual screen cursor and delivered mouse coordinates;
`GetClipCursor` reports its rectangle. Browser OS cursor confinement is separate.

The MIT [native fixture](../tests/fixtures/mmio/README.md) checks actual WAV bytes
across the 8192-byte buffer boundary, odd padding, LIST skipping, metadata ABI,
seek/EOF, ANSI/Unicode opens, minimize/restore and cursor clipping. Its browser
acceptance checks visible/hidden/restored DOM windows and native exit zero.

```sh
npm run build:mmio
npm run test:mmio
```

`WINEBROWSER_TEST_URL` selects a static or live Pages host. `MMIO_EVIDENCE` selects
the metadata report, defaulting to `evidence/mmio-browser-results.json`. CI runs
the same native fixture on its Pages build. These implement the APIs reported as
missing by Feeding Frenzy; the actual Feeding Frenzy game has not been tested.

## Live deployment verification

GitHub Pages deployed `e8a6cc1b94990029a7accc74d9d1867f327fa811` after
[the full CI gate passed](https://github.com/evangit2/winebrowser/actions/runs/37254813490),
including 1,136 unit tests and the native static-hosting/browser suite. The live
JavaScript, worker and CSS match the verified build byte for byte.

The native fixture passes on [the public harness](https://evangit2.github.io/winebrowser/):
all twelve imports reported as missing by Feeding Frenzy execute, the window
minimizes/restores in the browser, and the program exits zero without page errors.
The unchanged private AirXonix archive also passes first-level gameplay through
both its launcher and direct game executable: movement, five seconds of stable
paused timer, resumed countdown, return to menu and every process exit zero.
Observed live performance is 7.8–8.9 FPS, with first-level loading in 15–16 seconds.

See [deployment evidence](../evidence/mmio-live-deployment.json),
[native API results](../evidence/mmio-live-browser-results.json) and
[AirXonix regression metadata](../evidence/mmio-airxonix-live-regression.json).
No private game binaries or screenshots are redistributed. Feeding Frenzy
gameplay and later AirXonix levels remain unverified.
