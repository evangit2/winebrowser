# Native image loader GUI

Original WineBrowser contributors C programs and generated images, MIT.

MinGW creates native Windows SDK EXE/DLL inputs. The browser translates their
unchanged x86 code into Wasm during execution; there is no application-specific Wasm build.

Executable SHA-256: `13ba607ff8c0680f58c3db3acf9da7876094569023caa7c181ecb575ced1c7da`

Resource DLL SHA-256: `5984c4eff63442c2c6d9c2f63d8a26a04f3513c25797cd602035c35101d3bd12`

Client source SHA-256: `696f6a346408019fee33c7bb77fc6ceeb39f3defb5aa097ad3c6292f79b4d065`

All image/resource data are authored fixtures. The source archive contains the
client, DLL source, bitmap generator, resource scripts and required cursor/icon
assets with their generators. Rebuild with `sh scripts/build-load-images-fixture.sh`
after installing i686 MinGW; timestamps and ZIP metadata are deterministic.
