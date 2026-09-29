"""Independent exact-rational oracle for x87 FSCALE vectors, not runtime code.

FSCALE is plain arithmetic (ST(0) * 2^trunc(ST(1))), so unlike the transcendental
generators this oracle needs no series: it forms the exact product as a Python
Fraction and rounds it with its own routine written directly from the operand and
exception rules.  The NaN ordering follows SoftFloat's propagateNaNExtF80UI, and
the hardware behaviour of the probe fixtures in scripts/build-x87-scale-fixture.sh
was cross-checked against an independent Wine run of 132 operands.
"""
from fractions import Fraction
from pathlib import Path
import json
import random

J = 1 << 63
Q = 1 << 62


def raw(sig, exponent, negative=False):
    return (sig.to_bytes(8, 'little') + (exponent | (0x8000 if negative else 0)).to_bytes(2, 'little')).hex()


def word(sig, exponent, negative=False):
    return {'sig': sig, 'exp': exponent, 'neg': negative}


def field(w):
    return raw(w['sig'], w['exp'], w['neg'])


def classify(w):
    """x87 extended-format class of one operand."""
    sig, exponent = w['sig'], w['exp']
    # Any encoding whose integer bit is clear outside the zero/subnormal form is
    # unsupported, including the pseudo-infinities and pseudo-NaNs at 0x7fff.
    unsupported = exponent != 0 and not (sig & J)
    nan = exponent == 0x7FFF and bool(sig & (J - 1))
    return {
        'unsupported': unsupported,
        'nan': nan,
        'signaling': nan and not (sig & Q),
        'infinity': exponent == 0x7FFF and sig == J,
        'zero': exponent == 0 and sig == 0,
        'subnormal': exponent == 0 and sig != 0,
    }


def propagate_nan(a, b):
    """SoftFloat softfloat_propagateNaNExtF80UI: quieting, signalling priority,
    then the larger-magnitude NaN with the first operand preferred on a tie."""
    ca, cb = classify(a), classify(b)
    flags = 1 if (ca['signaling'] or cb['signaling']) else 0
    if ca['signaling']:
        chosen = b if cb['nan'] else a
    elif cb['signaling']:
        chosen = a if ca['nan'] else b
    else:
        chosen = a if (a['exp'], a['sig']) > (b['exp'], b['sig']) else b
    return raw(chosen['sig'] | Q, 0x7FFF, chosen['neg']), flags


def overflow(negative, mode):
    to_infinity = mode == 0 or (mode == 1 and negative) or (mode == 2 and not negative)
    if to_infinity:
        return raw(J, 0x7FFF, negative), 0x28, True
    return raw(2 * J - 1, 0x7FFE, negative), 0x28, False


def round_exact(magnitude, negative, mode):
    """Round a positive exact Fraction to the nearest extended-format value."""
    e = magnitude.numerator.bit_length() - magnitude.denominator.bit_length()
    if magnitude < Fraction(2) ** e:
        e -= 1
    if e > 16383:
        return overflow(negative, mode)
    quantum = e - 63 if e >= -16382 else -16445
    scaled = magnitude / Fraction(2) ** quantum
    whole, remainder = divmod(scaled.numerator, scaled.denominator)
    if remainder == 0:
        rounding_up, inexact = False, False
    else:
        inexact = True
        if mode == 0:
            rounding_up = remainder * 2 > scaled.denominator or (
                remainder * 2 == scaled.denominator and whole & 1 == 1)
        elif mode == 1:
            rounding_up = negative
        elif mode == 2:
            rounding_up = not negative
        else:
            rounding_up = False
    significand = whole + (1 if rounding_up else 0)
    if significand >= 2 * J:
        significand >>= 1
        e += 1
    if e > 16383:
        return overflow(negative, mode)
    exponent_field = (1 if significand >= J else 0) if e < -16382 else e + 16383
    flags = (0x20 if inexact else 0) | (0x10 if inexact and exponent_field == 0 else 0)
    return raw(significand, exponent_field, negative), flags, rounding_up


def value(w):
    magnitude = Fraction(w['sig']) * Fraction(2) ** ((w['exp'] or 1) - 16383 - 63)
    return -magnitude if w['neg'] else magnitude


def int_word(n):
    """Exact extended-precision encoding of an integer ST(1) operand."""
    negative = n < 0
    m = abs(n)
    if m == 0:
        return word(0, 0, negative)
    e = m.bit_length() - 1
    return word((m << (63 - e)) if e <= 63 else (m >> (e - 63)), e + 16383, negative)


def fscale(a, b, mode):
    ca, cb = classify(a), classify(b)
    if ca['unsupported'] or cb['unsupported']:
        return raw(J | Q, 0x7FFF, True), 1, False
    denormal = 0x2 if ca['subnormal'] or cb['subnormal'] else 0
    if ca['nan'] or cb['nan']:
        string, flags = propagate_nan(a, b)
        return string, flags | denormal, False
    if ca['infinity']:
        if cb['infinity'] and b['neg']:
            return raw(J | Q, 0x7FFF, True), 1, False
        return field(a), denormal, False
    if cb['infinity']:
        if ca['zero'] and b['neg']:
            return field(a), denormal, False
        if ca['zero']:
            return raw(J | Q, 0x7FFF, True), 1, False
        if b['neg']:
            return raw(0, 0, a['neg']), denormal, False
        return raw(J, 0x7FFF, a['neg']), denormal, False
    if ca['zero']:
        return field(a), denormal, False
    # Truncate ST(1) toward zero.  Beyond 2^16 the exact product always overflows
    # or underflows every finite ST(0), and the instruction itself saturates the
    # exponent add, so the count is clamped there.
    scale = int(value(b))
    scale = 65536 if scale > 65536 else -65536 if scale < -65536 else scale
    scaled = value(a) * Fraction(2) ** scale if scale >= 0 else value(a) / Fraction(2) ** -scale
    string, flags, up = round_exact(abs(scaled), a['neg'], mode)
    return string, flags | denormal, up


cases = []


def case(name, a, b, control=0x037F):
    cases.append((name, a, b, control))


ONE, TWO, HALF = word(J, 16383), word(J, 16384), word(J, 16382)

# Exact scalings across the normal range, both directions and both signs.
case('one-scaled-by-one', ONE, ONE)                                  # 1 * 2^1 = 2
case('one-scaled-by-two', ONE, TWO)                                  # 1 * 2^2 = 4
case('two-scaled-by-half', TWO, HALF)                                # 2 * 2^0 = 2 (truncated)
case('one-scaled-by-minus-one', ONE, word(J, 16383, True))           # 1 * 2^-1
case('one-scaled-by-two-and-a-half', ONE, word(0xA000000000000000, 16384))
case('one-scaled-by-minus-two-and-a-half', ONE, word(0xA000000000000000, 16384, True))
case('one-scaled-by-two-and-three-quarters', ONE, word(0xB000000000000000, 16384))
case('one-scaled-by-minus-one-and-a-half', ONE, word(0xC000000000000000, 16383, True))
case('one-scaled-by-three-quarters', ONE, word(0xC000000000000000, 16382))
case('one-scaled-by-minus-three-quarters', ONE, word(0xC000000000000000, 16382, True))
case('one-scaled-by-minus-half', ONE, word(J, 16382, True))
case('one-scaled-by-subnormal', ONE, word(1, 0))
case('one-scaled-by-largest-subnormal', ONE, word(J - 1, 0))
case('one-scaled-by-subnormal-negative', ONE, word(1, 0, True))
# Significand low bits must survive the exponent-only scaling exactly.
case('lowbit-scaled-up-one', word(J + 1, 16383), TWO)
case('lowbit-scaled-down-one', word(J + 1, 16383), word(J, 16383, True))
case('negative-lowbit-scaled-down-one', word(J + 1, 16383, True), word(J, 16383, True))
case('lowbit-scaled-up-twenty', word(J + 1, 16383), word(J, 16394))
case('lowbit-scaled-down-twenty', word(J + 1, 16383), word(J, 16374))
case('lowbit-scaled-down-sixty-two', word(J + 1, 16383), word(J, 16321))
# Precision control is ignored; rounding control is honored.
for control in (0x037F, 0x027F, 0x007F):
    case(f'pc{control:04x}-lowbit-up', word(J + 1, 16383), TWO, control)
    case(f'pc{control:04x}-lowbit-down', word(J + 1, 16383), word(J, 16374), control)
    case(f'pc{control:04x}-subnormal-inexact', word(3, 0), word(J, 16383, True), control)
for mode in range(4):
    control = 0x037F | (mode << 10)
    case(f'rc{mode}-subnormal-tie-even', word(3, 0), word(J, 16383, True), control)
    case(f'rc{mode}-negative-subnormal-tie-even', word(3, 0, True), word(J, 16383, True), control)
    case(f'rc{mode}-subnormal-exact', word(5, 0), word(J, 16382, True), control)
    case(f'rc{mode}-underflow-to-zero', word(1, 0), word(J, 16383, True), control)
    case(f'rc{mode}-overflow-max', word(2 * J - 1, 32766), TWO, control)
    case(f'rc{mode}-overflow-negative-max', word(2 * J - 1, 32766, True), TWO, control)
    case(f'rc{mode}-tininess-tie', word(J + 1, 1), word(J, 16383, True), control)
# Gradual underflow and the normal/subnormal boundary in both directions.
case('min-normal-scaled-down-one', word(J, 1), word(J, 16383, True))
case('min-normal-scaled-down-two', word(J, 1), word(J, 16382, True))
case('min-normal-scaled-up-one', word(J, 1), TWO)
case('max-normal-scaled-up-one', word(2 * J - 1, 32766), TWO)
case('denormal-scaled-to-normal', word(1, 0), int_word(32768))
case('denormal-scaled-by-one', word(1, 0), ONE)
case('denormal-scaled-near-boundary', word(J - 1, 1), word(J, 16383, True))
case('normal-scaled-into-subnormal', word(J + 1, 1), word(J, 16383, True))
# Saturation of the exponent add.
for count in (32766, 32767, 32768, 65535, 65536, 100000, 2147483647):
    case(f'one-scaled-by-{count}', ONE, int_word(count))
for count in (-32768, -65536, -200000):
    case(f'one-scaled-by-minus-{abs(count)}', ONE, int_word(count))
case('max-normal-scaled-by-32767', word(2 * J - 1, 32766), int_word(32767))
case('min-normal-scaled-by-minus-32767', word(J, 1), int_word(-32767))
# Zeros and infinities.
ZERO, NZERO = word(0, 0), word(0, 0, True)
INF, NINF = word(J, 0x7FFF), word(J, 0x7FFF, True)
case('zero-scaled-by-one', ZERO, ONE)
case('negative-zero-scaled-by-one', NZERO, ONE)
case('zero-scaled-by-minus-one', ZERO, word(J, 16383, True))
case('zero-scaled-by-infinity', ZERO, INF)
case('zero-scaled-by-negative-infinity', ZERO, NINF)
case('negative-zero-scaled-by-negative-infinity', NZERO, NINF)
case('one-scaled-by-infinity', ONE, INF)
case('one-scaled-by-negative-infinity', ONE, NINF)
case('infinity-scaled-by-one', INF, ONE)
case('negative-infinity-scaled-by-one', NINF, ONE)
case('infinity-scaled-by-infinity', INF, INF)
case('infinity-scaled-by-negative-infinity', INF, NINF)
case('negative-infinity-scaled-by-infinity', NINF, INF)
case('negative-infinity-scaled-by-negative-infinity', NINF, NINF)
case('infinity-scaled-by-subnormal', INF, word(1, 0))
case('infinity-scaled-by-negative-subnormal', INF, word(1, 0, True))
# NaN propagation: quiet NaNs pass through, signaling NaNs raise #IA.
QNAN, SNAN = word(J | Q, 0x7FFF), word(J + 1, 0x7FFF)
case('one-scaled-by-quiet-nan', ONE, QNAN)
case('one-scaled-by-signaling-nan', ONE, SNAN)
case('quiet-nan-scaled-by-one', QNAN, ONE)
case('signaling-nan-scaled-by-one', SNAN, ONE)
case('negative-quiet-nan-scaled-by-one', word(J | Q, 0x7FFF, True), ONE)
case('negative-signaling-nan-scaled-by-one', word(J + 1, 0x7FFF, True), ONE)
case('both-signaling-nan', SNAN, word(J | 2, 0x7FFF))
case('quiet-nan-then-signaling-nan', QNAN, SNAN)
case('signaling-nan-then-quiet-nan', SNAN, QNAN)
case('quiet-nan-then-quiet-nan', QNAN, word(J | 0x77, 0x7FFF))
case('payload-quiet-nan-scaled-by-one', word(J | 0x123456789, 0x7FFF), ONE)
case('nan-scaled-by-infinity', QNAN, INF)
case('infinity-scaled-by-nan', INF, QNAN)
# Unsupported encodings, including the pseudo-infinities and pseudo-NaNs.
case('unsupported-a', word(Q, 16383), ONE)
case('unsupported-b', ONE, word(Q, 16383))
case('pseudo-infinity-a', word(0, 0x7FFF), ONE)
case('pseudo-infinity-b', ONE, word(0, 0x7FFF))
case('pseudo-nan-a', word(1, 0x7FFF), ONE)
case('pseudo-nan-b', ONE, word(1, 0x7FFF))
case('unsupported-scaled-by-unsupported', word(Q, 16383), word(Q, 16383))
# Deterministic random operands across the representable range.
rng = random.Random(0x5CA1E)
for i in range(48):
    a = word(rng.randrange(J, 2 * J), rng.randrange(1, 0x7FFF), bool(rng.randrange(2)))
    kind = rng.randrange(4)
    if kind == 0:
        b = word(rng.randrange(J, 2 * J), rng.randrange(0x3FFE, 0x400F), bool(rng.randrange(2)))
    elif kind == 1:
        b = word(rng.randrange(1, J), rng.randrange(0, 0x400E), bool(rng.randrange(2)))
    elif kind == 2:
        b = word(rng.randrange(0, J), 0, bool(rng.randrange(2)))
    else:
        b = word(rng.randrange(J, 2 * J), rng.randrange(0, 0x7FFF), bool(rng.randrange(2)))
    case(f'random-{i}', a, b, 0x037F | (rng.randrange(4) << 10))

vectors = []
for name, a, b, control in cases:
    output, flags, up = fscale(a, b, (control >> 10) & 3)
    vectors.append(dict(name=name, a=raw(a['sig'], a['exp'], a['neg']), b=raw(b['sig'], b['exp'], b['neg']),
                        control=control, output=output, flags=flags, roundedUp=up))

root = Path(__file__).resolve().parents[1]
output = root / 'tests/fixtures/x87-scale-vectors.json'
output.write_text(json.dumps(
    {'oracle': 'Python Fraction exact-product oracle with an independently written ext80 rounding '
               'routine, SoftFloat NaN precedence and hardware-checked ST(1) truncation; precision '
               'control is ignored and rounding control is honored', 'vectors': vectors}, indent=2) + '\n')
header = root / 'tests/fixtures/x87' / 'scale-vectors.h'
header.parent.mkdir(exist_ok=True)


def cbytes(text):
    return '{' + ','.join(f'0x{b:02x}' for b in bytes.fromhex(text)) + '}'


header.write_text(
    '// Generated by scripts/generate-x87-scale-vectors.py.\n'
    'static const struct Vector { BYTE a[10], b[10], output[10]; WORD control, status; } vectors[] = {\n'
    + ''.join('    {' + ', '.join([cbytes(v['a']), cbytes(v['b']), cbytes(v['output']),
                                   hex(v['control']), hex(v['flags'] | (0x200 if v['roundedUp'] else 0))]) + '},\n'
              for v in vectors)
    + '};\n')
print(f'wrote {len(vectors)} vectors')
