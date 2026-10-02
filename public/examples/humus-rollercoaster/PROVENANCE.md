# Humus RollerCoaster (Direct3D 9)

Emil Persson (Humus) made this demo. Its included readme permits free use and
redistribution by any method, provided the readme is included. The unchanged
ZIP retains the readme, executable, shaders, source, terrain and texture assets.

- Author/demo listing: <https://www.humus.name/index.php?page=3D>
- Original archive: <https://humus.name/3D/RollerCoaster.zip>
- Archive SHA-256: `fbb55c23ae94469ba12712ce830186d719de1a3abc983a3298a055331f0de0a0`.
- Original `RollerCoaster/RollerCoaster.exe` SHA-256: `acf1fed9b4863723b41600d4016e97dd3ec6313dbd5144622919f9b8103e912e`.
- Archive size: 910,932 bytes.
- F1 opens the upstream settings menu. Close the guest window to exit.

The executable uses a moving camera on a reflective roller-coaster track,
large indexed terrain, 3D procedural noise, cube reflections, water, lava and
particles. WineBrowser translates its original x86 blocks to Wasm and its
original Direct3D shaders to WebGPU during execution in the browser. It does
not patch or pretranslate the executable. Load the ZIP to include its assets.
Startup is CPU intensive; this is a compatibility demo, not a performance claim.
