#include <windows.h>
#include "trig-vectors.h"

static void verify(UINT test, const BYTE *actual, const BYTE *expected, WORD status, WORD expected_status, WORD top)
{
    for (UINT b = 0; b < 10; b++) if (actual[b] != expected[b]) ExitProcess(test * 4 + 1);
    if ((status & 0x3f) != (expected_status & 0x3f)) ExitProcess(test * 4 + 2);
    if ((status & 0x600) != (expected_status & 0x200)) ExitProcess(test * 4 + 3);
    if ((status & 0x3800) != top) ExitProcess(test * 4 + 4);
}
void start(void)
{
    BYTE sine[10], cosine[10];
    WORD status;
    for (UINT i = 0; i < sizeof(vectors) / sizeof(vectors[0]); i++) {
        const struct Vector *v = &vectors[i];
        __asm__ volatile("fninit; fldcw %2; fldt %3; fsin; fnstsw %1; fstpt %0"
            : "=m"(sine), "=m"(status) : "m"(v->control), "m"(v->x) : "st");
        verify(i*4, sine, v->sine, status, v->sin_status, 0x3800);
        __asm__ volatile("fninit; fldcw %2; fldt %3; fcos; fnstsw %1; fstpt %0"
            : "=m"(cosine), "=m"(status) : "m"(v->control), "m"(v->x) : "st");
        verify(i*4+1, cosine, v->cosine, status, v->cos_status, 0x3800);
        __asm__ volatile("fninit; fldcw %3; fldt %4; fsincos; fnstsw %2; fstpt %0; fstpt %1"
            : "=m"(cosine), "=m"(sine), "=m"(status) : "m"(v->control), "m"(v->x) : "st");
        verify(i*4+2, cosine, v->cosine, status, v->cos_status | (v->sin_status & 0x3f), 0x3000);
        verify(i*4+3, sine, v->sine, status, v->cos_status | (v->sin_status & 0x3f), 0x3000);
    }
    ExitProcess(0);
}
