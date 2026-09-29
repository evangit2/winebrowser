#include <windows.h>
#include "tan-vectors.h"

/* FPTAN replaces ST(0) with tan(x) and then pushes 1.0, so the FIRST pop
   returns the constant and the SECOND the tangent. Run each vector on a fresh
   FPU, compare the tangent bytes and status word, then check the pushed
   constant and the stack top. */
void start(void)
{
    BYTE tangent[10], constant[10];
    WORD status;
    for (UINT i = 0; i < sizeof(vectors) / sizeof(vectors[0]); i++) {
        const struct Vector *v = &vectors[i];
        __asm__ volatile("fninit; fldcw %3; fldt %4; fptan; fnstsw %1; fstpt %2; fstpt %0"
            : "=m"(tangent), "=m"(status), "=m"(constant)
            : "m"(v->control), "m"(v->x) : "st");
        for (UINT b = 0; b < 10; b++) if (tangent[b] != v->output[b]) ExitProcess(i * 4 + 1);
        if ((status & 0x3f) != (v->status & 0x3f)) ExitProcess(i * 4 + 2);
        if ((status & 0x600) != (v->status & 0x200)) ExitProcess(i * 4 + 3);
        if ((status & 0x3800) != 0x3000) ExitProcess(i * 4 + 4);
        if (constant[0] != 0 || constant[1] != 0 || constant[2] != 0 || constant[3] != 0 ||
            constant[4] != 0 || constant[5] != 0 || constant[6] != 0 || constant[7] != 0x80 ||
            constant[8] != 0xff || constant[9] != 0x3f) ExitProcess(i * 4 + 5);
    }
    // |x| >= 2^63 sets C2, leaves C0/C1/C3 clear and does not touch the stack.
    for (UINT i = 0; i < sizeof(outOfRange) / sizeof(outOfRange[0]); i++) {
        BYTE probe[10];
        __asm__ volatile("fninit; fldt %2; fptan; fnstsw %1; fstpt %0"
            : "=m"(probe), "=m"(status) : "m"(outOfRange[i]) : "st");
        if ((status & 0x600) != 0x400) ExitProcess(220 * 4 + 1);
        if ((status & 0x3800) != 0x3800) ExitProcess(220 * 4 + 2);
        for (UINT b = 0; b < 10; b++) if (probe[b] != outOfRange[i][b]) ExitProcess(220 * 4 + 3);
    }
    ExitProcess(0);
}
