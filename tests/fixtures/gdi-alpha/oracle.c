/* Original WineBrowser contributors, MIT. Native AlphaBlend SDK oracle. */
#include <windows.h>
#include <stdio.h>
static int first=1;
static const DWORD colors[]={0x80102030,0x40602010,0xff204080,0x00000000};
static void emit(HDC dc,HDC source,DWORD *target,const char *name,int alpha,int flags,int clipped){
 SelectClipRgn(dc,NULL);for(int i=0;i<16;i++)target[i]=0x70406080;
 if(clipped){HRGN a=CreateRectRgn(0,0,3,4),b=CreateRectRgn(1,1,2,3);CombineRgn(a,a,b,RGN_DIFF);SelectClipRgn(dc,a);DeleteObject(a);DeleteObject(b);}
 BLENDFUNCTION blend={AC_SRC_OVER,0,(BYTE)alpha,(BYTE)flags};SetLastError(777);BOOL ok=AlphaBlend(dc,0,0,4,4,source,0,0,2,2,blend);
 printf("%s{\"name\":\"%s\",\"alpha\":%d,\"flags\":%d,\"clip\":%d,\"result\":%d,\"error\":%lu,\"pixels\":[",first?"":",\n",name,alpha,flags,clipped,ok,GetLastError());first=0;
 SelectClipRgn(dc,NULL);for(int y=0;y<4;y++)for(int x=0;x<4;x++)printf("%s%lu",x||y?",":"",GetPixel(dc,x,y));printf("],\"raw\":[");for(int i=0;i<16;i++)printf("%s%lu",i?",":"",target[i]);puts("]}");
}
int main(void){HDC screen=GetDC(NULL),dc=CreateCompatibleDC(screen),source=CreateCompatibleDC(screen);BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=4;bmi.bmiHeader.biHeight=-4;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;DWORD *target,*pixels;
 HBITMAP dst=CreateDIBSection(screen,&bmi,0,(void **)&target,NULL,0);HGDIOBJ old=SelectObject(dc,dst);bmi.bmiHeader.biWidth=2;bmi.bmiHeader.biHeight=-2;HBITMAP src=CreateDIBSection(screen,&bmi,0,(void **)&pixels,NULL,0);HGDIOBJ sourceold=SelectObject(source,src);for(int i=0;i<4;i++)pixels[i]=colors[i];
 puts("[");const int alphas[]={0,1,2,64,127,128,254,255};for(int f=0;f<2;f++)for(unsigned a=0;a<sizeof(alphas)/sizeof(alphas[0]);a++){char name[32];sprintf(name,"blend-%d-%d",f,alphas[a]);emit(dc,source,target,name,alphas[a],f,0);}emit(dc,source,target,"clipped",127,1,1);puts("]");
 SelectObject(dc,old);SelectObject(source,sourceold);DeleteObject(dst);DeleteObject(src);DeleteDC(dc);DeleteDC(source);ReleaseDC(NULL,screen);return 0;}
