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


static DWORD mxcsr, observed, integer_result, condition_flags;
static const DWORD f_one[4] = {0x3f800000,2,0xdeadbeef,0xcafefeed};
static const DWORD f_half_ulp[4] = {0x33800000,0,0,0};
static const DWORD d_one[4] = {0,0x3ff00000,0xdeadbeef,0xcafefeed};
static const DWORD d_half_ulp[4] = {0,0x3ca00000,0,0};
static const DWORD f_four[4] = {0x40800000,0,0,0};
static const DWORD d_four[4] = {0,0x40100000,0,0};
static const DWORD tiny[4] = {1,0,0,0};
static const DWORD min_normal[4] = {0x800000,0,0,0};
static const DWORD half[4] = {0x3f000000,0,0,0};
static const DWORD qnan[4] = {0x7fc00001,0,0,0};
static const LONG rounded_integer = 0x1000001;
#define LOAD_CONTROL(value) do { mxcsr=(value); __asm__ volatile("ldmxcsr %0"::"m"(mxcsr)); } while(0)
#define READ_MXCSR() __asm__ volatile("stmxcsr %0":"=m"(observed))
#define BINARY(op,left,right) __asm__ volatile( \
    "movdqu %1,%%xmm0; movdqu %2,%%xmm1; " op " %%xmm1,%%xmm0; movdqu %%xmm0,%0" \
    : "=m"(result) : "m"(left), "m"(right) : "xmm0","xmm1")
#define MEMORY(op,left,right) __asm__ volatile( \
    "movdqu %1,%%xmm0; " op " %2,%%xmm0; movdqu %%xmm0,%0" \
    : "=m"(result) : "m"(left), "m"(right) : "xmm0")
static void arithmetic(void)
{
    for (UINT mode=0;mode<4;mode++) {
        LOAD_CONTROL(0x1f80 | mode<<13);
        BINARY("addss",f_one,f_half_ulp); READ_MXCSR();
        CHECK(result[0] == 0x3f800000 + (mode==2));
        CHECK(result[1]==2 && result[2]==0xdeadbeef && result[3]==0xcafefeed);
        CHECK(observed==(mxcsr|32));
        LOAD_CONTROL(0x1f80 | mode<<13);
        MEMORY("addsd",d_one,*(const ULONGLONG *)d_half_ulp); READ_MXCSR();
        CHECK(result[0] == (mode==2) && result[1]==0x3ff00000);
        CHECK(result[2]==0xdeadbeef && result[3]==0xcafefeed && observed==(mxcsr|32));
        LOAD_CONTROL(0x1f80 | mode<<13);
        __asm__ volatile("cvtsi2ss %1,%%xmm0; movss %%xmm0,%0"
            : "=m"(result[0]) : "m"(rounded_integer) : "xmm0"); READ_MXCSR();
        CHECK(result[0]==0x4b800000 + (mode==2) && observed==(mxcsr|32));
    }
    LOAD_CONTROL(0x1f80);
    BINARY("subss",f_four,f_one); CHECK(result[0]==0x40400000);
    BINARY("subsd",d_four,d_one); CHECK(!result[0] && result[1]==0x40080000);
    BINARY("mulss",f_four,f_four); CHECK(result[0]==0x41800000);
    MEMORY("mulsd",d_four,*(const ULONGLONG *)d_four); CHECK(!result[0] && result[1]==0x40300000);
    BINARY("divss",f_one,f_four); CHECK(result[0]==0x3e800000);
    MEMORY("divsd",d_one,*(const ULONGLONG *)d_four); CHECK(!result[0] && result[1]==0x3fd00000);
    BINARY("sqrtss",f_one,f_four); CHECK(result[0]==0x40000000);
    BINARY("sqrtsd",d_one,d_four); CHECK(!result[0] && result[1]==0x40000000);
    BINARY("cvtss2sd",d_one,half); CHECK(!result[0] && result[1]==0x3fe00000);
    BINARY("cvtsd2ss",f_one,d_four); CHECK(result[0]==0x40800000 && result[1]==2);
    __asm__ volatile("cvtss2si %1,%0":"=r"(integer_result):"m"(half[0]));
    CHECK(integer_result==0);
    LOAD_CONTROL(0x5f80);
    __asm__ volatile("cvtss2si %1,%0":"=r"(integer_result):"m"(half[0]));
    CHECK(integer_result==1);
    __asm__ volatile("cvttss2si %1,%0":"=r"(integer_result):"m"(half[0]));
    CHECK(integer_result==0);
    LOAD_CONTROL(0x1f80);
    BINARY("addss",tiny,tiny); READ_MXCSR(); CHECK(result[0]==2 && (observed&63)==2);
    LOAD_CONTROL(0x1fc0);
    BINARY("addss",tiny,tiny); READ_MXCSR(); CHECK(result[0]==0 && (observed&63)==0);
    LOAD_CONTROL(0x9f80);
    BINARY("mulss",min_normal,half); READ_MXCSR(); CHECK(result[0]==0 && (observed&63)==48);
    LOAD_CONTROL(0x1f80);
    __asm__ volatile("movss %1,%%xmm0; ucomiss %2,%%xmm0; pushfl; popl %0"
        : "=r"(condition_flags):"m"(qnan[0]),"m"(f_one[0]):"xmm0","cc");
    READ_MXCSR(); CHECK((condition_flags&0x8d5)==0x45 && !(observed&63));
    __asm__ volatile("movss %1,%%xmm0; comiss %2,%%xmm0; pushfl; popl %0"
        : "=r"(condition_flags):"m"(qnan[0]),"m"(f_one[0]):"xmm0","cc");
    READ_MXCSR(); CHECK((condition_flags&0x8d5)==0x45 && (observed&63)==1);
    LOAD_CONTROL(0x1f80);
}

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
    arithmetic();
    ExitProcess(0);
}
