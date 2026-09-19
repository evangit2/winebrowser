# Berkeley SoftFloat ext80 module

This ES module factory wraps the pinned, unmodified Berkeley SoftFloat Release
3e sources with a small MIT licensed C adapter. It provides deterministic
x87-style 80-bit arithmetic for future x86 runtime use without including a CPU
or PC emulator. Import `softfloat.js`, call its default export, and allocate
arguments with `_malloc`. All multi-byte values use little endian byte order.

An extended value occupies exactly 10 bytes: its explicit 64-bit significand
at offsets 0–7 and its 16-bit sign/exponent at offsets 8–9. An operation state
occupies four bytes: rounding mode, precision control, tininess mode, and
output exception flags. `_wb_sf_init(state, 4, rounding, precision, tininess)`
validates and initializes it. Precision is the x87 significand width `24`,
`53`, or `64`; the adapter maps these to SoftFloat's `32`, `64`, and `80`
format precision controls. Tininess is `0` before or `1` after rounding.

Rounding values match SoftFloat: `0` nearest even, `1` toward zero, `2` toward
negative infinity, `3` toward positive infinity, `4` nearest with ties away,
and `6` odd. Exception bits are `1` inexact, `2` underflow, `4` overflow, `8`
infinite/divide-by-zero, and `16` invalid. Every arithmetic or conversion call
clears byte 3 before running and writes that call's flags afterward. The
adapter saves and restores SoftFloat's internal global controls around every
call, so separate state blocks do not affect one another.

## ABI

All functions return `0` on success, `-1` for an invalid pointer or buffer
length, `-2` for invalid state, and `-3` for an invalid operation. Every
pointer argument is followed by its byte length.

- `_wb_sf_binary(state,4,op,out,10,a,10,b,10)`: op 0 add, 1 subtract, 2
  multiply, or 3 divide.
- `_wb_sf_sqrt(state,4,out,10,a,10)`.
- `_wb_sf_round(state,4,out,10,a,10)`: round directly from ext80 to integral
  ext80 using the state's rounding mode. It preserves the full ext80 range and
  reports inexact or invalid without converting through a fixed-width integer.
- `_wb_sf_from_f32` and `_wb_sf_to_f32`: four raw IEEE binary32 bytes.
- `_wb_sf_from_f64` and `_wb_sf_to_f64`: eight raw IEEE binary64 bytes.
- `_wb_sf_from_i32`, `_wb_sf_to_i32`, `_wb_sf_from_i64`, and
  `_wb_sf_to_i64`: signed two's complement bytes. Float-to-integer conversions
  use the state's rounding mode and report inexact results.
- `_wb_sf_compare(state,4,result,4,a,10,b,10)`: writes `-1`, `0`, `1`, or `2`
  for less, equal, greater, or unordered. Signaling NaNs set invalid.
- `_wb_sf_classify(a,10)`: returns a bit set consisting of zero `1`, subnormal
  `2`, normal `4`, infinity `8`, quiet NaN `16`, signaling NaN `32`, and
  negative `64`. Negative status values indicate failure.

The factory also exports `_malloc`, `_free`, and `HEAPU8`. Data inputs and
outputs may alias because inputs are loaded before outputs are written; the
state block must be separate. Callers own every state and data buffer.

Run `python3 scripts/build-softfloat.py` to download the pinned official source,
verify its SHA-256, build with the repository Emscripten toolchain, and publish
the module plus exact source/relink materials. `public/runtime/softfloat/source`
contains the upstream archive, its license and README, the adapter and license,
and the build script. Berkeley SoftFloat retains its 3-clause BSD license in
`COPYING.txt`; the original adapter is covered by `ADAPTER-LICENSE`.
