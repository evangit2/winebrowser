/* Original WineBrowser contributors, MIT. Native scaling modes and raw alpha. */
#include <windows.h>
#include <stdio.h>
static const DWORD colors[]={0x80102030,0x40405060,0xff708090,0x00a0b0c0,0x20d0e0f0,0x60332211,0x90446688,0xc0557799,0x006688aa};
int main(void){
 HDC dc=CreateCompatibleDC(NULL);BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=16;bmi.bmiHeader.biHeight=-16;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;DWORD *dst;
 HBITMAP bitmap=CreateDIBSection(dc,&bmi,0,(void **)&dst,NULL,0);HGDIOBJ old=SelectObject(dc,bitmap);bmi.bmiHeader.biWidth=3;bmi.bmiHeader.biHeight=-3;int first=1;puts("[");
 const int sizes[][2]={{1,1},{2,2},{3,3},{4,4},{5,5},{6,6},{7,7},{1,5},{5,1},{2,7},{7,2},{4,2},{2,4}};
 for(int pattern=0;pattern<2;pattern++)for(int mode=1;mode<=4;mode++)for(unsigned size=0;size<sizeof(sizes)/sizeof(sizes[0]);size++){
  DWORD bits[9];for(int i=0;i<9;i++)bits[i]=pattern?colors[i]:mode==1?~(1u<<i):(1u<<i);
  SetStretchBltMode(dc,mode);for(int i=0;i<256;i++)dst[i]=0x70406080;SetLastError(777);
  int result=StretchDIBits(dc,2,2,sizes[size][0],sizes[size][1],0,0,3,3,bits,&bmi,0,SRCCOPY);DWORD error=GetLastError();
  printf("%s{\"name\":\"mode-%d-pattern-%d-size-%u\",\"mode\":%d,\"width\":%d,\"height\":%d,\"source\":[",first?"":",\n",mode,pattern,size,mode,sizes[size][0],sizes[size][1]);first=0;
  for(int i=0;i<9;i++){printf("%s%lu",i?",":"",bits[i]);}printf("],\"result\":%d,\"error\":%lu,\"pixels\":[",result,error);
  for(int y=0;y<16;y++){for(int x=0;x<16;x++){printf("%s%lu",x||y?",":"",GetPixel(dc,x,y));}}printf("],\"raw\":[");for(int i=0;i<256;i++)printf("%s%lu",i?",":"",dst[i]);puts("]}");
 }
 puts("]");SelectObject(dc,old);DeleteObject(bitmap);DeleteDC(dc);return 0;
}
