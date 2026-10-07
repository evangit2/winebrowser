/* Original WineBrowser contributors, MIT. Native scrollbar state oracle. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
static int first=1;
static void snapshot(HWND window,int bar,const char *name,LONG returned,DWORD error,SCROLLINFO *query,LONG queryResult,DWORD queryError) {
    SCROLLINFO state={sizeof(state),SIF_ALL,0x13579,0x2468,0x3579,0x468a,0x579b};
    SetLastError(777);BOOL got=GetScrollInfo(window,bar,&state);DWORD gotError=GetLastError();
    int min=0x1234,max=0x5678;SetLastError(777);BOOL range=GetScrollRange(window,bar,&min,&max);DWORD rangeError=GetLastError();
    SetLastError(777);int pos=GetScrollPos(window,bar);DWORD posError=GetLastError();
    printf("%s{\"name\":\"%s\",\"bar\":%d,\"returned\":%ld,\"error\":%lu,\"getResult\":%d,\"getError\":%lu,\"state\":[%u,%u,%d,%d,%u,%d,%d],\"rangeResult\":%d,\"rangeError\":%lu,\"range\":[%d,%d],\"pos\":%d,\"posError\":%lu",
        first?"":",\n",name,bar,returned,error,got,gotError,state.cbSize,state.fMask,state.nMin,state.nMax,state.nPage,state.nPos,state.nTrackPos,range,rangeError,min,max,pos,posError);first=0;
    if(query)printf(",\"queryResult\":%ld,\"queryError\":%lu,\"query\":[%u,%u,%d,%d,%u,%d,%d]",queryResult,queryError,query->cbSize,query->fMask,query->nMin,query->nMax,query->nPage,query->nPos,query->nTrackPos);
    puts("}");
}
static void probe(HWND window,int bar,const char *name,unsigned mask,int min,int max,unsigned page,int pos,int track,unsigned size) {
    SCROLLINFO input={size,mask,min,max,page,pos,track};SetLastError(777);
    int result=SetScrollInfo(window,bar,&input,FALSE);DWORD error=GetLastError();
    snapshot(window,bar,name,result,error,NULL,0,0);
}
int main(void) {
    WNDCLASSW cls={0};cls.lpfnWndProc=DefWindowProcW;cls.hInstance=GetModuleHandleW(NULL);cls.lpszClassName=L"NativeScrollState";
    if(!RegisterClassW(&cls))return 1;
    const DWORD styles[]={WS_POPUP,WS_OVERLAPPEDWINDOW|WS_HSCROLL,WS_OVERLAPPEDWINDOW|WS_VSCROLL,WS_OVERLAPPEDWINDOW|WS_HSCROLL|WS_VSCROLL};
    puts("[");
    for(unsigned style=0;style<4;style++)for(int bar=0;bar<5;bar++){
        HWND window=CreateWindowExW(0,cls.lpszClassName,L"Scroll state",styles[style],20,30,200,120,NULL,NULL,cls.hInstance,NULL);if(!window)return 2;
        char name[64];sprintf(name,"%u-initial",style);snapshot(window,bar,name,0,777,NULL,0,0);
        sprintf(name,"%u-range-page-pos",style);probe(window,bar,name,SIF_RANGE|SIF_PAGE|SIF_POS,10,40,8,50,999,sizeof(SCROLLINFO));
        SetLastError(777);int result=SetScrollPos(window,bar,31,FALSE);DWORD error=GetLastError();sprintf(name,"%u-set-pos",style);snapshot(window,bar,name,result,error,NULL,0,0);
        sprintf(name,"%u-track-only",style);probe(window,bar,name,SIF_TRACKPOS,100,200,10,18,456,sizeof(SCROLLINFO));
        sprintf(name,"%u-page-large",style);probe(window,bar,name,SIF_PAGE,0,0,100,0,0,sizeof(SCROLLINFO));
        sprintf(name,"%u-reversed-range",style);probe(window,bar,name,SIF_RANGE,40,10,0,0,0,sizeof(SCROLLINFO));
        sprintf(name,"%u-range-extremes",style);probe(window,bar,name,SIF_RANGE|SIF_PAGE|SIF_POS,-2147483647-1,2147483647,0,2147483647,0,sizeof(SCROLLINFO));
        sprintf(name,"%u-old-size",style);probe(window,bar,name,SIF_RANGE|SIF_POS,-20,200,0,42,0,24);
        sprintf(name,"%u-bad-size",style);probe(window,bar,name,SIF_RANGE|SIF_POS,-20,200,0,42,0,20);
        sprintf(name,"%u-bad-mask",style);probe(window,bar,name,0x20,-20,200,0,42,0,28);
        for(unsigned mask=0;mask<32;mask++){
            SCROLLINFO query={sizeof(query),mask,0x13579,0x2468,0x3579,0x468a,0x579b};SetLastError(777);
            BOOL got=GetScrollInfo(window,bar,&query);DWORD gotError=GetLastError();sprintf(name,"%u-get-mask-%u",style,mask);snapshot(window,bar,name,0,777,&query,got,gotError);
        }
        SetLastError(777);BOOL resultRange=SetScrollRange(window,bar,-30,90,FALSE);DWORD errorRange=GetLastError();sprintf(name,"%u-set-range",style);snapshot(window,bar,name,resultRange,errorRange,NULL,0,0);
        DestroyWindow(window);
    }
    puts("]");return 0;
}
