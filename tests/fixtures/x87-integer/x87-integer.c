#include <windows.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
static double left=12.0;
static short small=-3;
static int large=-3;
#define ARITH(op,suffix,rhs,expected) do { \
    double output; unsigned short status; \
    __asm__ volatile("fninit; fldl %2; " op suffix " %3; fnstsw %%ax; fstpl %0" \
        : "=m"(output), "=a"(status) : "m"(left), "m"(rhs) : "st"); \
    CHECK(output == (expected)); CHECK((status & 0x3f) == 0); \
} while (0)
#define COMP(op,suffix,rhs,pop) do { \
    unsigned short status; \
    __asm__ volatile("fninit; fldl %1; " op suffix " %2; fnstsw %%ax; fninit" \
        : "=a"(status) : "m"(left), "m"(rhs) : "st"); \
    CHECK((status & 0x4700) == 0); CHECK(((status >> 11) & 7) == ((pop)?0:7)); \
} while (0)
void start(void) {
    ARITH("fiadd","s",small,9); ARITH("fiadd","l",large,9);
    ARITH("fimul","s",small,-36); ARITH("fimul","l",large,-36);
    ARITH("fisub","s",small,15); ARITH("fisub","l",large,15);
    ARITH("fisubr","s",small,-15); ARITH("fisubr","l",large,-15);
    ARITH("fidiv","s",small,-4); ARITH("fidiv","l",large,-4);
    ARITH("fidivr","s",small,-0.25); ARITH("fidivr","l",large,-0.25);
    COMP("ficom","s",small,0); COMP("ficom","l",large,0);
    COMP("ficomp","s",small,1); COMP("ficomp","l",large,1);
    static const unsigned long low[2] = {0xaaaaaaaa,0xaaaaaaab};
    static const double one = 1;
    static const int three = 3;
    for (unsigned int rc=0;rc<4;rc++) {
        unsigned short control=0x37f|(rc<<10),status;
        unsigned char output[10];
        __asm__ volatile("fninit; fldcw %2; fldl %3; fidivl %4; fnstsw %%ax; fstpt %0; fninit"
            : "=m"(output),"=a"(status) : "m"(control),"m"(one),"m"(three) : "st");
        unsigned int up=rc==0 || rc==2;
        CHECK(*(unsigned long *)output==low[up]);
        CHECK(*(unsigned long *)(output+4)==0xaaaaaaaa);
        CHECK(*(unsigned short *)(output+8)==0x3ffd);
        CHECK((status & 0x23f)==(0x20|(up?0x200:0)));
    }
    ExitProcess(0);
}
