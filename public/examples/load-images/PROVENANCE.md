# Native image loader GUI

Original WineBrowser contributors C programs and generated images, MIT.

MinGW creates native Windows SDK EXE/DLL inputs. The browser translates their
unchanged x86 code into Wasm during execution; there is no application-specific Wasm build.

Executable SHA-256: `d679eddd2d1e5aaadefcee36bc3e8fe63bf0a3c72ec2d8b84044aaf716776c63`

Resource DLL SHA-256: `5984c4eff63442c2c6d9c2f63d8a26a04f3513c25797cd602035c35101d3bd12`

Client source SHA-256: `efdc67f59194620d001a3287738ed3fa661a5506fa939d62b1d08953c8351be9`

All image/resource data are authored fixtures. The source archive contains the
client, DLL source, bitmap generator, resource scripts and required cursor/icon
assets with their generators. Rebuild with `sh scripts/build-load-images-fixture.sh`
after installing i686 MinGW; timestamps and ZIP metadata are deterministic.
