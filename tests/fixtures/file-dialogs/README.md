# Native file dialogs fixture

Original MIT-licensed PE32 source tests OPENFILENAME v4 A cancellation, A file
selection and reads, Unicode Save As and native file writes, Explorer Unicode
multiselect, insufficient output capacity and picker stop lifecycle. The
executable is built reproducibly with `npm run build:file-dialogs`. It is a
native test binary; its x86 code translates to WebAssembly inside Chromium.
