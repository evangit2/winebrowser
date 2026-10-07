/* Original WineBrowser contributors, MIT. Native cursor presentation snapshots. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
int main(void){
 HDC dc=CreateCompatibleDC(NULL);BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=8;bmi.bmiHeader.biHeight=-8;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;DWORD *destination;HBITMAP output=CreateDIBSection(dc,&bmi,0,(void **)&destination,NULL,0);HGDIOBJ old=SelectObject(dc,output);
 BYTE maskbits[]={0x80,0,0x40,0,0xc0,0,0x40,0};HICON cursors[4];
 for(int type=0;type<2;type++){
  HBITMAP mask=CreateBitmap(2,type?4:2,1,1,maskbits),color=NULL;
  if(!type){DWORD *bits;bmi.bmiHeader.biWidth=2;bmi.bmiHeader.biHeight=-2;color=CreateDIBSection(dc,&bmi,0,(void **)&bits,NULL,0);DWORD values[]={0x80102030,0x00405060,0x80706050,0xffa0b0c0};for(int i=0;i<4;i++)bits[i]=values[i];}
  ICONINFO info={FALSE,1,0,mask,color};cursors[type]=CreateIconIndirect(&info);DeleteObject(mask);if(color)DeleteObject(color);
  cursors[type+2]=CopyImage(cursors[type],IMAGE_CURSOR,4,4,0);
 }
 puts("[");
 for(int type=0;type<4;type++){
  for(int i=0;i<64;i++)destination[i]=0x00406080;
  SetLastError(777);BOOL ok=DrawIconEx(dc,2,2,cursors[type],type>=2?4:2,type>=2?4:2,0,NULL,DI_NORMAL);DWORD error=GetLastError();
  printf("%s{\"type\":%d,\"result\":%u,\"error\":%lu,\"pixels\":[",type?",\n":"",type,ok,error);
  for(int y=0;y<8;y++)for(int x=0;x<8;x++)printf("%s%lu",x||y?",":"",GetPixel(dc,x,y));printf("]}");
 }
 puts("\n]");for(int type=0;type<4;type++)DestroyCursor(cursors[type]);SelectObject(dc,old);DeleteObject(output);DeleteDC(dc);return 0;
}
