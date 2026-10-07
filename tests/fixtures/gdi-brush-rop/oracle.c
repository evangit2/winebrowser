/* Original WineBrowser contributors, MIT. Native brush raster-operation oracle. */
#include <windows.h>
#include <stdio.h>
static int first = 1;
static void emit(HDC dc, int fill, unsigned rop, unsigned brush, RECT rect, int clip) {
    RECT all={0,0,16,16};
    SelectClipRgn(dc,NULL);
    HBRUSH back=CreateSolidBrush(0x9e6a35); FillRect(dc,&all,back); DeleteObject(back);
    if(clip){HRGN a=CreateRectRgn(1,2,14,15), b=CreateRectRgn(5,6,9,10);
        CombineRgn(a,a,b,RGN_DIFF);SelectClipRgn(dc,a);DeleteObject(a);DeleteObject(b);}
    HBRUSH selected;
    if(brush==0) selected=CreateSolidBrush(0x784628);
    else if(brush==1||brush==2){BYTE bits[]={0xaa,0,0x55,0,0xaa,0,0x55,0,0xaa,0,0x55,0,0xaa,0,0x55,0};
        HBITMAP source=CreateBitmap(8,8,1,1,bits);selected=CreatePatternBrush(source);DeleteObject(source);}
    else if(brush==3||brush==4) selected=CreateHatchBrush(HS_DIAGCROSS,0x784628);
    else if(brush==6){BITMAPINFO info={0};info.bmiHeader.biSize=40;info.bmiHeader.biWidth=2;info.bmiHeader.biHeight=-2;
        info.bmiHeader.biPlanes=1;info.bmiHeader.biBitCount=32;DWORD *pixels;
        HBITMAP source=CreateDIBSection(dc,&info,DIB_RGB_COLORS,(void **)&pixels,NULL,0);
        pixels[0]=0x225588;pixels[1]=0x66aa33;pixels[2]=0xcc4477;pixels[3]=0xaadd99;
        selected=CreatePatternBrush(source);DeleteObject(source);}
    else selected=(HBRUSH)GetStockObject(NULL_BRUSH);
    HGDIOBJ old=SelectObject(dc,selected);
    SetBkMode(dc,(brush==2||brush==4)?TRANSPARENT:OPAQUE);
    SetBrushOrgEx(dc,3,-5,NULL);SetTextColor(dc,0x123456);SetBkColor(dc,0x654321);
    MoveToEx(dc,13,14,NULL);SetLastError(777);
    BOOL result=fill?FillRect(dc,&rect,selected):PatBlt(dc,rect.left,rect.top,rect.right-rect.left,rect.bottom-rect.top,rop);
    DWORD error=GetLastError();POINT position;GetCurrentPositionEx(dc,&position);
    printf("%s{\"fill\":%d,\"rop\":%u,\"brush\":%u,\"rect\":[%ld,%ld,%ld,%ld],\"clip\":%d,\"result\":%d,\"error\":%lu,\"position\":[%ld,%ld],\"runs\":[",
        first?"":",\n",fill,rop,brush,rect.left,rect.top,rect.right,rect.bottom,clip,result,error,position.x,position.y);first=0;
    SelectClipRgn(dc,NULL);int emitted=0;
    for(int y=0;y<16;y++)for(int x=0;x<16;){COLORREF color=GetPixel(dc,x,y);int end=x+1;
        while(end<16&&GetPixel(dc,end,y)==color)end++;
        if(color!=0x9e6a35){printf("%s[%d,%d,%d,%lu]",emitted?",":"",x,y,end-x,color);emitted=1;}x=end;}
    puts("]}");SelectObject(dc,old);if(brush!=5)DeleteObject(selected);
}
int main(void) {
    HDC screen=GetDC(NULL),dc=CreateCompatibleDC(screen);HBITMAP bitmap=CreateCompatibleBitmap(screen,16,16);HGDIOBJ old=SelectObject(dc,bitmap);
    const DWORD rops[]={0x00000042,0x000500a9,0x000a0329,0x000f0001,0x00500325,0x00550009,0x005a0049,0x005f00e9,
        0x00a000c9,0x00a50065,0x00aa0029,0x00af0229,0x00f00021,0x00f50225,0x00fa0089,0x00ff0062};
    const RECT rects[]={{2,3,13,12},{13,3,2,12},{2,12,13,3},{13,12,2,3},{5,5,5,12},{5,5,12,5},{5,5,6,6},{-3,-2,8,9},{0,0,16,16}};
    puts("[");
    for(unsigned rop=0;rop<16;rop++)for(unsigned brush=0;brush<7;brush++)for(unsigned rect=0;rect<9;rect++)
        emit(dc,0,rops[rop],brush,rects[rect],rect==8);
    for(unsigned brush=0;brush<7;brush++)for(unsigned rect=0;rect<9;rect++)emit(dc,1,0,brush,rects[rect],rect==8);
    /* Enumerate all 256 truth tables, including unsupported source dependencies. */
    for(unsigned rop=0;rop<256;rop++)emit(dc,0,rop<<16,0,rects[0],0);
    puts("]");SelectObject(dc,old);DeleteObject(bitmap);DeleteDC(dc);ReleaseDC(NULL,screen);return 0;
}
