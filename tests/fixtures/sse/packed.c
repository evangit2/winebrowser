#include <windows.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
#define VECTOR(name,...) static const DWORD name[4] __attribute__((aligned(16))) = {__VA_ARGS__}
VECTOR(f_a,0x41000000,0xc0800000,0x40000000,0xc1800000);
VECTOR(f_b,0x40800000,0x40800000,0x3f800000,0x41800000);
VECTOR(d_a,0,0x40200000,0,0xc0100000);
VECTOR(d_b,0,0x40100000,0,0x40100000);
VECTOR(f_one,0x3f800000,0xbf800000,0x3f800000,0xbf800000);
VECTOR(f_half_ulp,0x33800000,0xb3800000,0x33800000,0xb3800000);
VECTOR(d_one,0,0x3ff00000,0,0xbff00000);
VECTOR(d_half_ulp,0,0x3ca00000,0,0xbca00000);
VECTOR(f_tiny,1,0x80000001,0x800000,0x80800000);
VECTOR(f_half,0x3f000000,0x3f000000,0x3f000000,0x3f000000);
VECTOR(f_special,0,0x3f800000,1,0x7f7fffff);
VECTOR(f_divisor,0,0,0x40400000,0x3f000000);
VECTOR(f_nan,0x7f800001,0x7fc00002,0xbf800000,0x40800000);
VECTOR(d_tiny,1,0x80000000,0,0x100000);
VECTOR(d_half,0,0x3fe00000,0,0x3fe00000);
static DWORD result[4], control, observed;
#define LOAD_CONTROL(value) do { control=(value); __asm__ volatile("ldmxcsr %0"::"m"(control)); } while(0)
#define READ_MXCSR() __asm__ volatile("stmxcsr %0":"=m"(observed))
#define BINARY(op,left,right) __asm__ volatile( \
    "movdqu %1,%%xmm0; movdqu %2,%%xmm1; " op " %%xmm1,%%xmm0; movdqu %%xmm0,%0" \
    : "=m"(result) : "m"(left), "m"(right) : "xmm0","xmm1")
#define MEMORY(op,left,right) __asm__ volatile( \
    "movdqu %1,%%xmm0; " op " %2,%%xmm0; movdqu %%xmm0,%0" \
    : "=m"(result) : "m"(left), "m"(right) : "xmm0")
#define EXPECT(a,b,c,d) CHECK(result[0]==(DWORD)(a) && result[1]==(DWORD)(b) && result[2]==(DWORD)(c) && result[3]==(DWORD)(d))
static void arithmetic(void) {
    LOAD_CONTROL(0x1f80);
    BINARY("addps",f_a,f_b); EXPECT(0x41400000,0,0x40400000,0);
    MEMORY("subps",f_a,f_b); EXPECT(0x40800000,0xc1000000,0x3f800000,0xc2000000);
    BINARY("mulps",f_a,f_b); EXPECT(0x42000000,0xc1800000,0x40000000,0xc3800000);
    MEMORY("divps",f_a,f_b); EXPECT(0x40000000,0xbf800000,0x40000000,0xbf800000);
    BINARY("sqrtps",f_nan,f_b); EXPECT(0x40000000,0x40000000,0x3f800000,0x40800000);
    BINARY("addpd",d_a,d_b); EXPECT(0,0x40280000,0,0);
    MEMORY("subpd",d_a,d_b); EXPECT(0,0x40100000,0,0xc0200000);
    BINARY("mulpd",d_a,d_b); EXPECT(0,0x40400000,0,0xc0300000);
    MEMORY("divpd",d_a,d_b); EXPECT(0,0x40000000,0,0xbff00000);
    MEMORY("sqrtpd",d_one,d_b); EXPECT(0,0x40000000,0,0x40000000);
    for (UINT mode=0;mode<4;mode++) {
        LOAD_CONTROL(0x1f80 | mode<<13);
        BINARY("addps",f_one,f_half_ulp); READ_MXCSR();
        EXPECT(0x3f800000+(mode==2),0xbf800000+(mode==1),0x3f800000+(mode==2),0xbf800000+(mode==1));
        CHECK(observed==(control|32));
        LOAD_CONTROL(0x1f80 | mode<<13);
        MEMORY("addpd",d_one,d_half_ulp); READ_MXCSR();
        EXPECT(mode==2,0x3ff00000,mode==1,0xbff00000); CHECK(observed==(control|32));
    }
    LOAD_CONTROL(0x1f80);
    BINARY("divps",f_special,f_divisor); READ_MXCSR();
    EXPECT(0xffc00000,0x7f800000,0,0x7f800000); CHECK((observed&63)==63);
    LOAD_CONTROL(0x1fc0);
    BINARY("addps",f_tiny,f_tiny); READ_MXCSR();
    EXPECT(0,0x80000000,0x1000000,0x81000000); CHECK((observed&63)==0);
    LOAD_CONTROL(0x9f80);
    BINARY("mulps",f_tiny,f_half); READ_MXCSR();
    EXPECT(0,0x80000000,0,0x80000000); CHECK((observed&63)==50);
    LOAD_CONTROL(0x9f80);
    BINARY("mulpd",d_tiny,d_half); READ_MXCSR();
    EXPECT(0,0x80000000,0,0); CHECK((observed&63)==50);
    LOAD_CONTROL(0x1f80);
    BINARY("sqrtps",f_one,f_nan); READ_MXCSR();
    EXPECT(0x7fc00001,0x7fc00002,0xffc00000,0x40000000); CHECK((observed&63)==1);
}
/* Four independent 3D vertices travel through a structure-of-arrays vector
 * pipeline: magnitude, normalization, uniform scale and translation. */
VECTOR(x,0x40400000,0,0xc0400000,0);
VECTOR(y,0x40800000,0,0x40800000,0xc0800000);
VECTOR(z,0,0x40a00000,0,0x40400000);
VECTOR(scale,0x41200000,0x41200000,0x41200000,0x41200000);
VECTOR(offset,0x40000000,0x40000000,0x40000000,0x40000000);
static DWORD magnitude[4], normal_x[4], normal_y[4], normal_z[4];
static void geometry(void) {
    LOAD_CONTROL(0x1f80);
    __asm__ volatile(
        "movups %1,%%xmm0; movups %2,%%xmm1; movups %3,%%xmm2;"
        "mulps %%xmm0,%%xmm0; mulps %%xmm1,%%xmm1; mulps %%xmm2,%%xmm2;"
        "addps %%xmm1,%%xmm0; addps %%xmm2,%%xmm0; sqrtps %%xmm0,%%xmm0; movups %%xmm0,%0"
        : "=m"(magnitude) : "m"(x),"m"(y),"m"(z) : "xmm0","xmm1","xmm2");
    for (UINT i=0;i<4;i++) CHECK(magnitude[i]==0x40a00000);
    BINARY("divps",x,magnitude);
    for (UINT i=0;i<4;i++) normal_x[i]=result[i];
    EXPECT(0x3f19999a,0,0xbf19999a,0);
    BINARY("divps",y,magnitude);
    for (UINT i=0;i<4;i++) normal_y[i]=result[i];
    EXPECT(0x3f4ccccd,0,0x3f4ccccd,0xbf4ccccd);
    BINARY("divps",z,magnitude);
    for (UINT i=0;i<4;i++) normal_z[i]=result[i];
    EXPECT(0,0x3f800000,0,0x3f19999a);
    BINARY("mulps",normal_x,scale); BINARY("addps",result,offset);
    EXPECT(0x41000000,0x40000000,0xc0800000,0x40000000);
    BINARY("mulps",normal_y,scale); BINARY("addps",result,offset);
    EXPECT(0x41200000,0x40000000,0x41200000,0xc0c00000);
    BINARY("mulps",normal_z,scale); BINARY("addps",result,offset);
    EXPECT(0x40000000,0x41400000,0x40000000,0x41000000);
}
void start(void) {
    arithmetic(); geometry();
    static const char message[]="packed-sse-ok: ten packed opcodes; four-vertex 3D normalization and transforms; MXCSR\n";
    DWORD written;
    CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),message,sizeof(message)-1,&written,NULL));
    ExitProcess(0);
}
