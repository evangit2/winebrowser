/* Original WineBrowser contributors, MIT. Native nearest-color behavior. */
#include <windows.h>
#include <stdio.h>
int main(void){
 DWORD colors[]={0,0xffffff,RGB(1,2,3),RGB(3,15,1),RGB(24,60,8),RGB(127,127,127),RGB(128,128,128),RGB(126,125,124),RGB(250,249,248),RGB(180,40,30),0x01000001,0x01000013,0x020000a5,0xffabcdef,0x10ff0000,0x10ff0001,0x10ff0002,0x10ff0003,0x10ff00ff,RGB(0,255,0),RGB(255,0,255),RGB(20,200,220)};int first=1;puts("[");
 for(int type=0;type<8;type++){
  HDC dc=type==0?GetDC(NULL):CreateCompatibleDC(NULL);HBITMAP bitmap=NULL;HGDIOBJ old=NULL;
  if(type>=2){BYTE header[1064]={0};BITMAPINFO *bmi=(BITMAPINFO *)header;bmi->bmiHeader.biSize=40;bmi->bmiHeader.biWidth=1;bmi->bmiHeader.biHeight=-1;bmi->bmiHeader.biPlanes=1;
   int depths[]={0,0,16,16,24,32,8,1};bmi->bmiHeader.biBitCount=depths[type];
   if(type==3){bmi->bmiHeader.biCompression=BI_BITFIELDS;DWORD *m=(DWORD *)(header+40);m[0]=0xf800;m[1]=0x07e0;m[2]=0x001f;}
   if(type==6){bmi->bmiHeader.biClrUsed=4;DWORD table[]={0,0xff0000,0x00ff00,0xffffff};for(int i=0;i<4;i++)((DWORD *)(header+40))[i]=table[i];}
   if(type==7){((DWORD *)(header+40))[0]=0;((DWORD *)(header+40))[1]=0xffffff;}
   void *bits;bitmap=CreateDIBSection(dc,bmi,0,&bits,NULL,0);old=SelectObject(dc,bitmap);
  }
  BYTE palStorage[4+3*sizeof(PALETTEENTRY)]={0};LOGPALETTE *pal=(LOGPALETTE *)palStorage;pal->palVersion=0x300;pal->palNumEntries=3;
  const BYTE entries[][3]={{17,29,41},{181,47,39},{54,210,19}};for(int i=0;i<3;i++){pal->palPalEntry[i].peRed=entries[i][0];pal->palPalEntry[i].peGreen=entries[i][1];pal->palPalEntry[i].peBlue=entries[i][2];}
  HPALETTE custom=CreatePalette(pal),previous=NULL;
  for(int selected=0;selected<2;selected++){
   if(selected)previous=SelectPalette(dc,custom,FALSE);
   for(unsigned i=0;i<sizeof(colors)/sizeof(colors[0]);i++){
   SetLastError(777);DWORD result=GetNearestColor(dc,colors[i]),error=GetLastError();
   printf("%s{\"surface\":%d,\"palette\":%d,\"input\":%lu,\"result\":%lu,\"error\":%lu}",first?"":",\n",type,selected,colors[i],result,error);first=0;
  }
  }
  SelectPalette(dc,previous,FALSE);DeleteObject(custom);
  if(bitmap){SelectObject(dc,old);DeleteObject(bitmap);}if(type==0)ReleaseDC(NULL,dc);else DeleteDC(dc);
 }
 puts("\n]");return 0;
}
