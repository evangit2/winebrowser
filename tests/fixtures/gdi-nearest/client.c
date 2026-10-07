/* Original WineBrowser contributors, MIT. Native SDK nearest-color ABI checks. */
#include <windows.h>
#include "native-cases.h"
#define CHECK(x) do {if(!(x))ExitProcess(1000+__LINE__);}while(0)
void *memset(void *target,int value,size_t count){BYTE *p=target;while(count--)*p++=(BYTE)value;return target;}
void start(void){
 CHECK(!lstrcmpW(L"native",L"native"));HDC dc[8];HBITMAP bitmap[8]={0};HGDIOBJ old[8]={0};
 for(int type=0;type<8;type++){
  dc[type]=type==0?GetDC(NULL):CreateCompatibleDC(NULL);CHECK(dc[type]);
  if(type>=2){BYTE header[1064]={0};BITMAPINFO *bmi=(BITMAPINFO *)header;bmi->bmiHeader.biSize=40;bmi->bmiHeader.biWidth=1;bmi->bmiHeader.biHeight=-1;bmi->bmiHeader.biPlanes=1;int depths[]={0,0,16,16,24,32,8,1};bmi->bmiHeader.biBitCount=depths[type];
   if(type==3){bmi->bmiHeader.biCompression=BI_BITFIELDS;DWORD *m=(DWORD *)(header+40);m[0]=0xf800;m[1]=0x07e0;m[2]=0x001f;}
   if(type==6){bmi->bmiHeader.biClrUsed=4;DWORD table[]={0,0xff0000,0x00ff00,0xffffff};for(int i=0;i<4;i++)((DWORD *)(header+40))[i]=table[i];}
   if(type==7){((DWORD *)(header+40))[0]=0;((DWORD *)(header+40))[1]=0xffffff;}
   void *bits;bitmap[type]=CreateDIBSection(dc[type],bmi,0,&bits,NULL,0);CHECK(bitmap[type]&&bits);old[type]=SelectObject(dc[type],bitmap[type]);CHECK(old[type]);
  }
 }
 BYTE palStorage[4+3*sizeof(PALETTEENTRY)]={0};LOGPALETTE *pal=(LOGPALETTE *)palStorage;pal->palVersion=0x300;pal->palNumEntries=3;
 const BYTE entries[][3]={{17,29,41},{181,47,39},{54,210,19}};for(int i=0;i<3;i++){pal->palPalEntry[i].peRed=entries[i][0];pal->palPalEntry[i].peGreen=entries[i][1];pal->palPalEntry[i].peBlue=entries[i][2];}
 HPALETTE custom=CreatePalette(pal);CHECK(custom);
 for(unsigned i=0;i<sizeof(cases)/sizeof(cases[0]);i++){
  const struct NativeCase *c=&cases[i];CHECK(SelectPalette(dc[c->surface],c->palette?custom:(HPALETTE)GetStockObject(DEFAULT_PALETTE),FALSE));
  SetLastError(777);CHECK(GetNearestColor(dc[c->surface],c->input)==c->result&&GetLastError()==c->error);
 }
 for(int type=0;type<8;type++){
  CHECK(SelectPalette(dc[type],(HPALETTE)GetStockObject(DEFAULT_PALETTE),FALSE));
  if(type>=2)CHECK(SelectObject(dc[type],old[type])&&DeleteObject(bitmap[type]));
  if(type==0)CHECK(ReleaseDC(NULL,dc[type]));else CHECK(DeleteDC(dc[type]));
 }
 CHECK(DeleteObject(custom));const CHAR pass[]="NATIVE NEAREST COLOR PASS\n";DWORD written=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),pass,sizeof(pass)-1,&written,NULL)&&written==sizeof(pass)-1);ExitProcess(0);
}
