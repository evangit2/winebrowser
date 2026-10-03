#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
sh demos/gui-controls/build.sh
mkdir -p public/examples/gui-controls
cp demos/gui-controls/gui-controls.exe public/examples/gui-controls/gui-controls.exe
python3 scripts/package-gui-controls.py
