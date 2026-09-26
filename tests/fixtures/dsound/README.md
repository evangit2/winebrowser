# Native DirectSound PCM fixture

Build with `npm run build:dsound` (MinGW i686) and run with
`npm run test:dsound`. The original C program becomes an ordinary Windows PE32
EXE; WineBrowser translates its x86 blocks to Wasm while running. The test
uploads both the EXE and a ZIP with companion files through the normal UI.

The native program verifies named/ordinal export identity (including ordinal
11), Unicode device-enumeration callbacks, DirectSound 8 and buffer COM identity,
software device caps, primary format, wrapped Lock/Unlock regions, shared
duplicate storage, cursor/status polling, stop/seek, frequency reset and
one-shot completion. Its PCM square wave is played in four phases: a stereo
copy of mono, right-only audio at -20 dB and double frequency, a one-shot, and a
duplicate that keeps playing after the original buffer is released.

The Chromium test instruments the standard Web Audio API and checks actual
running AudioBufferSourceNodes, both channels' PCM peaks, bounded scheduled
latency, and cleanup after process exit and the UI Stop button. It does not test
physical speakers. No native Wine DLL closure or pretranslated game payload is
required for this fixture. `tests/dsound.test.js` separately checks exact sample
values, linear interpolation, stereo clipping, focus gating, cursor timing,
allocation failure and buffer lifetime using a controlled monotonic clock.

The implemented playback contract accepts PCM8/PCM16 mono/stereo, 100–200000 Hz,
with secondary buffers up to 4 MiB each and the existing bounded guest heap and
64 COM-object arena. Duplicates share guest PCM bytes and have independent
playback controls. The worker mixes stereo at 44100 Hz in 1024-frame chunks;
reported cursors follow guest monotonic time, while the browser schedules a
short queue. A stalled worker skips old sound instead of queuing stale seconds.
Changes can be heard after already queued samples finish. Primary buffers expose
format/volume/pan and playback status; primary Lock and cursor access are still
unsupported. Creation without a cooperative level stays inaudible. Non-global
buffers are muted when their guest window/browser loses focus.

Capture, 3D, notification events, effects, hardware/ deferred allocation,
write-primary cooperation, compressed/float PCM, surround output and DirectSound
COM class-factory activation remain unfinished. These tests do not establish
BASS music playback or original Hamsterball gameplay.
