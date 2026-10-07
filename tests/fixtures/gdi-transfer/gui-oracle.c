/* Original WineBrowser contributors, MIT. Desktop SDK GUI drawing evidence. */
#include "drawing.h"
#include <stdio.h>
int main(void){
 HDC dc=CreateCompatibleDC(NULL);BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=16;bmi.bmiHeader.biHeight=-16;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;DWORD *dst;
 HBITMAP bitmap=CreateDIBSection(dc,&bmi,0,(void **)&dst,NULL,0);HGDIOBJ old=SelectObject(dc,bitmap);int first=1;puts("[");
 for(int stage=1;stage<=8;stage++)for(int panel=0;panel<4;panel++){
  int result=sample(dc,dst,panel,stage);DWORD error=GetLastError();SelectClipRgn(dc,NULL);
  printf("%s{\"name\":\"stage-%d-panel-%d\",\"stage\":%d,\"panel\":%d,\"result\":%d,\"error\":%lu,\"pixels\":[",first?"":",\n",stage,panel,stage,panel,result,error);first=0;
  for(int y=0;y<16;y++){for(int x=0;x<16;x++){printf("%s%lu",x||y?",":"",GetPixel(dc,x,y));}}
  printf("],\"raw\":[");for(int i=0;i<256;i++)printf("%s%lu",i?",":"",dst[i]);puts("]}");
 }
 puts("]");SelectObject(dc,old);DeleteObject(bitmap);DeleteDC(dc);return 0;
}
