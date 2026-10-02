"""Exact Fraction oracle plus optional independent native x87 audit.

Run on x86_64 Linux/macOS with a C compiler, or macOS ARM with Rosetta 2.
Rosetta's large-quotient FPREM1 disagreement is recorded, never used as truth.
--check-native requires agreement with the exact mathematical finite results.
"""
from fractions import Fraction
from pathlib import Path
import argparse
import json
import platform
import random
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--check-native', action='store_true')
options = parser.parse_args()
J = 1 << 63

def pack(sig, exponent):
    return (sig.to_bytes(8, 'little') + exponent.to_bytes(2, 'little')).hex()

def integer(n):
    if not n:
        return pack(0, 0)
    bits = abs(n).bit_length()
    return pack(abs(n) << (64 - bits), 16382 + bits + (0x8000 if n < 0 else 0))

def decode(s):
    b = bytes.fromhex(s)
    m, field = int.from_bytes(b[:8], 'little'), int.from_bytes(b[8:], 'little')
    exponent = field & 0x7fff
    if exponent == 0x7fff or (exponent and not m >> 63):
        return None
    power, n = (exponent or 1) - 16383 - 63, -m if field & 0x8000 else m
    return Fraction(n * (1 << power)) if power >= 0 else Fraction(n, 1 << -power)

def encode(value, negative_zero=False):
    if not value:
        return pack(0, 0x8000 if negative_zero else 0)
    sign, magnitude = (0x8000 if value < 0 else 0), abs(value)
    n, d = magnitude.numerator, magnitude.denominator
    assert not d & (d - 1)
    exponent = n.bit_length() - d.bit_length()
    field = max(0, exponent + 16383)
    power = (field or 1) - 16383 - 63
    sig = magnitude * (1 << -power) if power < 0 else magnitude / Fraction(1 << power)
    assert sig.denominator == 1 and sig < 1 << 64
    return pack(int(sig), field | sign)

rng = random.Random(1790977)
pairs = [(integer(a), integer(b)) for a in [0,1,5,6,7,13,15,-1,-7,-13,-15] for b in [1,2,3,-2,-3]]
for _ in range(120):
    e = rng.choice([1,2,16382,16383,16446,17000,25000,32766])
    f = max(1, min(32766, e + rng.choice([-32765,-120,-64,-63,-10,0,1,50])))
    pairs.append((pack(J | rng.getrandbits(63), e + (0x8000 if rng.randrange(2) else 0)),
                  pack(J | rng.getrandbits(63), f + (0x8000 if rng.randrange(2) else 0))))
for a in [pack(0,0),pack(0,0x8000),pack(1,0),pack(0x123456789,0),pack(J,0x7fff),pack(J,0xffff),
          pack(J|0x4000000000000042,0x7fff),pack(J|0x12345,0x7fff),pack(1,1)]:
    for b in [pack(0,0),pack(1,0),pack(J,0x3fff),pack(J,0x7fff)]:
        pairs.append((a,b))
with tempfile.TemporaryDirectory() as directory:
    exe = Path(directory) / 'x87-remainder-oracle'
    rosetta = platform.system() == 'Darwin' and platform.machine() == 'arm64'
    subprocess.run(['cc', *(['-arch','x86_64'] if rosetta else []), '-O2',
                    str(ROOT / 'scripts/lib/x87-remainder-oracle.c'), '-o', str(exe)], check=True)
    native = subprocess.run([*(['arch','-x86_64'] if rosetta else []), str(exe)],
                            input=''.join(a+' '+b+'\n' for a,b in pairs), text=True,
                            capture_output=True, check=True).stdout.splitlines()
assert len(native) == len(pairs)
vectors, differences = [], []
for (a,b), line in zip(pairs, native):
    cells = line.split()
    for nearest in [False,True]:
        offset = 3 * int(nearest)
        result, status = cells[offset], int(cells[offset+1],16) & 0x47ff
        x, y = decode(a), decode(b)
        if x is not None and y is not None and y:
            quotient = round(x / y) if nearest else int(x / y)
            expected = encode(x - quotient*y, bytes.fromhex(a)[9] & 128)
            bits = abs(quotient) & 7
            expected_status = (status & 0x3f) | ((bits & 4) << 6) | ((bits & 2) << 13) | ((bits & 1) << 9)
            if result != expected or status != expected_status:
                differences.append(dict(a=a,b=b,nearest=nearest,nativeResult=result,
                                        nativeStatus=status,expected=expected,expectedStatus=expected_status))
            result, status = expected, expected_status
        vectors.append(dict(a=a,b=b,nearest=nearest,result=result,status=status))
if options.check_native:
    if differences:
        raise SystemExit(json.dumps(differences, indent=2))
    print('Native x87 audit agrees with exact rational finite results:', len(vectors), 'cases')
else:
    output = ROOT / 'tests/fixtures/x87-remainder-vectors.json'
    output.write_text(json.dumps(dict(oracle='Python fractions.Fraction exact rational remainder, with nearest ties-to-even round() or truncating int(); exceptional cases independently executed as x86 x87 through macOS Rosetta 2. Rosetta finite-range disagreements are recorded separately.', vectors=vectors), indent=2)+'\n')
    print('Generated', len(vectors), 'cases;', len(differences), 'native finite-range disagreements')
