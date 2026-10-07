#!/usr/bin/env python3
"""Rebuild unmodified LAME 3.100 as a deterministic SSE2/UCRT Windows i386 CLI."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import tarfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT / '.cache/lame'
URL = 'https://downloads.sourceforge.net/project/lame/lame/3.100/lame-3.100.tar.gz'
SHA = 'ddfe36cab873794038ae2c1210557ad34857a4b6bdc515785d1da9e175b1da1e'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-archive', type=pathlib.Path)
    args = parser.parse_args()
    CACHE.mkdir(parents=True, exist_ok=True)
    archive = CACHE / 'lame-3.100.tar.gz'
    if args.source_archive:
        if args.source_archive.resolve() != archive:
            shutil.copyfile(args.source_archive, archive)
    elif not archive.exists():
        urllib.request.urlretrieve(URL, archive)
    if digest(archive) != SHA:
        raise SystemExit('LAME source hash mismatch')
    source = CACHE / 'source'
    if source.exists():
        shutil.rmtree(source)
    source.mkdir()
    with tarfile.open(archive, 'r:gz') as package:
        package.extractall(source, filter='data')
    source = source / 'lame-3.100'
    env = dict(os.environ, SOURCE_DATE_EPOCH='0', TZ='UTC', LC_ALL='C')
    flags = '-O2 -msse2 -mfpmath=sse -fno-ident'
    configure = [
        './configure', '--host=i686-w64-mingw32', '--disable-shared',
        '--enable-static', '--disable-decoder', '--disable-nasm',
        'CC=i686-w64-mingw32-gcc', 'CFLAGS=' + flags,
        'LDFLAGS=-static-libgcc -Wl,--no-insert-timestamp',
    ]
    with (CACHE / 'rebuild.log').open('w') as log:
        subprocess.run(configure, cwd=source, env=env, stdout=log,
                       stderr=subprocess.STDOUT, check=True)
        subprocess.run(['make', '-j4'], cwd=source, env=env, stdout=log,
                       stderr=subprocess.STDOUT, check=True)
    executable = CACHE / 'lame.exe'
    shutil.copyfile(source / 'frontend/lame.exe', executable)
    # BFD strip also writes the COFF timestamp; it needs the same epoch as ld.
    subprocess.run(['i686-w64-mingw32-strip', '--strip-all', str(executable)],
                   env=env, check=True)
    meta = {
        'project': 'LAME', 'version': '3.100', 'sourceUrl': URL,
        'sourceArchiveSha256': SHA, 'sourcePatches': [], 'target': 'Windows i386',
        'compiler': subprocess.check_output(
            ['i686-w64-mingw32-gcc', '--version'], text=True).splitlines()[0],
        'flags': flags, 'configure': configure, 'sourceDateEpoch': 0,
        'exeSha256': digest(executable),
        'libraries': 'Original libmp3lame and GCC support statically linked; Windows UCRT and Kernel32 loaded through the normal WineBrowser module provider.',
        'scope': 'Original command-line WAV/raw PCM encoder. Optional MP3 decoder and external libsndfile are not built; no executable bytes are patched.',
    }
    (CACHE / 'build.json').write_text(json.dumps(meta, indent=2) + '\n')
    print(json.dumps(meta, indent=2))


if __name__ == '__main__':
    main()
