// SPDX-License-Identifier: MIT
#include <stdio.h>
#include <stdint.h>
#include <string.h>
static void operation(const unsigned char *a,const unsigned char *b,unsigned char *out,unsigned short *sw,int ieee) {
  if (ieee) __asm__ volatile("fninit; fldt %3; fldt %2; fprem1; fnstsw %0; fstpt %1; fstp %%st(0)" : "=m"(*sw),"=m"(*(unsigned char (*)[10])out) : "m"(*(const unsigned char (*)[10])a),"m"(*(const unsigned char (*)[10])b) : "st");
  else __asm__ volatile("fninit; fldt %3; fldt %2; fprem; fnstsw %0; fstpt %1; fstp %%st(0)" : "=m"(*sw),"=m"(*(unsigned char (*)[10])out) : "m"(*(const unsigned char (*)[10])a),"m"(*(const unsigned char (*)[10])b) : "st");
}
int main(void) {
 char sa[21],sb[21]; unsigned char a[10],b[10],out[10];
 while(scanf("%20s %20s",sa,sb)==2) {
  for(int i=0;i<10;i++) { unsigned n; sscanf(sa+2*i,"%2x",&n);a[i]=n;sscanf(sb+2*i,"%2x",&n);b[i]=n; }
  for(int ieee=0;ieee<2;ieee++) {
   unsigned short sw=0; unsigned char current[10]; memcpy(current,a,10);
   int steps=0;
   do { operation(current,b,out,&sw,ieee); memcpy(current,out,10); steps++; } while((sw&0x400)&&steps<2048);
   for(int i=0;i<10;i++)printf("%02x",out[i]);printf(" %04x %d%c",sw,steps,ieee?'\n':' ');
  }
 }
}
