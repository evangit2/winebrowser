# Native DLL search clients

MIT-authored PE32 clients and DLLs exercise ordinary directory-based loading.
The identical export name returns 101, 202 or 303 from separate DLLs in the
package root, application directory and plugin directory. The plugin imports
the helper during attachment and calls it again through an exported function.

The host and native Wine clients verify SYSTEM32-only exclusion, application
directory selection, DLL_LOAD_DIR dependency selection, real guest DllMain,
file-name queries, unload and invalid flag combinations. The native client
also checks Wine's original AddDllDirectory, RemoveDllDirectory and
SetDefaultDllDirectories, including missing-DLL errors after removing a user
directory. ApiSetQueryApiSetPresenceEx selects the native Wine base at startup.

Build with `sh scripts/build-dll-search-fixtures.sh`; run in the browser with
`node scripts/test-dll-search-browser.mjs`. All binaries are compiled from
these authored sources; no proprietary binaries are included.
