/* Original WineBrowser contributors, MIT. Native SB_CTL forwarding oracle. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
static UINT lastMessage;static WPARAM lastWP;static LPARAM lastLP;
static LRESULT CALLBACK procedure(HWND w,UINT m,WPARAM wp,LPARAM lp){
    if(m>=SBM_SETPOS&&m<=SBM_GETSCROLLBARINFO){lastMessage=m;lastWP=wp;lastLP=lp;
        if(m==SBM_GETPOS)return -15;
        if(m==SBM_GETRANGE){*(int *)wp=-7;*(int *)lp=33;return 0;}
        if(m==SBM_GETSCROLLINFO){SCROLLINFO *s=(SCROLLINFO *)lp;if(s){s->nMin=-7;s->nMax=33;s->nPage=4;s->nPos=15;s->nTrackPos=9;}return 0;}
        return -5;
    }
    return DefWindowProcW(w,m,wp,lp);
}
static void record(const char *name,LONG result,DWORD error){printf("{\"name\":\"%s\",\"message\":%u,\"wp\":%ld,\"lp\":%ld,\"result\":%ld,\"error\":%lu}",name,lastMessage,(LONG)lastWP,(LONG)lastLP,result,error);lastMessage=0;lastWP=0;lastLP=0;}
int main(void){WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=GetModuleHandleW(NULL);cls.lpszClassName=L"ScrollCallback";if(!RegisterClassW(&cls))return 1;
    HWND w=CreateWindowExW(0,cls.lpszClassName,L"callback",WS_POPUP,20,30,200,120,NULL,NULL,cls.hInstance,NULL);if(!w)return 2;
    SCROLLINFO s={28,23,-10,50,8,30,20};SetLastError(777);int result=SetScrollInfo(w,SB_CTL,&s,FALSE);DWORD error=GetLastError();puts("[");record("set-info",result,error);
    SetLastError(777);result=GetScrollInfo(w,SB_CTL,&s);error=GetLastError();puts(",");record("get-info",result,error);printf(",\n{\"name\":\"query\",\"out\":[%u,%u,%d,%d,%u,%d,%d]}",s.cbSize,s.fMask,s.nMin,s.nMax,s.nPage,s.nPos,s.nTrackPos);
    SetLastError(777);result=SetScrollPos(w,SB_CTL,-12,TRUE);error=GetLastError();puts(",");record("set-pos",result,error);
    SetLastError(777);result=GetScrollPos(w,SB_CTL);error=GetLastError();puts(",");record("get-pos",result,error);
    SetLastError(777);result=SetScrollRange(w,SB_CTL,-20,60,FALSE);error=GetLastError();puts(",");record("set-range",result,error);
    SetLastError(777);result=SetScrollRange(w,SB_CTL,-20,60,TRUE);error=GetLastError();puts(",");record("set-range-redraw",result,error);
    int min=0,max=0;SetLastError(777);result=GetScrollRange(w,SB_CTL,&min,&max);error=GetLastError();puts(",");record("get-range",result,error);printf(",\n{\"name\":\"range\",\"out\":[%d,%d]}",min,max);
    puts("]");DestroyWindow(w);return 0;
}
