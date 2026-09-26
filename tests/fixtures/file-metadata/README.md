# Package file metadata fixture

`npm run build:metadata` builds two PE32 programs with MinGW i686 from the
same C source. `npm run test:metadata` uploads the ordinary executable and a
ZIP containing `app/metadata.exe` and `app/data/payload.bin` to Chromium. The
ZIP case must find the six-byte companion asset; the standalone case must
report its absence. Both create a binary output file, query its metadata and
read its exact bytes back.

The optional native test uses actual Wine Kernel32/KernelBase/NTDLL:

```sh
node scripts/test-metadata-native.mjs "$WINEBROWSER_WINE_DIR" "$WINEBROWSER_NLS_DIR"
node scripts/test-metadata-native.mjs "$WINEBROWSER_WINE_DIR" "$WINEBROWSER_NLS_DIR" --browser
```

This test uses the integrity-checked Wine/NLS inputs and source-built loader
provided by `loadWineProbeInputs`. It adds direct NT basic/full path queries,
basic/network-open handle queries, structure sentinels and a metadata-only
handle that can query attributes but cannot read file bytes. Both programs
verify A/W calls, missing leaf versus missing parent errors, real directories,
generated file sizes and nonzero creation timestamps. Ordinary uploads do not
require this optional Wine closure.

Evidence is in `evidence/metadata-browser-results.json` and
`evidence/metadata-native{,-browser}-results.json`. The unit tests additionally
use a controlled clock to verify creation, access, write and change times across
Win32/NT operations, truncation, read-attribute rights, invalid buffers, path
escapes and side-effect-free failures.

The virtual filesystem currently derives directories from file parents. Files
are marked ARCHIVE and directories DIRECTORY. Original host/archive dates and
attributes are not retained: imported files receive the virtual copy's creation
time, and reads/writes/creation update process-local timestamps. Allocated size
rounds file lengths to 4096 bytes. Metadata queries never create files or
directories. Empty directories, directory creation/enumeration, arbitrary
attribute updates, reparse points and persistence of timestamps are unfinished.

PE32 layouts follow Microsoft's
[Win32 attribute data](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-win32_file_attribute_data),
[basic information](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/wdm/ns-wdm-_file_basic_information),
and [NT query/access contract](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntqueryinformationfile),
with the pinned Wine `dlls/ntdll/unix/file.c` used to check the 40/56-byte NT layouts.
