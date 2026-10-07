/* Original WineBrowser contributors, MIT. Desktop Wine brush pixel oracle. */
#include <windows.h>
#include <stdio.h>
static int first=1;
static void emit(const char *name,HDC dc,int size,HBRUSH brush,int ox,int oy,BOOL pat) {
    RECT area={0,0,size,size};SetBrushOrgEx(dc,ox,oy,NULL);HGDIOBJ old=SelectObject(dc,brush);
    if(pat)PatBlt(dc,0,0,size,size,PATCOPY);else FillRect(dc,&area,brush);
    printf("%s{\"name\":\"%s\",\"size\":%d,\"origin\":[%d,%d],\"pixels\":[",first?"":",\n",name,size,ox,oy);first=0;
    for(int y=0;y<size;y++){for(int x=0;x<size;x++){printf("%s%lu",x||y?",":"",GetPixel(dc,x,y));}}
    puts("]}");SelectObject(dc,old);
}
static DWORD bgr(COLORREF c){return ((c&255)<<16)|(c&0xff00)|((c>>16)&255);}
int main(void) {
    HDC screen=GetDC(NULL),dc=CreateCompatibleDC(screen);HBITMAP dst=CreateCompatibleBitmap(screen,16,16);HGDIOBJ old=SelectObject(dc,dst);
    const COLORREF colors[]={RGB(220,235,244),RGB(245,223,187),RGB(220,239,227),RGB(236,218,240)};
    BITMAPINFO info={0};info.bmiHeader.biSize=40;info.bmiHeader.biWidth=16;info.bmiHeader.biHeight=-16;info.bmiHeader.biPlanes=1;info.bmiHeader.biBitCount=32;DWORD *pixels;
    HBITMAP source=CreateDIBSection(screen,&info,0,(void **)&pixels,0,0);
    for(int y=0;y<16;y++)for(int x=0;x<16;x++)pixels[y*16+x]=bgr(colors[(y>=8?2:0)+(x>=8?1:0)]);
    HBRUSH color=CreatePatternBrush(source);LOGBRUSH lb={BS_PATTERN,0,(ULONG_PTR)source};HBRUSH indirect=CreateBrushIndirect(&lb);pixels[0]=0xff0000;DeleteObject(source);
    BYTE bits[16];for(int y=0;y<8;y++){bits[y*2]=y<4?0xf0:0x0f;bits[y*2+1]=0;}
    source=CreateBitmap(8,8,1,1,bits);HBRUSH mono=CreatePatternBrush(source);DeleteObject(source);
    SetTextColor(dc,RGB(240,145,30));SetBkColor(dc,RGB(25,130,90));SetBkMode(dc,TRANSPARENT);
    puts("[");emit("color",dc,16,color,0,0,FALSE);emit("shifted",dc,16,indirect,3,-5,TRUE);emit("mono",dc,8,mono,0,0,FALSE);
    SetBkMode(dc,OPAQUE);SetBkColor(dc,colors[0]);
    for(int style=0;style<6;style++){HBRUSH hatch=CreateHatchBrush(style,RGB(40,70,120));char name[32];sprintf(name,"hatch-%d",style);emit(name,dc,8,hatch,0,0,FALSE);if(style==5)emit("hatch",dc,8,hatch,3,-5,FALSE);DeleteObject(hatch);}
    puts("]");SelectObject(dc,old);DeleteObject(dst);DeleteDC(dc);ReleaseDC(NULL,screen);DeleteObject(color);DeleteObject(indirect);DeleteObject(mono);return 0;
}
