/* Original WineBrowser contributors, MIT. Native StretchDIBits geometry and byte oracle. */
#include <windows.h>
#include <stdio.h>
static int first=1;
static const DWORD source[]={0x80102030,0x40405060,0xff708090,0x00a0b0c0,0x20d0e0f0,0x60332211,0x90446688,0xc0557799,0x006688aa};
static void emit(HDC dc,DWORD *dst,const BITMAPINFO *info,const void *bits,const char *name,const int *a,int clip,DWORD rop){
 SelectClipRgn(dc,NULL);for(int i=0;i<256;i++)dst[i]=0x70406080;
 if(clip){HRGN r=CreateRectRgn(3,3,13,14),h=CreateRectRgn(6,6,10,10);CombineRgn(r,r,h,RGN_DIFF);SelectClipRgn(dc,r);DeleteObject(r);DeleteObject(h);}
 SetLastError(777);int result=StretchDIBits(dc,a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],bits,info,DIB_RGB_COLORS,rop);DWORD error=GetLastError();SelectClipRgn(dc,NULL);
 printf("%s{\"name\":\"%s\",\"mode\":%d,\"signedHeight\":%ld,\"args\":[",first?"":",\n",name,GetStretchBltMode(dc),info->bmiHeader.biHeight);first=0;for(int i=0;i<8;i++)printf("%s%d",i?",":"",a[i]);printf("],\"clip\":%d,\"rop\":%lu,\"result\":%d,\"error\":%lu,\"pixels\":[",clip,rop,result,error);for(int y=0;y<16;y++)for(int x=0;x<16;x++)printf("%s%lu",x||y?",":"",GetPixel(dc,x,y));printf("],\"raw\":[");for(int i=0;i<256;i++)printf("%s%lu",i?",":"",dst[i]);puts("]}");
}
int main(void){HDC dc=CreateCompatibleDC(NULL);BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=16;bmi.bmiHeader.biHeight=-16;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;DWORD *dst;HBITMAP bitmap=CreateDIBSection(dc,&bmi,0,(void **)&dst,NULL,0);HGDIOBJ old=SelectObject(dc,bitmap);bmi.bmiHeader.biWidth=3;
 const int geometry[][8]={{2,2,12,12,0,0,3,3},{2,2,7,8,0,0,3,3},{2,2,1,1,0,0,3,3},{2,2,10,10,1,1,2,1},{14,2,-12,12,0,0,3,3},{2,14,12,-12,0,0,3,3},{2,2,12,12,3,0,-3,3},{2,2,12,12,0,3,3,-3},{14,14,-12,-12,3,3,-3,-3},{-3,-4,12,12,0,0,3,3},{2,2,12,12,-1,-1,3,3},{2,2,12,12,2,2,3,3},{2,2,0,12,0,0,3,3},{2,2,12,0,0,0,3,3},{2,2,12,12,0,0,0,3},{2,2,12,12,0,0,3,0},{2,2,2,2,0,0,2,2},{2,2,2,2,1,1,2,2},{2,2,4,2,0,1,3,2},{14,14,-3,-3,2,2,-3,-3}};
 puts("[");for(int mode=1;mode<=4;mode++)for(int top=0;top<2;top++){SetStretchBltMode(dc,mode);bmi.bmiHeader.biHeight=top?-3:3;for(unsigned i=0;i<sizeof(geometry)/sizeof(geometry[0]);i++){char name[48];sprintf(name,"geometry-mode-%d-%d-%u",mode,top,i);emit(dc,dst,&bmi,source,name,geometry[i],0,SRCCOPY);}char name[48];sprintf(name,"clipped-mode-%d-%d",mode,top);emit(dc,dst,&bmi,source,name,geometry[0],1,SRCCOPY);}
 SetStretchBltMode(dc,1);bmi.bmiHeader.biHeight=-3;DWORD rops[]={SRCPAINT,SRCAND,SRCINVERT,NOTSRCCOPY,BLACKNESS,WHITENESS,DSTINVERT};for(int mode=1;mode<=4;mode++)for(int top=0;top<2;top++)for(unsigned i=0;i<sizeof(rops)/sizeof(rops[0]);i++)for(unsigned g=0;g<4;g++){SetStretchBltMode(dc,mode);bmi.bmiHeader.biHeight=top?-3:3;char name[40];sprintf(name,"rop-mode-%d-%d-%u-%u",mode,top,i,g);emit(dc,dst,&bmi,source,name,geometry[g],0,rops[i]);}
 puts("]");SelectObject(dc,old);DeleteObject(bitmap);DeleteDC(dc);return 0;}
