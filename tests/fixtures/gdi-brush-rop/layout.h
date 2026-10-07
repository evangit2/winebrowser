/* Original WineBrowser contributors, MIT. Shared SDK brush GUI inputs. */
#ifndef GDI_BRUSH_ROP_LAYOUT_H
#define GDI_BRUSH_ROP_LAYOUT_H
#define UNICODE
#include <windows.h>
static const DWORD brush_rops[]={0x00000042,0x000500a9,0x000a0329,0x000f0001,0x00500325,0x00550009,0x005a0049,0x005f00e9,
    0x00a000c9,0x00a50065,0x00aa0029,0x00af0229,0x00f00021,0x00f50225,0x00fa0089,0x00ff0062};
static HBRUSH pattern_brush(HDC dc, BOOL color) {
    HBITMAP bitmap;
    if(color){BITMAPINFO info={0};info.bmiHeader.biSize=40;info.bmiHeader.biWidth=8;info.bmiHeader.biHeight=-8;
        info.bmiHeader.biPlanes=1;info.bmiHeader.biBitCount=32;DWORD *pixels;
        bitmap=CreateDIBSection(dc,&info,DIB_RGB_COLORS,(void **)&pixels,NULL,0);if(!bitmap)return NULL;
        const DWORD colors[]={0x225588,0x66aa33,0xcc4477,0xaadd99};
        for(int y=0;y<8;y++)for(int x=0;x<8;x++)pixels[y*8+x]=colors[(y>=4?2:0)+(x>=4?1:0)];
    }else{BYTE bits[]={0xaa,0,0x55,0,0xaa,0,0x55,0,0xaa,0,0x55,0,0xaa,0,0x55,0};bitmap=CreateBitmap(8,8,1,1,bits);if(!bitmap)return NULL;}
    HBRUSH brush=CreatePatternBrush(bitmap);if(!DeleteObject(bitmap))return NULL;return brush;
}
static BOOL paint_brushes(HDC dc,unsigned stage) {
    RECT area={0,96,640,340};HBRUSH back=CreateSolidBrush(RGB(60,80,100));
    if(!back||!FillRect(dc,&area,back)||!DeleteObject(back))return FALSE;
    SetBrushOrgEx(dc,5,-3,NULL);SetTextColor(dc,RGB(18,52,86));SetBkColor(dc,RGB(140,170,200));SetBkMode(dc,stage==4?TRANSPARENT:OPAQUE);
    if(stage==5){HRGN a=CreateRectRgn(0,96,600,330),b=CreateEllipticRgn(227,110,346,282);
        if(!a||!b||!CombineRgn(a,a,b,RGN_DIFF)||!SelectClipRgn(dc,a)||!DeleteObject(a)||!DeleteObject(b))return FALSE;}
    HBRUSH brush=(stage==1||stage==5)?pattern_brush(dc,FALSE):stage==2?pattern_brush(dc,TRUE):(stage==3||stage==4)?CreateHatchBrush(HS_DIAGCROSS,RGB(40,70,120)):CreateSolidBrush(RGB(40,70,120));
    HBRUSH base=CreateSolidBrush(RGB(180,110,50));if(!brush||!base)return FALSE;
    HGDIOBJ old=SelectObject(dc,brush);if(!old)return FALSE;
    for(int i=0;i<16;i++){
        int x=12+(i%4)*156,y=106+(i/4)*56;RECT box={x,y,x+148,y+48},half={x+74,y,x+148,y+48};
        if(stage==6)half=(RECT){half.right-1,half.bottom-1,half.left-1,half.top-1};
        if(!FillRect(dc,&half,base))return FALSE;
        SetLastError(777);
        if(!PatBlt(dc,stage==6?box.right-1:box.left,stage==6?box.bottom-1:box.top,stage==6?-148:148,stage==6?-48:48,brush_rops[i])||GetLastError()!=777)return FALSE;
        /* The missing source operation must fail atomically and retain error. */
        if(PatBlt(dc,box.left,box.top,148,48,SRCCOPY)||GetLastError()!=777)return FALSE;
        if(!FrameRect(dc,&box,(HBRUSH)GetStockObject(WHITE_BRUSH)))return FALSE;
    }
    if(!SelectObject(dc,old)||!DeleteObject(brush)||!DeleteObject(base)||SelectClipRgn(dc,NULL)==ERROR)return FALSE;
    return TRUE;
}
#endif
