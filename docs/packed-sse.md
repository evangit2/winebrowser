# Packed SSE/SSE2 compatibility

The shared x86 translator now executes legacy packed binary32/binary64
addition, subtraction, multiplication, division and square roots. MIN/MAX,
all eight legacy comparison predicates, signed int32 conversions and float-width
conversions preserve native lane widths and zeroing rules. Scalar MIN/MAX and
comparison-mask instructions use the same service. No executable-name branches
or patched program bytes select this behavior.

Berkeley SoftFloat computes IEEE values directly from raw words. MXCSR controls
rounding, DAZ, FTZ and sticky exception flags independently of x87. Every packed
lane is evaluated before committing the destination; unmasked exceptions report
an error and preserve the entire destination. Memory reads preflight complete
ranges and enforce legacy 128-bit alignment; 64-bit conversion inputs permit
unaligned addresses. MIN/MAX preserve the second operand for equal/unordered
results, including signed zero and original NaN payloads.

Raw PS/PD shuffles, high/low unpacking, MOVMSK, word/dword shifts, byte/word/dword
signed comparisons, byte/word equality and saturating signed/unsigned packs
also execute. Shift counts use the whole low 64 bits and saturate instead of
wrapping. Register aliases read old values before writing; integer flags and
MXCSR are unaffected by these integer/data-movement operations.

The [native reference matrix](../tests/fixtures/packed-sse/README.md) compares
8,400 register/memory results and MXCSR records byte for byte with independently
executed x86 instructions. CI also regenerates the reference on native Linux
x86_64. This expands useful SSE/SSE2 coverage; it does not advertise a complete
SSE/MMX family through CPUID. AVX, approximate reciprocal instructions, additional
SIMD instructions and delivery of guest #XM exceptions remain incomplete.
