#include <windows.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
static const DWORD original[4] = {1,2,0xdeadbeef,0xcafefeed};
static const DWORD source[4] = {0x12345678,0x7ff80000,7,8};
static const BYTE unaligned[16] = {0,0x11,0x22,0x33,0x44,0x55,0x66,0x77,0x88};
static const struct { LONG integer; DWORD low, high; } integers[] = {
    {0,0,0}, {1,0,0x3ff00000}, {-1,0,0xbff00000},
    {0x7fffffff,0xffc00000,0x41dfffff}, {(LONG)0x80000000,0,0xc1e00000},
    {0x1000001,0x10000000,0x41700000}
};
static DWORD result[4];
static BYTE stored[16];

void start(void)
{
    __asm__ volatile("movdqu %1,%%xmm0; movdqu %2,%%xmm1; movsd %%xmm1,%%xmm0; movdqu %%xmm0,%0"
        : "=m"(result) : "m"(original), "m"(source) : "xmm0","xmm1");
    CHECK(result[0] == source[0] && result[1] == source[1]);
    CHECK(result[2] == original[2] && result[3] == original[3]);
    __asm__ volatile("movdqu %1,%%xmm0; movdqu %2,%%xmm1; movss %%xmm1,%%xmm0; movdqu %%xmm0,%0"
        : "=m"(result) : "m"(original), "m"(source) : "xmm0","xmm1");
    CHECK(result[0] == source[0] && result[1] == original[1]);
    CHECK(result[2] == original[2] && result[3] == original[3]);
    __asm__ volatile("movdqu %1,%%xmm0; movsd %2,%%xmm0; movdqu %%xmm0,%0"
        : "=m"(result) : "m"(original), "m"(*(const ULONGLONG *)(unaligned+1)) : "xmm0");
    CHECK(result[0] == 0x44332211 && result[1] == 0x88776655 && !result[2] && !result[3]);
    for (UINT i=0;i<16;i++) stored[i]=0x5a;
    __asm__ volatile("movdqu %1,%%xmm0; movsd %%xmm0,%0"
        : "=m"(*(ULONGLONG *)(stored+1)) : "m"(source) : "xmm0");
    CHECK(*(DWORD *)(stored+1) == source[0] && *(DWORD *)(stored+5) == source[1]);
    CHECK(stored[0] == 0x5a && stored[9] == 0x5a && stored[15] == 0x5a);
    __asm__ volatile("movdqu %1,%%xmm0; movss %2,%%xmm0; movdqu %%xmm0,%0"
        : "=m"(result) : "m"(original), "m"(*(const DWORD *)(unaligned+1)) : "xmm0");
    CHECK(result[0] == 0x44332211 && !result[1] && !result[2] && !result[3]);
    for (UINT i=0;i<16;i++) stored[i]=0x5a;
    __asm__ volatile("movdqu %1,%%xmm0; movss %%xmm0,%0"
        : "=m"(*(DWORD *)(stored+1)) : "m"(source) : "xmm0");
    CHECK(*(DWORD *)(stored+1) == source[0]);
    CHECK(stored[0] == 0x5a && stored[5] == 0x5a && stored[15] == 0x5a);
    for (UINT i=0;i<sizeof(integers)/sizeof(integers[0]);i++) {
        __asm__ volatile("movdqu %1,%%xmm0; cvtsi2sd %2,%%xmm0; movdqu %%xmm0,%0"
            : "=m"(result) : "m"(original), "r"(integers[i].integer) : "xmm0");
        CHECK(result[0] == integers[i].low && result[1] == integers[i].high);
        CHECK(result[2] == original[2] && result[3] == original[3]);
        __asm__ volatile("movdqu %1,%%xmm0; cvtsi2sd %2,%%xmm0; movdqu %%xmm0,%0"
            : "=m"(result) : "m"(original), "m"(integers[i].integer) : "xmm0");
        CHECK(result[0] == integers[i].low && result[1] == integers[i].high);
        CHECK(result[2] == original[2] && result[3] == original[3]);
    }
    ExitProcess(0);
}
