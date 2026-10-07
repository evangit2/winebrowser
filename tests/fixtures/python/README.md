# Original Windows CPython acceptance

The MIT-licensed `workload.py` exercises the unchanged official Python 3.8.10
Win32 embeddable package. `wine-oracle.json` was captured by running that package
on native Wine 11. It covers native decimal, SQLite, bzip2, LZMA, Unicode, XML
and Expat modules, with compression round trips, callbacks and persisted data.

`npm run test:python` downloads the hash-pinned official distribution to ignored
`.cache/` if needed. Set `WINEBROWSER_PYTHON_ZIP` to use a local original ZIP,
`WINEBROWSER_TEST_URL` for a production or Pages deployment, and optionally pass
`--chrome` for normal Chrome. No Python distribution binaries are published.

FFI (`ctypes`), OpenSSL, SSL and socket modules remain blocked by missing
imports. This workload does not establish support for arbitrary Python packages,
network services, or all Windows applications. Cold startup and translation
still take substantially longer than a few seconds.
