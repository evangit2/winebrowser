# Native image loader GUI

Original WineBrowser contributors C programs and generated images, MIT.

MinGW creates native Windows SDK EXE/DLL inputs. The browser translates their
unchanged x86 code into Wasm during execution; there is no application-specific Wasm build.

Executable SHA-256: `de8cc620f83df813b3d24a59693edc59d0002dbbed10afcf8c1402d1cbd303cc`

Resource DLL SHA-256: `5984c4eff63442c2c6d9c2f63d8a26a04f3513c25797cd602035c35101d3bd12`

Client source SHA-256: `ea3f6bf3d652a6de4aa194b2e877f173c50bbf155dd73aee5b1c459958951e8b`

All image/resource data are authored fixtures. The source archive contains the
client, DLL source, bitmap generator, resource scripts and required cursor/icon
assets with their generators. Rebuild with `sh scripts/build-load-images-fixture.sh`
after installing i686 MinGW; timestamps and ZIP metadata are deterministic.
