# LAME native MP3 references

These outputs encode WineBrowser's authored integer-wave WAV inputs using the
same unchanged-source Windows LAME 3.100 EXE distributed in the public harness.
`native-reference.json` records executable/input/output hashes, arguments and
independent ffmpeg PCM decoding results. `scripts/check-lame-native.mjs`
executes the original EXE under Wine in its own prefix and compares the output;
`--update` explicitly replaces the references.

The browser test compares the actual generated MP3 bytes for hosted-example,
ZIP-upload and loose-file-upload paths. No JavaScript encoder computes the
expected MP3s. Tests cover stereo CBR, mono VBR and 48 to 44.1 kHz resampling;
they do not certify every LAME option. The short triangle-wave recordings and
reference output are original WineBrowser test data under the repository MIT
license. LAME's complete LGPL source and original license are distributed in
`public/examples/lame/source.zip`.
