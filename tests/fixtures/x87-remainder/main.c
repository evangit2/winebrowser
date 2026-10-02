// SPDX-License-Identifier: MIT
#include <windows.h>
#include "vectors.h"
static void fail(UINT line) { ExitProcess(line); }
#define CHECK(x) do { if (!(x)) fail(__LINE__); } while (0)
void _start(void) {
  for(unsigned pc=0;pc<3;pc++) for(unsigned rc=0;rc<4;rc++) {
    unsigned short control=(unsigned short)(0x7f|((pc?pc+1:0)<<8)|(rc<<10));
    for(unsigned i=0;i<sizeof(vectors)/sizeof(vectors[0]);i++) {
      const struct vector *v=&vectors[i]; unsigned char result[10];unsigned short status;
      if(v->nearest) __asm__ volatile("fninit; fldcw %4; fldt %3; fldt %2; 1: fprem1; fnstsw %%ax; testw $0x400,%%ax; jnz 1b; fstpt %0; fstp %%st(0)"
        : "=m"(result),"=a"(status):"m"(v->a),"m"(v->b),"m"(control):"st","cc");
      else __asm__ volatile("fninit; fldcw %4; fldt %3; fldt %2; 1: fprem; fnstsw %%ax; testw $0x400,%%ax; jnz 1b; fstpt %0; fstp %%st(0)"
        : "=m"(result),"=a"(status):"m"(v->a),"m"(v->b),"m"(control):"st","cc");
      for(unsigned n=0;n<10;n++) CHECK(result[n]==v->result[n]);
      CHECK((status&0x3f)==(v->status&0x3f));
      if(v->quotient) CHECK((status&0x4700)==(v->status&0x4700));
    }
  }
  static const char pass[]="X87 REMAINDER PASS\n"; DWORD written;
  WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),pass,sizeof(pass)-1,&written,0);
  ExitProcess(0);
}
