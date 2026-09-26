#define _WIN32_WINNT 0x0601
#include <windows.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
struct vector { unsigned width, kind, a, d, operand, expected_a, expected_d; int carry; };
static const struct vector vectors[] = {
    {8,0,0xa1b200ff,0x12345678,2,0xa1b201fe,0x12345678,1},
    {8,0,0xa1b2007f,0x12345678,2,0xa1b200fe,0x12345678,0},
    {8,1,0xa1b20080,0x12345678,1,0xa1b2ff80,0x12345678,0},
    {8,1,0xa1b20080,0x12345678,255,0xa1b20080,0x12345678,1},
    {16,0,0xa1b2ffff,0xc3d40000,0xffff,0xa1b20001,0xc3d4fffe,1},
    {16,1,0xa1b28000,0xc3d40000,1,0xa1b28000,0xc3d4ffff,0},
    {16,1,0xa1b28000,0xc3d40000,0xffff,0xa1b28000,0xc3d40000,1},
    {32,0,0xffffffff,0x12345678,2,0xfffffffe,1,1},
    {32,1,0x80000000,0x12345678,0xffffffff,0x80000000,0,1},
    {32,1,0xfffffffe,0x12345678,3,0xfffffffa,0xffffffff,0},
    {8,2,0xa1b21000,0x12345678,17,0xa1b210f0,0x12345678,-1},
    {8,3,0xa1b2ffeb,0x12345678,4,0xa1b2fffb,0x12345678,-1},
    {8,3,0xa1b2ffeb,0x12345678,252,0xa1b2ff05,0x12345678,-1},
    {8,3,0xa1b20015,0x12345678,252,0xa1b201fb,0x12345678,-1},
    {16,2,0xa1b20000,0xc3d40001,3,0xa1b25555,0xc3d40001,-1},
    {16,3,0xa1b2ffeb,0xc3d4ffff,4,0xa1b2fffb,0xc3d4ffff,-1},
    {16,3,0xa1b20015,0xc3d40000,0xfffc,0xa1b2fffb,0xc3d40001,-1},
    {32,2,0,1,3,0x55555555,1,-1},
    {32,3,0xffffffeb,0xffffffff,4,0xfffffffb,0xffffffff,-1},
    {32,3,21,0,0xfffffffc,0xfffffffb,1,-1},
};
#define EXEC(op) __asm__ volatile(op "; pushfl; popl %2" : "+a"(a), "+d"(d), "=r"(flags) : "c"(v->operand) : "cc")
#define WIDTH(op) do { if (v->width == 8) EXEC(op "b %%cl"); else if (v->width == 16) EXEC(op "w %%cx"); else EXEC(op "l %%ecx"); } while (0)
void start(void)
{
    for (unsigned i = 0; i < sizeof(vectors) / sizeof(vectors[0]); ++i) {
        const struct vector *v = &vectors[i];
        unsigned a = v->a, d = v->d, flags;
        if (v->kind == 0) WIDTH("mul");
        else if (v->kind == 1) WIDTH("imul");
        else if (v->kind == 2) WIDTH("div");
        else WIDTH("idiv");
        CHECK(a == v->expected_a && d == v->expected_d);
        if (v->carry >= 0) CHECK((flags & 0x801) == (v->carry ? 0x801u : 0));
    }
    unsigned a = 0x12340503;
    __asm__ volatile("mulb %%ah" : "+a"(a) : : "cc");
    CHECK(a == 0x1234000f);
    DWORD written;
    CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "wide-math-ok\n", 13, &written, NULL) && written == 13);
    ExitProcess(0);
}
