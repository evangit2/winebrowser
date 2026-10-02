# Native x87 remainder regression

Repository-authored PE32, MIT licensed. It executes FPREM/FPREM1 over 422
independent ext80 cases and compares bytes, exception flags and quotient bits
across twelve control-word configurations. The generated header comes from
the exact Python rational oracle; no application assets are included.

Rebuild with `sh scripts/build-x87-remainder.sh`; run the ordinary EXE-upload
regression with `node scripts/test-x87-remainder-browser.mjs`.
