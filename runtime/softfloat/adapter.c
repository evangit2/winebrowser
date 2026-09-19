/* MIT-licensed browser adapter for Berkeley SoftFloat Release 3e. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <emscripten/heap.h>
#include "platform.h"
#include "softfloat.h"

enum { WB_OK = 0, WB_BOUNDS = -1, WB_STATE = -2, WB_OPERATION = -3 };
enum { WB_ADD = 0, WB_SUB = 1, WB_MUL = 2, WB_DIV = 3 };

typedef struct {
    uint8_t rounding; /* SoftFloat: 0,1,2,3,4,6. */
    uint8_t precision; /* x87 significand bits: 24,53,64. */
    uint8_t tininess; /* 0 before rounding, 1 after rounding. */
    uint8_t flags; /* SoftFloat exception flags from the completed call. */
} wb_state;

typedef struct {
    uint_fast8_t rounding, precision, tininess, flags;
} saved_state;

static bool bounded(const void *pointer, size_t length)
{
    uintptr_t address = (uintptr_t)pointer;
    size_t heap = emscripten_get_heap_size();
    return address && address <= heap && length <= heap - address;
}

static uint64_t read_u64(const uint8_t *p)
{
    uint64_t value = 0;
    for (unsigned i = 0; i < 8; ++i) value |= (uint64_t)p[i] << (8 * i);
    return value;
}

static void write_u64(uint8_t *p, uint64_t value)
{
    for (unsigned i = 0; i < 8; ++i) p[i] = (uint8_t)(value >> (8 * i));
}

static uint32_t read_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static void write_u32(uint8_t *p, uint32_t value)
{
    for (unsigned i = 0; i < 4; ++i) p[i] = (uint8_t)(value >> (8 * i));
}

static extFloat80_t read_ext(const uint8_t *p)
{
    extFloat80_t value;
    value.signif = read_u64(p);
    value.signExp = (uint16_t)(p[8] | (uint16_t)p[9] << 8);
    return value;
}

static void write_ext(uint8_t *p, extFloat80_t value)
{
    write_u64(p, value.signif);
    p[8] = (uint8_t)value.signExp;
    p[9] = (uint8_t)(value.signExp >> 8);
}

static int begin(wb_state *state, saved_state *saved)
{
    if (!bounded(state, sizeof(*state))) return WB_BOUNDS;
    if (!((state->rounding <= 4) || state->rounding == 6)) return WB_STATE;
    if (!(state->precision == 24 || state->precision == 53 || state->precision == 64)) return WB_STATE;
    if (state->tininess > 1) return WB_STATE;
    saved->rounding = softfloat_roundingMode;
    saved->precision = extF80_roundingPrecision;
    saved->tininess = softfloat_detectTininess;
    saved->flags = softfloat_exceptionFlags;
    softfloat_roundingMode = state->rounding;
    extF80_roundingPrecision = state->precision == 24 ? 32 : state->precision == 53 ? 64 : 80;
    softfloat_detectTininess = state->tininess;
    softfloat_exceptionFlags = 0;
    return WB_OK;
}

static int finish(wb_state *state, const saved_state *saved, int status)
{
    state->flags = softfloat_exceptionFlags;
    softfloat_roundingMode = saved->rounding;
    extF80_roundingPrecision = saved->precision;
    softfloat_detectTininess = saved->tininess;
    softfloat_exceptionFlags = saved->flags;
    return status;
}

int wb_sf_init(wb_state *state, uint32_t state_size, uint32_t rounding,
        uint32_t precision, uint32_t tininess)
{
    if (state_size < sizeof(*state) || !bounded(state, state_size)) return WB_BOUNDS;
    if (!((rounding <= 4) || rounding == 6) ||
            !(precision == 24 || precision == 53 || precision == 64) || tininess > 1) return WB_STATE;
    state->rounding = (uint8_t)rounding;
    state->precision = (uint8_t)precision;
    state->tininess = (uint8_t)tininess;
    state->flags = 0;
    saved_state saved;
    int status = begin(state, &saved);
    if (status) return status;
    return finish(state, &saved, WB_OK);
}

int wb_sf_binary(wb_state *state, uint32_t state_size, uint32_t operation,
        uint8_t *out, uint32_t out_size, const uint8_t *a, uint32_t a_size,
        const uint8_t *b, uint32_t b_size)
{
    if (state_size < 4 || out_size < 10 || a_size < 10 || b_size < 10 ||
            !bounded(out, out_size) || !bounded(a, a_size) || !bounded(b, b_size)) return WB_BOUNDS;
    saved_state saved;
    int status = begin(state, &saved);
    if (status) return status;
    extFloat80_t av = read_ext(a), bv = read_ext(b), result;
    if (operation == WB_ADD) extF80M_add(&av, &bv, &result);
    else if (operation == WB_SUB) extF80M_sub(&av, &bv, &result);
    else if (operation == WB_MUL) extF80M_mul(&av, &bv, &result);
    else if (operation == WB_DIV) extF80M_div(&av, &bv, &result);
    else return finish(state, &saved, WB_OPERATION);
    write_ext(out, result);
    return finish(state, &saved, WB_OK);
}

int wb_sf_sqrt(wb_state *state, uint32_t state_size, uint8_t *out,
        uint32_t out_size, const uint8_t *a, uint32_t a_size)
{
    if (state_size < 4 || out_size < 10 || a_size < 10 ||
            !bounded(out, out_size) || !bounded(a, a_size)) return WB_BOUNDS;
    saved_state saved;
    int status = begin(state, &saved);
    if (status) return status;
    extFloat80_t av = read_ext(a), result;
    extF80M_sqrt(&av, &result);
    write_ext(out, result);
    return finish(state, &saved, WB_OK);
}

int wb_sf_round(wb_state *state, uint32_t state_size, uint8_t *out,
        uint32_t out_size, const uint8_t *a, uint32_t a_size)
{
    if (state_size < 4 || out_size < 10 || a_size < 10 ||
            !bounded(out, out_size) || !bounded(a, a_size)) return WB_BOUNDS;
    saved_state saved;
    int status = begin(state, &saved);
    if (status) return status;
    extFloat80_t av = read_ext(a), result;
    extF80M_roundToInt(&av, state->rounding, true, &result);
    write_ext(out, result);
    return finish(state, &saved, WB_OK);
}

int wb_sf_from_f32(wb_state *state, uint32_t state_size, uint8_t *out,
        uint32_t out_size, const uint8_t *in, uint32_t in_size)
{
    if (state_size < 4 || out_size < 10 || in_size < 4 ||
            !bounded(out, out_size) || !bounded(in, in_size)) return WB_BOUNDS;
    saved_state saved; int status = begin(state, &saved); if (status) return status;
    float32_t value = {read_u32(in)};
    extFloat80_t result;
    f32_to_extF80M(value, &result);
    write_ext(out, result);
    return finish(state, &saved, WB_OK);
}

int wb_sf_to_f32(wb_state *state, uint32_t state_size, uint8_t *out,
        uint32_t out_size, const uint8_t *in, uint32_t in_size)
{
    if (state_size < 4 || out_size < 4 || in_size < 10 ||
            !bounded(out, out_size) || !bounded(in, in_size)) return WB_BOUNDS;
    saved_state saved; int status = begin(state, &saved); if (status) return status;
    extFloat80_t value = read_ext(in);
    write_u32(out, extF80M_to_f32(&value).v);
    return finish(state, &saved, WB_OK);
}

int wb_sf_from_f64(wb_state *state, uint32_t state_size, uint8_t *out,
        uint32_t out_size, const uint8_t *in, uint32_t in_size)
{
    if (state_size < 4 || out_size < 10 || in_size < 8 ||
            !bounded(out, out_size) || !bounded(in, in_size)) return WB_BOUNDS;
    saved_state saved; int status = begin(state, &saved); if (status) return status;
    float64_t value = {read_u64(in)};
    extFloat80_t result;
    f64_to_extF80M(value, &result);
    write_ext(out, result);
    return finish(state, &saved, WB_OK);
}

int wb_sf_to_f64(wb_state *state, uint32_t state_size, uint8_t *out,
        uint32_t out_size, const uint8_t *in, uint32_t in_size)
{
    if (state_size < 4 || out_size < 8 || in_size < 10 ||
            !bounded(out, out_size) || !bounded(in, in_size)) return WB_BOUNDS;
    saved_state saved; int status = begin(state, &saved); if (status) return status;
    extFloat80_t value = read_ext(in);
    write_u64(out, extF80M_to_f64(&value).v);
    return finish(state, &saved, WB_OK);
}

int wb_sf_from_i32(wb_state *state, uint32_t state_size, uint8_t *out,
        uint32_t out_size, const uint8_t *in, uint32_t in_size)
{
    if (state_size < 4 || out_size < 10 || in_size < 4 ||
            !bounded(out, out_size) || !bounded(in, in_size)) return WB_BOUNDS;
    saved_state saved; int status = begin(state, &saved); if (status) return status;
    extFloat80_t result;
    i32_to_extF80M((int32_t)read_u32(in), &result);
    write_ext(out, result);
    return finish(state, &saved, WB_OK);
}

int wb_sf_to_i32(wb_state *state, uint32_t state_size, uint8_t *out,
        uint32_t out_size, const uint8_t *in, uint32_t in_size)
{
    if (state_size < 4 || out_size < 4 || in_size < 10 ||
            !bounded(out, out_size) || !bounded(in, in_size)) return WB_BOUNDS;
    saved_state saved; int status = begin(state, &saved); if (status) return status;
    extFloat80_t value = read_ext(in);
    write_u32(out, (uint32_t)extF80M_to_i32(&value, state->rounding, true));
    return finish(state, &saved, WB_OK);
}

int wb_sf_from_i64(wb_state *state, uint32_t state_size, uint8_t *out,
        uint32_t out_size, const uint8_t *in, uint32_t in_size)
{
    if (state_size < 4 || out_size < 10 || in_size < 8 ||
            !bounded(out, out_size) || !bounded(in, in_size)) return WB_BOUNDS;
    saved_state saved; int status = begin(state, &saved); if (status) return status;
    extFloat80_t result;
    i64_to_extF80M((int64_t)read_u64(in), &result);
    write_ext(out, result);
    return finish(state, &saved, WB_OK);
}

int wb_sf_to_i64(wb_state *state, uint32_t state_size, uint8_t *out,
        uint32_t out_size, const uint8_t *in, uint32_t in_size)
{
    if (state_size < 4 || out_size < 8 || in_size < 10 ||
            !bounded(out, out_size) || !bounded(in, in_size)) return WB_BOUNDS;
    saved_state saved; int status = begin(state, &saved); if (status) return status;
    extFloat80_t value = read_ext(in);
    write_u64(out, (uint64_t)extF80M_to_i64(&value, state->rounding, true));
    return finish(state, &saved, WB_OK);
}

int wb_sf_compare(wb_state *state, uint32_t state_size, int32_t *out,
        uint32_t out_size, const uint8_t *a, uint32_t a_size,
        const uint8_t *b, uint32_t b_size)
{
    if (state_size < 4 || out_size < 4 || a_size < 10 || b_size < 10 ||
            !bounded(out, out_size) || !bounded(a, a_size) || !bounded(b, b_size)) return WB_BOUNDS;
    saved_state saved; int status = begin(state, &saved); if (status) return status;
    extFloat80_t av = read_ext(a), bv = read_ext(b);
    bool a_nan = (av.signExp & 0x7fff) == 0x7fff && av.signif != UINT64_C(0x8000000000000000);
    bool b_nan = (bv.signExp & 0x7fff) == 0x7fff && bv.signif != UINT64_C(0x8000000000000000);
    if (a_nan || b_nan) {
        if (extF80M_isSignalingNaN(&av) || extF80M_isSignalingNaN(&bv)) softfloat_raiseFlags(softfloat_flag_invalid);
        *out = 2;
    } else if (extF80M_eq(&av, &bv)) *out = 0;
    else if (extF80M_lt_quiet(&av, &bv)) *out = -1;
    else *out = 1;
    return finish(state, &saved, WB_OK);
}

int wb_sf_classify(const uint8_t *in, uint32_t in_size)
{
    if (in_size < 10 || !bounded(in, in_size)) return WB_BOUNDS;
    extFloat80_t value = read_ext(in);
    uint16_t exponent = value.signExp & 0x7fff;
    int result = (value.signExp & 0x8000) ? 64 : 0;
    if (!exponent) result |= value.signif ? 2 : 1;
    else if (exponent != 0x7fff) result |= 4;
    else if (value.signif == UINT64_C(0x8000000000000000)) result |= 8;
    else result |= extF80M_isSignalingNaN(&value) ? 32 : 16;
    return result;
}
