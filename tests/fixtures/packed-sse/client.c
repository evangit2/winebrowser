/* MIT; native SSE/SSE2 reference. No floating-point software computes answers. */
#ifdef WB_SSE_ORACLE
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
typedef uint32_t DWORD;
typedef unsigned UINT;
#define ExitProcess(code) exit(code)
#else
#include <windows.h>
#endif
#define CHECK(x) do { if (!(x)) ExitProcess(__LINE__); } while (0)
typedef struct { DWORD tag, mxcsr, out[4]; } Record;
static Record records[16384];
static DWORD count, control, result[4], observed;
static const DWORD values[][4] __attribute__((aligned(16))) = {
 {0x3f800000,0xbf800000,0x40800000,0x3f000000},
 {0x40000000,0x3f800000,0x33800000,0x00800000},
 {0,0x80000000,0x7f800000,0xff800000},
 {0x7fc00001,0x7f800001,0xffc01234,0xff800001},
 {1,0x80000001,0x007fffff,0x807fffff},
 {0x7f7fffff,0xff7fffff,0x4f000000,0xcf000000},
 {0,0x3ff00000,0,0xbff00000},
 {0,0x40000000,0,0x3ca00000},
 {0,0x7ff00000,0,0xfff00000},
 {1,0x7ff80000,1,0x7ff00000},
 {1,0,1,0x80000000},
 {0xffffffff,0x7fefffff,0xffffffff,0xffefffff},
 {0x7fffffff,0x80000000,0x01000001,0xfeffffff}
};
#define BINARY(op) if (memory) { __asm__ volatile("movdqu %1,%%xmm0; " op " %2,%%xmm0; movdqu %%xmm0,%0" : "=m"(result) : "m"(*a), "m"(*b) : "xmm0"); } else __asm__ volatile("movdqu %1,%%xmm0; movdqu %2,%%xmm1; " op " %%xmm1,%%xmm0; movdqu %%xmm0,%0" : "=m"(result) : "m"(*a), "m"(*b) : "xmm0","xmm1")
static void run(UINT op, int memory, const DWORD (*a)[4], const DWORD (*b)[4]) {
 __asm__ volatile("ldmxcsr %0"::"m"(control));
 switch (op) {
 case 0:BINARY("addps");break;case 1:BINARY("subps");break;case 2:BINARY("mulps");break;
 case 3:BINARY("divps");break;case 4:BINARY("sqrtps");break;case 5:BINARY("minps");break;case 6:BINARY("maxps");break;
 case 7:BINARY("addpd");break;case 8:BINARY("subpd");break;case 9:BINARY("mulpd");break;
 case 10:BINARY("divpd");break;case 11:BINARY("sqrtpd");break;case 12:BINARY("minpd");break;case 13:BINARY("maxpd");break;
 case 14:BINARY("cmpps $0,");break;case 15:BINARY("cmpps $1,");break;case 16:BINARY("cmpps $2,");break;case 17:BINARY("cmpps $3,");break;
 case 18:BINARY("cmpps $4,");break;case 19:BINARY("cmpps $5,");break;case 20:BINARY("cmpps $6,");break;case 21:BINARY("cmpps $7,");break;
 case 22:BINARY("cmppd $0,");break;case 23:BINARY("cmppd $1,");break;case 24:BINARY("cmppd $2,");break;case 25:BINARY("cmppd $3,");break;
 case 26:BINARY("cmppd $4,");break;case 27:BINARY("cmppd $5,");break;case 28:BINARY("cmppd $6,");break;case 29:BINARY("cmppd $7,");break;
 case 30:BINARY("cvtdq2ps");break;case 31:BINARY("cvtdq2pd");break;case 32:BINARY("cvtps2dq");break;case 33:BINARY("cvttps2dq");break;
 case 34:BINARY("cvtpd2dq");break;case 35:BINARY("cvttpd2dq");break;case 36:BINARY("cvtps2pd");break;case 37:BINARY("cvtpd2ps");break;
 case 38:BINARY("minss");break;case 39:BINARY("maxss");break;case 40:BINARY("minsd");break;case 41:BINARY("maxsd");break;
 case 42:BINARY("cmpss $1,");break;case 43:BINARY("cmpss $5,");break;case 44:BINARY("cmpsd $0,");break;case 45:BINARY("cmpsd $7,");break;
 case 46:BINARY("shufps $0x93,");break;case 47:BINARY("shufpd $3,");break;
 case 48:BINARY("unpcklps");break;case 49:BINARY("unpckhps");break;case 50:BINARY("unpcklpd");break;case 51:BINARY("unpckhpd");break;
 case 52:BINARY("punpckhdq");break;case 53:BINARY("punpckhqdq");break;
 case 54:BINARY("pslld");break;case 55:BINARY("psrld");break;case 56:BINARY("psrad");break;
 case 57:BINARY("psllw");break;case 58:BINARY("psrlw");break;case 59:BINARY("psraw");break;
 case 60:BINARY("pcmpgtb");break;case 61:BINARY("pcmpgtw");break;case 62:BINARY("pcmpgtd");break;
 case 63:BINARY("pand");break;case 64:BINARY("pandn");break;case 65:BINARY("por");break;
 case 66:BINARY("pcmpeqb");break;case 67:BINARY("pcmpeqw");break;
 case 68:BINARY("packssdw");break;case 69:BINARY("packsswb");break;case 70:BINARY("packuswb");break;
 case 71:BINARY("punpcklbw");break;case 72:BINARY("punpckhbw");break;
 case 73:BINARY("punpcklwd");break;case 74:BINARY("punpckhwd");break;
 default:ExitProcess(99);
 }
 __asm__ volatile("stmxcsr %0":"=m"(observed));
 CHECK(count < sizeof(records)/sizeof(records[0]));
 records[count].tag=op | (memory ? 128 : 0); records[count].mxcsr=observed;
 for(UINT i=0;i<4;i++) records[count].out[i]=result[i];
 count++;
}
#ifdef WB_SSE_ORACLE
int main(void) {
#else
void start(void) {
#endif
 const DWORD controls[]={0x1f80,0x3f80,0x5f80,0x7f80,0x1fc0,0x9f80,0x9fc0};
 for(UINT mode=0;mode<7;mode++) {
  control=controls[mode];
  for(UINT op=0;op<75;op++) {
   /* Mixed IEEE/int patterns intentionally exercise conversions and invalids. */
   for(UINT pair=0;pair<8;pair++) {
    UINT at=(op>=7 && op<=13) || (op>=22 && op<=29) || op==34 || op==35 || op==37 || op==40 || op==41 || op==44 || op==45 ? 6+pair%6 : pair;
    run(op,0,&values[at],&values[(at+1)%13]);
    run(op,1,&values[at],&values[(at+1)%13]);
   }
  }
 }
 control=0x1f80;__asm__ volatile("ldmxcsr %0"::"m"(control));
#ifdef WB_SSE_ORACLE
 FILE *file=fopen("packed-sse-results.bin","wb"); CHECK(file);
 CHECK(fwrite(records,sizeof(Record),count,file)==count);CHECK(!fclose(file));
 puts("PACKED SSE NATIVE MATRIX PASS");return 0;
#else
 HANDLE file=CreateFileA("packed-sse-results.bin",GENERIC_WRITE,0,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0); CHECK(file!=INVALID_HANDLE_VALUE);
 DWORD written;CHECK(WriteFile(file,records,count*sizeof(Record),&written,0) && written==count*sizeof(Record));CHECK(CloseHandle(file));
 static const char pass[]="PACKED SSE NATIVE MATRIX PASS\r\n";
 CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),pass,sizeof(pass)-1,&written,0));ExitProcess(0);
#endif
}
