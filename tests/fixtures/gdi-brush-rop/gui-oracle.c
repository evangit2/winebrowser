/* Original WineBrowser contributors, MIT. Actual SDK GUI reference pixels. */
#include "layout.h"
#include <stdio.h>
int main(void) {
    HDC screen=GetDC(NULL),dc=CreateCompatibleDC(screen);HBITMAP bitmap=CreateCompatibleBitmap(screen,640,340);HGDIOBJ old=SelectObject(dc,bitmap);puts("[");
    for(unsigned stage=0;stage<8;stage++){
        if(!paint_brushes(dc,stage))return 3;
        printf("%s{\"stage\":%u,\"runs\":[",stage?",\n":"",stage);int first=1;
        for(int y=96;y<340;y++)for(int x=0;x<640;){COLORREF color=GetPixel(dc,x,y);int end=x+1;while(end<640&&GetPixel(dc,end,y)==color)end++;
            if(color!=RGB(60,80,100)){printf("%s[%d,%d,%d,%lu]",first?"":",",x,y,end-x,color);first=0;}x=end;}puts("]}");
    }
    puts("]");SelectObject(dc,old);DeleteObject(bitmap);DeleteDC(dc);ReleaseDC(NULL,screen);return 0;
}
