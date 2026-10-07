/* Original WineBrowser contributors, MIT. Native DC settings and empty transfers. */
#include <windows.h>
#include <stdio.h>
int main(void){
 HDC dc=CreateCompatibleDC(NULL);BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=3;bmi.bmiHeader.biHeight=-3;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;DWORD source[9]={0};
 int first=1;puts("[");int modes[]={0,5,-1,2,4};
 for(unsigned i=0;i<sizeof(modes)/sizeof(modes[0]);i++){
  SetLastError(777);int result=SetStretchBltMode(dc,modes[i]);DWORD error=GetLastError();
  printf("%s{\"type\":\"mode\",\"value\":%d,\"result\":%d,\"error\":%lu,\"mode\":%d}",first?"":",\n",modes[i],result,error,GetStretchBltMode(dc));first=0;
 }
 int rectangles[][8]={{0,0,16,16,40,40,3,3},{0,0,16,16,-40,-40,3,3},{0,0,0,16,0,0,3,3},{0,0,16,0,0,0,3,3},{0,0,16,16,0,0,0,3},{0,0,16,16,0,0,3,0}};
 for(unsigned i=0;i<sizeof(rectangles)/sizeof(rectangles[0]);i++){
  int *a=rectangles[i];SetLastError(777);int result=StretchDIBits(dc,a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],source,&bmi,0,SRCCOPY);DWORD error=GetLastError();
  printf(",\n{\"type\":\"empty\",\"args\":[");for(int n=0;n<8;n++)printf("%s%d",n?",":"",a[n]);printf("],\"result\":%d,\"error\":%lu}",result,error);
 }
 puts("\n]");DeleteDC(dc);return 0;
}
