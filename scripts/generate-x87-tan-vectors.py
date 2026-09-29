"""Independent Decimal oracle for finite FPTAN results, not runtime code.

Like scripts/generate-x87-trig-vectors.py this uses a Chudnovsky pi and a
tangent built from its own Taylor sine/cosine, so it shares no arithmetic with
src/x87-transcendentals.js.  Results are the mathematical tangent, matching the
file's documented scope: physical x87 finite-pi reduction errors are not
reproduced.
"""
from decimal import Decimal, localcontext, ROUND_HALF_EVEN, ROUND_CEILING, ROUND_FLOOR
from pathlib import Path
import json
import random

J = 1 << 63

def raw(sig, exponent, negative=False):
    return (sig.to_bytes(8, 'little') + (exponent | (0x8000 if negative else 0)).to_bytes(2, 'little')).hex()

def value(sig, exponent, negative=False):
    return Decimal(-sig if negative else sig) * Decimal(2) ** ((exponent or 1) - 16383 - 63)

def pi_chudnovsky():
    m, l, x, k = 1, 13591409, 1, 6
    total = Decimal(l)
    for i in range(1, 40):
        m = m * (k ** 3 - 16 * k) // i ** 3
        l += 545140134
        x *= -262537412640768000
        total += Decimal(m * l) / x
        k += 12
    return 426880 * Decimal(10005).sqrt() / total

def tan_series(x):
    """Tangent from its own sine and cosine Taylor sums (no library tan)."""
    def sine(v):
        term, total, index = v, v, 1
        for _ in range(2000):
            term *= -v * v / ((index + 1) * (index + 2))
            updated = total + term
            if total == updated:
                return total
            total, index = updated, index + 2
        raise RuntimeError('sine did not converge')
    def cosine(v):
        term, total, index = Decimal(1), Decimal(1), 0
        for _ in range(2000):
            term *= -v * v / ((index + 1) * (index + 2))
            updated = total + term
            if total == updated:
                return total
            total, index = updated, index + 2
        raise RuntimeError('cosine did not converge')
    return sine(x) / cosine(x)

def rounded(result, mode):
    negative = result.is_signed()
    magnitude = abs(result)
    # tan(0) is exactly zero, signed by the argument.
    if not magnitude:
        return dict(output=raw(0, 0, negative), flags=0, roundedUp=False)
    numerator, denominator = magnitude.as_integer_ratio()
    exponent = numerator.bit_length() - denominator.bit_length()
    if magnitude < Decimal(2) ** exponent:
        exponent -= 1
    scaled = magnitude / (Decimal(2) ** max(exponent - 63, -16445))
    rounding = [ROUND_HALF_EVEN, ROUND_CEILING if negative else ROUND_FLOOR,
                ROUND_FLOOR if negative else ROUND_CEILING, ROUND_FLOOR][mode]
    significand = int(scaled.to_integral_value(rounding=rounding))
    up = significand > scaled
    if significand >= 2 * J:
        significand >>= 1
        exponent += 1
    field = exponent + 16383 if exponent >= -16382 else int(significand >= J)
    return dict(output=raw(significand, field, negative),
                flags=0x20 | (0x10 if field == 0 else 0), roundedUp=up)

cases = [
    ('zero', 0, 0, False), ('negative-zero', 0, 0, True),
    ('one', J, 16383, False), ('negative-one', J, 16383, True),
    ('half', J, 16382, False), ('quarter', J, 16381, False),
    ('two', J, 16384, False), ('negative-two', J, 16384, True),
    ('three-quarters-pi', 0xc90fdaa22168c235, 16382, False),
    ('half-pi-neighbour', 0xc90fdaa22168c235, 16383, False),
    ('three-halves-pi-neighbour', 0x96cbe3f9990e91a7, 16384, False),
    ('pi-neighbour', 0xc90fdaa22168c235, 16384, False),
    ('tiny-2^-64', J, 16319, False), ('tiny-2^-68', J, 16315, False),
    ('tiny-2^-70', J, 16313, False),
    ('minimum-subnormal', 1, 0, False), ('largest-subnormal', J - 1, 0, False),
    ('negative-minimum-subnormal', 1, 0, True),
    ('third', 0xaaaaaaaaaaaaaaab, 16381, False),
    ('third-negative', 0xaaaaaaaaaaaaaaab, 16381, True),
    ('two-to-32', J, 16415, False), ('two-to-62', J, 16445, False),
    ('negative-two-to-62', J, 16445, True),
]
rng = random.Random(0xF7A4D0C1)
for i in range(32):
    cases.append((f'random-{i}', rng.randrange(J, 2 * J),
                  rng.randrange(16319, 16446), bool(rng.randrange(2))))

vectors = []
with localcontext() as ctx:
    ctx.prec = 500
    pi = pi_chudnovsky()
    for name, sig, exponent, negative in cases:
        # Tiny arguments barely differ from x, so raise precision to keep the
        # cubic term visible in the correctly rounded result.
        ctx.prec = max(420, 200 + int(max(0, 16383 - (exponent or 1)) * 0.61) + 80)
        x = value(sig, exponent, negative)
        if abs(x) > 1:
            multiple = (x / (2 * pi)).to_integral_value(rounding=ROUND_HALF_EVEN)
            x -= multiple * (2 * pi)
        denormal = 2 if exponent == 0 and sig else 0
        if not sig:
            # tan(+/-0) is the same signed zero and raises nothing.
            for mode in range(4):
                vectors.append(dict(name=name, x=raw(sig, exponent, negative), mode=mode,
                                    result=dict(output=raw(0, 0, negative), flags=0,
                                                roundedUp=False), denormal=0))
            continue
        result = tan_series(x)
        for mode in range(4):
            vectors.append(dict(name=name, x=raw(sig, exponent, negative), mode=mode,
                                result=rounded(result, mode), denormal=denormal))

# |x| >= 2^63 is the documented C2 out-of-range case; record it separately so
# the native fixture can check the flag and untouched stack.
out_of_range = [
    ('two-to-63', raw(J, 16446)),
    ('two-to-64', raw(J, 16447)),
    ('negative-two-to-63', raw(J, 16446, True)),
]

flat = [dict(name=v['name'], x=v['x'], mode=v['mode'], output=v['result']['output'],
             flags=v['result']['flags'] | v['denormal'], roundedUp=v['result']['roundedUp'])
        for v in vectors]
root = Path(__file__).resolve().parents[1]
fixture = root / 'tests/fixtures'
(fixture / 'x87-tan-vectors.json').write_text(json.dumps(dict(
    oracle='Python Decimal tangent from independent Taylor sine/cosine with Chudnovsky pi; 420+ decimal digits, adaptive for tiny arguments; mathematical tangent',
    outOfRange=out_of_range,
    vectors=flat), indent=2) + '\n')

def cbytes(text):
    return '{' + ','.join(f'0x{b:02x}' for b in bytes.fromhex(text)) + '}'

(fixture / 'x87' / 'tan-vectors.h').write_text(
    '// Generated by scripts/generate-x87-tan-vectors.py.\n'
    'static const struct Vector { BYTE x[10], output[10]; WORD control, status; } vectors[] = {\n'
    + ''.join('    {' + ', '.join([cbytes(v['x']), cbytes(v['output']), hex(0x037f | (v['mode'] << 10)),
                                   hex(v['flags'] | (0x200 if v['roundedUp'] else 0))]) + '},\n'
              for v in flat)
    + '};\n'
    '\n// |x| >= 2^63 sets C2 and leaves the stack untouched.\n'
    'static const BYTE outOfRange[][10] = {\n'
    + ''.join('    ' + cbytes(value) + ',  /* ' + name + ' */\n' for name, value in out_of_range)
    + '};\n')
print(f'wrote {len(vectors)} vectors and {len(out_of_range)} out-of-range cases')
