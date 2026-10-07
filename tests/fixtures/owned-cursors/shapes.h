/* Original WineBrowser contributors, MIT. Native bitmap cursor sample inputs. */
#define UNICODE
#include <windows.h>
static HCURSOR make_cursor(BOOL mono,DWORD hotx,DWORD hoty){
 BYTE packed[64]={0};
 for(int y=0;y<16;y++)for(int x=0;x<16;x++){
  if(mono&&y>=8)packed[y*2+x/8]|=0x80>>(x%8);
  if(mono&&x>=8)packed[32+y*2+x/8]|=0x80>>(x%8);
 }
 HBITMAP mask=CreateBitmap(16,mono?32:16,1,1,packed),color=NULL;HDC dc=CreateCompatibleDC(NULL);
 if(!mono){BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=16;bmi.bmiHeader.biHeight=-16;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;DWORD *bits;color=CreateDIBSection(dc,&bmi,0,(void **)&bits,NULL,0);
  if(color)for(int y=0;y<16;y++)for(int x=0;x<16;x++)bits[y*16+x]=x<8?(y<8?0x80200000:0x80200040):(y<8?0xff00a000:0xff00a060);
 }
 ICONINFO info={FALSE,hotx,hoty,mask,color};HCURSOR cursor=mask&&(mono||color)?CreateIconIndirect(&info):NULL;
 if(mask){DeleteObject(mask);}if(color){DeleteObject(color);}DeleteDC(dc);return cursor;
}
