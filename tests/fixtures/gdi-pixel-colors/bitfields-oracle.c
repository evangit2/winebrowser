/* Original WineBrowser contributors, MIT. Native pixel write and quantization evidence. */
#include <windows.h>
#include <stdio.h>
int main(void){
 HDC dc=CreateCompatibleDC(NULL);DWORD colors[]={0,0xffffff,RGB(1,2,3),RGB(4,5,6),RGB(5,6,7),RGB(7,8,9),RGB(127,128,129),RGB(250,249,248),RGB(19,47,181),RGB(0,255,0),0x01000001,0x01000013,0x020000a5,0x10ff0001,0x10ff0002,0xffabcdef,0x10ff00ff,0x10ff0000,0x10ff0003,0x10ff0004,0x10ff000f,0x10ff0010,0x10ff0011,0x10ff0100,0x10ff0101,0x10ff01ff,0x10ffffff,RGB(64,96,128),RGB(255,0,255),RGB(0,255,255),RGB(255,255,0)};int first=1;puts("[");
 int depths[]={16,16,24,32,8,1,4,16,16,32};
 for(int type=0;type<10;type++){
  BYTE header[1064]={0};BITMAPINFO *bmi=(BITMAPINFO *)header;bmi->bmiHeader.biSize=40;bmi->bmiHeader.biWidth=1;bmi->bmiHeader.biHeight=-1;bmi->bmiHeader.biPlanes=1;bmi->bmiHeader.biBitCount=depths[type];
  if(type==1){bmi->bmiHeader.biCompression=BI_BITFIELDS;DWORD *m=(DWORD *)(header+40);m[0]=0xf800;m[1]=0x07e0;m[2]=0x001f;}
  if(type>=7){bmi->bmiHeader.biCompression=BI_BITFIELDS;DWORD *m=(DWORD *)(header+40);m[0]=type==7?0xf00:type==8?0xe0:0x3ff00000;m[1]=type==7?0xf0:type==8?0x1c:0xffc00;m[2]=type==7?0xf:type==8?3:0x3ff;}
  if(type==4||type==6){bmi->bmiHeader.biClrUsed=4;DWORD table[]={0,0xff0000,0x00ff00,0xffffff};for(int i=0;i<4;i++)((DWORD *)(header+40))[i]=table[i];}
  if(type==5){((DWORD *)(header+40))[0]=0;((DWORD *)(header+40))[1]=0xffffff;}
  DWORD *bits;HBITMAP bitmap=CreateDIBSection(dc,bmi,0,(void **)&bits,NULL,0);HGDIOBJ old=SelectObject(dc,bitmap);
  for(unsigned i=0;i<sizeof(colors)/sizeof(colors[0]);i++){
   *bits=0x70406080;SetLastError(777);COLORREF result=SetPixel(dc,0,0,colors[i]);DWORD error=GetLastError();COLORREF observed=GetPixel(dc,0,0);
   printf("%s{\"type\":%d,\"color\":%lu,\"result\":%lu,\"error\":%lu,\"pixel\":%lu,\"raw\":%lu}",first?"":",\n",type,colors[i],result,error,observed,*bits);first=0;
  }
  SelectObject(dc,old);DeleteObject(bitmap);
 }
 puts("\n]");DeleteDC(dc);return 0;
}
