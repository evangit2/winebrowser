/* Original WineBrowser contributors, MIT. Extra native state/validation captures. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
int main(void) {
    WNDCLASSW cls={0};cls.lpfnWndProc=DefWindowProcW;cls.hInstance=GetModuleHandleW(NULL);cls.lpszClassName=L"NativeScrollExtra";if(!RegisterClassW(&cls))return 1;
    HWND window=CreateWindowExW(0,cls.lpszClassName,L"Scroll extra",WS_POPUP,20,30,200,120,NULL,NULL,cls.hInstance,NULL);
    SCROLLINFO init={28,SIF_ALL,10,40,8,33,999};SetScrollInfo(window,0,&init,FALSE);
    int first=1;puts("[");
    const UINT sizes[]={0,20,24,28,32},masks[]={0,16,23,32,63};
    for(int bar=0;bar<5;bar++)for(unsigned s=0;s<5;s++)for(unsigned m=0;m<5;m++){
        SCROLLINFO q={sizes[s],masks[m],1,2,3,4,5};SetLastError(777);BOOL got=GetScrollInfo(window,bar,&q);DWORD error=GetLastError();
        printf("%s{\"kind\":\"get\",\"bar\":%d,\"size\":%u,\"mask\":%u,\"result\":%d,\"error\":%lu,\"out\":[%u,%u,%d,%d,%u,%d,%d]}",first?"":",\n",bar,sizes[s],masks[m],got,error,q.cbSize,q.fMask,q.nMin,q.nMax,q.nPage,q.nPos,q.nTrackPos);first=0;
    }
    for(int valid=0;valid<2;valid++)for(int bar=0;bar<5;bar++){
        HWND target=valid?window:(HWND)(UINT_PTR)0x1234;SetLastError(777);int result=SetScrollInfo(target,bar,NULL,FALSE);DWORD error=GetLastError();printf(",\n{\"kind\":\"set-null\",\"valid\":%d,\"bar\":%d,\"result\":%d,\"error\":%lu}",valid,bar,result,error);
        SetLastError(777);result=GetScrollInfo(target,bar,NULL);error=GetLastError();printf(",\n{\"kind\":\"get-null\",\"valid\":%d,\"bar\":%d,\"result\":%d,\"error\":%lu}",valid,bar,result,error);
        int min=1,max=2;SetLastError(777);result=GetScrollRange(target,bar,&min,&max);error=GetLastError();printf(",\n{\"kind\":\"get-range\",\"valid\":%d,\"bar\":%d,\"result\":%d,\"error\":%lu,\"range\":[%d,%d]}",valid,bar,result,error,min,max);
    }
    for(int bar=0;bar<5;bar++){
        SetLastError(777);BOOL result=SetScrollRange(window,bar,-2147483647-1,2147483647,FALSE);DWORD error=GetLastError();int min=1,max=2;GetScrollRange(window,bar,&min,&max);printf(",\n{\"kind\":\"set-range-extreme\",\"bar\":%d,\"result\":%d,\"error\":%lu,\"range\":[%d,%d]}",bar,result,error,min,max);
    }
    puts("]");DestroyWindow(window);return 0;
}
