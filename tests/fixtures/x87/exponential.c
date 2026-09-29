#include <windows.h>
#include "exp-vectors.h"

/* Each vector records its raw x87 status word so the probe can be compared
   against the independent Decimal oracle byte for byte. */
void start(void)
{
    BYTE result[10];
    WORD status;
    for (UINT i = 0; i < sizeof(vectors) / sizeof(vectors[0]); i++) {
        const struct Vector *v = &vectors[i];
        __asm__ volatile("fninit; fldcw %2; fldt %3; f2xm1; fnstsw %1; fstpt %0"
            : "=m"(result), "=m"(status) : "m"(v->control), "m"(v->x) : "st");
        for (UINT b = 0; b < 10; b++) if (result[b] != v->output[b]) ExitProcess(i * 4 + 1);
        if ((status & 0x3f) != (v->status & 0x3f)) ExitProcess(i * 4 + 2);
        if ((status & 0x200) != (v->status & 0x200)) ExitProcess(i * 4 + 3);
        if ((status & 0x3800) != 0x3800) ExitProcess(i * 4 + 4);
    }
    ExitProcess(0);
}
