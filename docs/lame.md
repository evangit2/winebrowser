# Original LAME Windows encoder

The public **Load lame** example runs LAME 3.100 as a Windows i386 program,
compiled from the unchanged upstream source. It converts the supplied stereo
WAV into `output.mp3`, which the harness offers for download. Upload its ZIP,
or supply `lame.exe` with your own WAV and set the argument array to encode it.
The browser translates the original x86 code to Wasm when it runs.

This build uses SSE2 floating point and the Windows UCRT. Kernel32, KernelBase,
NTDLL and UCRT load from the existing hash-verified, source-built Wine package;
the complete static import graph has no unresolved imports. The original
libmp3lame encoder is linked into the EXE. Generic CPU instruction support and
normal DLL loading handle this program; there are no LAME-specific runtime
branches or patched executable bytes.

The default arguments are:

```json
["--silent", "--noreplaygain", "-b", "128", "stereo.wav", "output.mp3"]
```

The package also includes `mono.wav` for variable bitrate encoding and a 48 kHz
`resample.wav` for sample rate conversion. The signals use integer triangle
waves so that their exact input bytes are independent of host math libraries.

## Source, license and rebuild

LAME is LGPL-2.0-or-later. `public/examples/lame/COPYING` retains its original
license. The harness's **source** download contains the entire pinned upstream
source archive, the build recipe, configuration and compiler metadata. GCC
runtime license and exception texts are included in both archives.

The source is LAME 3.100 from SourceForge, SHA-256
`ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e`.
With Python 3, make and i686 MinGW GCC installed:

```sh
npm run build:lame
npm run package:lame
```

An existing source archive can be provided with
`python3 scripts/build-lame.py --source-archive /path/to/lame-3.100.tar.gz`.
The build pins source bytes, disables PE timestamps, sets the source epoch and
strips symbols. Repeated builds with the recorded GCC 16.1.0 toolchain must
produce the same EXE. Other compiler versions may produce different bytes.
`PROVENANCE.json` records file hashes and the full DLL dependency closure.

## Independent verification

`tests/fixtures/lame/native-reference.json` records three encodes of the same
Windows EXE under Wine: stereo constant bitrate, mono variable bitrate, and
48 to 44.1 kHz resampling. Retained MP3s are independently decoded with ffmpeg;
no browser runtime or JavaScript encoder calculates their reference output.
To regenerate or check them with Wine and ffmpeg installed:

```sh
node scripts/check-lame-native.mjs --update
npm run test:lame-native
```

`WINE` and `FFMPEG` select the local tools. The script uses an isolated Wine
prefix under `.cache/lame/` unless `WINEPREFIX` is supplied.

`npm run test:lame` exercises the hosted catalog, ZIP upload and loose-file
upload through the ordinary browser UI. It requires exit zero, native Wine
DLLs, exact MP3 byte identity, working download links and non-silent decoded
browser audio. CI repeats it on the Pages-style static host.
`WINEBROWSER_TEST_URL` selects the deployed site and `LAME_EVIDENCE` selects the
metadata report path.

The optional MP3 decoder and external libsndfile are not built. These cases
verify the original WAV/PCM encoder and specific runtime paths; they do not
establish support for every LAME option or arbitrary Windows EXEs.
