/* Original WineBrowser contributors, MIT. Native DIB scanline transfer oracle. */
#include <windows.h>
#include <stdio.h>
static const DWORD source[]={0x80102030,0x40405060,0xff708090,0x00a0b0c0,0x20d0e0f0,0x60332211,0x90446688,0xc0557799,0x006688aa,0x10234567,0x20456789,0x306789ab,0x409abcde,0x50abcdef,0x60bcdef0};
static int first=1;
static void capture(HDC dc,DWORD *dst,BITMAPINFO *bmi,const int *a,int top,unsigned index,int clip){
 SelectClipRgn(dc,NULL);for(int i=0;i<256;i++)dst[i]=0x70406080;
 if(clip){HRGN region=CreateRectRgn(2,2,6,6),hole=CreateRectRgn(3,3,5,5);CombineRgn(region,region,hole,RGN_DIFF);SelectClipRgn(dc,region);DeleteObject(region);DeleteObject(hole);}
 SetLastError(777);int result=SetDIBitsToDevice(dc,a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],source,bmi,0);DWORD error=GetLastError();SelectClipRgn(dc,NULL);
 printf("%s{\"name\":\"transfer-%d-%u-clip-%d\",\"signedHeight\":%ld,\"args\":[",first?"":",\n",top,index,clip,bmi->bmiHeader.biHeight);first=0;for(int i=0;i<8;i++)printf("%s%d",i?",":"",a[i]);printf("],\"clip\":%d,\"result\":%d,\"error\":%lu,\"pixels\":[",clip,result,error);
 for(int y=0;y<16;y++){for(int x=0;x<16;x++){printf("%s%lu",x||y?",":"",GetPixel(dc,x,y));}}
 printf("],\"raw\":[");for(int i=0;i<256;i++)printf("%s%lu",i?",":"",dst[i]);puts("]}");
}
int main(void){
 HDC dc=CreateCompatibleDC(NULL);BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=16;bmi.bmiHeader.biHeight=-16;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;DWORD *dst;
 HBITMAP bitmap=CreateDIBSection(dc,&bmi,0,(void **)&dst,NULL,0);HGDIOBJ old=SelectObject(dc,bitmap);bmi.bmiHeader.biWidth=3;
 const int a[][8]={{2,2,3,3,0,0,0,3},{2,2,3,3,0,0,0,1},{2,2,3,3,0,0,1,2},{2,2,2,2,1,1,0,3},{2,2,1,1,1,1,1,1},{2,2,3,3,0,0,0,5},{2,2,3,3,0,0,2,5},{2,2,7,7,0,0,0,3},{-1,-1,3,3,0,0,0,3},{2,2,3,3,-1,-1,0,3},{2,2,3,3,2,2,0,3},{2,2,3,3,0,0,3,2},{2,2,3,3,0,0,0,0},{2,2,0,3,0,0,0,3},{2,2,3,0,0,0,0,3},{2,2,3,3,0,0,-1,2},{2,2,3,3,0,0,1,0},{2,2,1,1,0,0,0,3},{2,2,3,3,0,5,0,3},{2,2,3,3,5,0,0,3}};
 puts("[");for(int top=0;top<2;top++){bmi.bmiHeader.biHeight=top?-3:3;for(unsigned i=0;i<sizeof(a)/sizeof(a[0]);i++){capture(dc,dst,&bmi,a[i],top,i,0);}capture(dc,dst,&bmi,a[0],top,0,1);}
 puts("]");SelectObject(dc,old);DeleteObject(bitmap);DeleteDC(dc);return 0;
}
