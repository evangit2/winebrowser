# DLL search directories

`LoadLibraryExA/W` now honors APPLICATION_DIR, SYSTEM32, DLL_LOAD_DIR and
DEFAULT_DIRS searches. The selected search applies to imported dependencies
and forwarded exports. An absolute filename locates the requested image while
the directory list continues to constrain its dependencies. Already loaded
DLLs retain their normal basename reuse behavior.

The native Wine loader computes user-directory lists with its original
AddDllDirectory, RemoveDllDirectory and SetDefaultDllDirectories. The browser
bridge preserves those lists, including an empty list. Removing a user directory
therefore reports missing DLL instead of finding an unrelated package-root copy.
SYSTEM32 refers to verified runtime components; it does not search application
files. A host-only USER_DIRS search has no registered user directories. User
directory management currently requires the native Wine base.

The authored PE32 ZIP acceptance uses distinct same-name DLLs in three
directories. It checks their returned identities, plugin attachment, transitive
imports, original Wine directory APIs, path queries, invalid combinations and
unloading. Unit coverage independently checks forwarded dependencies.

Build with `npm run build:dll-search`; test with
`WINEBROWSER_NORMAL_CHROMIUM=1 npm run test:dll-search`. Add WINEBROWSER_TEST_URL
to use static or live Pages hosting. Evidence is in
[browser results](../evidence/dll-search-browser-results.json).

Datafile/resource loads and signed-target enforcement remain unsupported.
Raw NT encoded search-flag pointers, activation-context side-by-side redirection,
arbitrary Windows filesystem paths and universal DLL compatibility are not
established by these tests.
