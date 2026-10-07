/* Original WineBrowser contributors, MIT. Shared SDK sample inputs. */
#include <windows.h>
static int sample(HDC dc,DWORD *destination,int panel,int stage){
 const DWORD colors[]={0x80102030,0x40405060,0xff708090,0x00a0b0c0,0x20d0e0f0,0x60332211,0x90446688,0xc0557799,0x006688aa};
 BYTE storage[36]={0},header[52]={0};BITMAPINFO *bmi=(BITMAPINFO *)header;
 bmi->bmiHeader.biSize=40;bmi->bmiHeader.biWidth=3;bmi->bmiHeader.biHeight=panel==0?3:-3;bmi->bmiHeader.biPlanes=1;bmi->bmiHeader.biBitCount=panel<2?32:panel==2?24:16;
 int depth=bmi->bmiHeader.biBitCount,stride=((3*depth+31)/32)*4;
 if(panel==3){bmi->bmiHeader.biCompression=BI_BITFIELDS;DWORD *m=(DWORD *)(header+40);m[0]=0xf800;m[1]=0x07e0;m[2]=0x001f;}
 for(int y=0;y<3;y++)for(int x=0;x<3;x++){int n=y*3+x,at=y*stride;
  if(depth==32)((DWORD *)(storage+at))[x]=colors[n];
  else if(depth==24){storage[at+x*3]=17+n;storage[at+x*3+1]=34+n;storage[at+x*3+2]=51+n;}
  else ((WORD *)(storage+at))[x]=((3+n)<<11)|((15+n)<<5)|(1+n);
 }
 SelectClipRgn(dc,NULL);for(int i=0;i<256;i++)destination[i]=0x70406080;
 if(stage==5){HRGN a=CreateRectRgn(2,2,6,6),b=CreateRectRgn(3,3,5,5);CombineRgn(a,a,b,RGN_DIFF);SelectClipRgn(dc,a);DeleteObject(a);DeleteObject(b);}
 int width=stage==4?2:stage==8?1:3,height=width,sx=stage==4?1:0,sy=sx,start=stage==3?1:0,lines=stage==2?1:stage==3?2:stage==6?5:stage==7?0:3;
 SetLastError(777);int result=SetDIBitsToDevice(dc,2,2,width,height,sx,sy,start,lines,storage,bmi,DIB_RGB_COLORS);
 return result;
}
