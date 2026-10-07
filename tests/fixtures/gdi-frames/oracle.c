/* Original WineBrowser contributors, MIT. Native SDK frame/focus pixel oracle. */
#include <windows.h>
#include <stdio.h>
static int first=1;
static void emit(HDC dc, const char *name, RECT rect, BOOL focus, HBRUSH brush, int repeats, int clip) {
    RECT all={0,0,16,16}; SelectClipRgn(dc,NULL);
    FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH));
    if(clip){HRGN a=CreateRectRgn(0,0,12,12), b=CreateRectRgn(4,4,8,8);CombineRgn(a,a,b,RGN_DIFF);SelectClipRgn(dc,a);DeleteObject(a);DeleteObject(b);}
    SetLastError(777);int result=0;for(int i=0;i<repeats;i++) result=focus?DrawFocusRect(dc,&rect):FrameRect(dc,&rect,brush);
    printf("%s{\"name\":\"%s\",\"rect\":[%ld,%ld,%ld,%ld],\"focus\":%s,\"repeats\":%d,\"clip\":%d,\"result\":%d,\"error\":%lu,\"pixels\":[",first?"":",\n",name,rect.left,rect.top,rect.right,rect.bottom,focus?"true":"false",repeats,clip,result,GetLastError());first=0;
    SelectClipRgn(dc,NULL);for(int y=0;y<16;y++)for(int x=0;x<16;x++)printf("%s%lu",x||y?",":"",GetPixel(dc,x,y));puts("]}");
}
static void gui(HDC screen, HDC dc, int mode) {
    HBITMAP dst=CreateCompatibleBitmap(screen,480,280);HGDIOBJ old=SelectObject(dc,dst);SelectClipRgn(dc,NULL);
    SetBrushOrgEx(dc,0,0,NULL);RECT all={0,0,480,280},area={0,100,480,280},frame={30,110,450,260},focus={36,116,444,254};
    HBRUSH back=CreateSolidBrush(RGB(220,235,244)),brush=CreateSolidBrush(RGB(40,70,120));FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH));FillRect(dc,&area,back);
    if(mode==4){DeleteObject(brush);brush=CreateHatchBrush(HS_DIAGCROSS,RGB(40,70,120));SetBkMode(dc,TRANSPARENT);SetBrushOrgEx(dc,3,-5,NULL);}
    if(mode==5){DeleteObject(brush);BITMAPINFO info={0};info.bmiHeader.biSize=40;info.bmiHeader.biWidth=2;info.bmiHeader.biHeight=-2;info.bmiHeader.biPlanes=1;info.bmiHeader.biBitCount=32;DWORD *bits;HBITMAP tile=CreateDIBSection(screen,&info,0,(void **)&bits,NULL,0);bits[0]=0xe87818;bits[1]=0x188858;bits[2]=0x9850b8;bits[3]=0xe87818;brush=CreatePatternBrush(tile);DeleteObject(tile);SetBrushOrgEx(dc,3,-5,NULL);}
    if(mode==6){HRGN a=CreateRectRgn(0,100,400,260),b=CreateRectRgn(200,110,250,120);CombineRgn(a,a,b,RGN_DIFF);SelectClipRgn(dc,a);DeleteObject(a);DeleteObject(b);}
    FrameRect(dc,&frame,brush);if(mode==2||mode==3||mode==6)DrawFocusRect(dc,&focus);if(mode==3)DrawFocusRect(dc,&focus);SelectClipRgn(dc,NULL);
    printf("%s{\"name\":\"gui-%d\",\"size\":[480,280],\"runs\":[",first?"":",\n",mode);first=0;int rowfirst=1;
    for(int y=100;y<280;y++){for(int x=0;x<480;){COLORREF color=GetPixel(dc,x,y);int end=x+1;while(end<480&&GetPixel(dc,end,y)==color)end++;if(color!=RGB(220,235,244)){printf("%s[%d,%d,%d,%lu]",rowfirst?"":",",x,y,end-x,color);rowfirst=0;}x=end;}}
    puts("]}");
    SelectObject(dc,old);DeleteObject(dst);DeleteObject(back);DeleteObject(brush);
}
int main(void) {
    HDC screen=GetDC(NULL),dc=CreateCompatibleDC(screen);HBITMAP bitmap=CreateCompatibleBitmap(screen,16,16);HGDIOBJ old=SelectObject(dc,bitmap);
    HBRUSH brush=CreateSolidBrush(RGB(40,70,120)),hatch=CreateHatchBrush(HS_CROSS,RGB(40,70,120));
    RECT rects[]={{2,2,13,12},{3,3,14,13},{2,2,3,12},{2,2,13,3},{2,2,3,3},{2,2,2,12},{2,2,13,2},{13,12,2,2},{-2,-3,8,9},{0,0,16,16}};
    puts("[");for(unsigned i=0;i<sizeof(rects)/sizeof(rects[0]);i++){char name[32];sprintf(name,"focus-%u",i);emit(dc,name,rects[i],TRUE,NULL,1,0);sprintf(name,"frame-%u",i);emit(dc,name,rects[i],FALSE,brush,1,0);}
    emit(dc,"focus-double",rects[0],TRUE,NULL,2,0);emit(dc,"focus-clip",rects[0],TRUE,NULL,1,1);emit(dc,"frame-clip",rects[0],FALSE,brush,1,1);
    SetBrushOrgEx(dc,3,-5,NULL);SetTextColor(dc,RGB(255,0,0));SetBkColor(dc,RGB(0,255,0));SetBkMode(dc,TRANSPARENT);emit(dc,"focus-state",rects[0],TRUE,NULL,1,0);emit(dc,"frame-hatch",rects[9],FALSE,hatch,1,0);emit(dc,"frame-null",rects[0],FALSE,(HBRUSH)GetStockObject(NULL_BRUSH),1,0);
    for(int mode=1;mode<=6;mode++)gui(screen,dc,mode);
    puts("]");SelectObject(dc,old);DeleteObject(bitmap);DeleteObject(brush);DeleteObject(hatch);DeleteDC(dc);ReleaseDC(NULL,screen);return 0;
}
