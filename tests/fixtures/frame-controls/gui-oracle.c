/* Original WineBrowser contributors, MIT. Actual SDK GUI reference pixels. */
#include "layout.h"
#include <stdio.h>
int main(void){
    int indices[]={COLOR_WINDOW,COLOR_WINDOWFRAME,COLOR_WINDOWTEXT,COLOR_BTNFACE,COLOR_BTNSHADOW,COLOR_BTNTEXT,COLOR_BTNHIGHLIGHT,COLOR_3DDKSHADOW,COLOR_3DLIGHT};
    COLORREF colors[]={0xffffff,0,0,0xc0c0c0,0x808080,0,0xffffff,0x404040,0xe3e3e3},original[9];
    for(int i=0;i<9;i++)original[i]=GetSysColor(indices[i]);if(!SetSysColors(9,indices,colors))return 2;
    HDC screen=GetDC(NULL),dc=CreateCompatibleDC(screen);HBITMAP bitmap=CreateCompatibleBitmap(screen,640,340);HGDIOBJ old=SelectObject(dc,bitmap);puts("[");
    for(unsigned stage=0;stage<10;stage++){
        if(!paint_controls(dc,stage))return 3;printf("%s{\"stage\":%u,\"runs\":[",stage?",\n":"",stage);int first=1;
        for(int y=96;y<340;y++)for(int x=0;x<640;){COLORREF color=GetPixel(dc,x,y);int end=x+1;while(end<640&&GetPixel(dc,end,y)==color)end++;if(color!=RGB(60,80,100)){printf("%s[%d,%d,%d,%lu]",first?"":",",x,y,end-x,color);first=0;}x=end;}puts("]}");
    }
    puts("]");SelectObject(dc,old);DeleteObject(bitmap);DeleteDC(dc);ReleaseDC(NULL,screen);SetSysColors(9,indices,original);return 0;
}
