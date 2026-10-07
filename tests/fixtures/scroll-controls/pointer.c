/* Original WineBrowser contributors, MIT. Native scrollbar pointer notification probe. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
static int first=1,styleId,gesture;static HWND target;
static LRESULT CALLBACK procedure(HWND w,UINT m,WPARAM wp,LPARAM lp){
    if(m==WM_HSCROLL||m==WM_VSCROLL){SCROLLINFO out={0};out.cbSize=28;out.fMask=SIF_ALL;GetScrollInfo((HWND)lp,SB_CTL,&out);
        printf("%s{\"style\":%d,\"gesture\":%d,\"message\":%u,\"command\":%u,\"positionWord\":%u,\"target\":%d,\"pos\":%d,\"track\":%d}",first?"":",\n",styleId,gesture,m,LOWORD(wp),HIWORD(wp),(HWND)lp==target,out.nPos,out.nTrackPos);first=0;return 0;}
    return DefWindowProcW(w,m,wp,lp);
}
int main(void){WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=GetModuleHandleW(NULL);cls.lpszClassName=L"ScrollPointerParent";if(!RegisterClassW(&cls))return 1;
    HWND parent=CreateWindowExW(0,cls.lpszClassName,L"parent",WS_POPUP|WS_VISIBLE,10,20,240,200,NULL,NULL,cls.hInstance,NULL);puts("[");
    for(styleId=0;styleId<2;styleId++){
        target=CreateWindowExW(0,L"SCROLLBAR",L"",WS_CHILD|WS_VISIBLE|(styleId?SBS_VERT:SBS_HORZ),10,20,styleId?17:180,styleId?180:17,parent,NULL,cls.hInstance,NULL);if(!target)return 2;
        SCROLLINFO in={28,SIF_ALL,10,40,8,20,0};SetScrollInfo(target,SB_CTL,&in,TRUE);SetFocus(target);UpdateWindow(parent);UpdateWindow(target);
        SCROLLBARINFO b={0};b.cbSize=sizeof(b);if(!GetScrollBarInfo(target,OBJID_CLIENT,&b))return 3;
        int thumb=(b.xyThumbTop+b.xyThumbBottom)/2;int points[]={8,171,b.dxyLineButton+2,b.xyThumbBottom+2,thumb,thumb};
        for(gesture=0;gesture<7;gesture++){
            if(gesture==6){in.nMin=-20;in.nMax=200000;in.nPage=64;in.nPos=80000;SetScrollInfo(target,SB_CTL,&in,TRUE);EnableScrollBar(target,SB_CTL,ESB_ENABLE_BOTH);}
            if(gesture==5)EnableScrollBar(target,SB_CTL,ESB_DISABLE_BOTH);
            int start=gesture==6?76:points[gesture],finish=gesture==6?106:gesture==4?start+40:start;
            LPARAM from=styleId?MAKELPARAM(8,start):MAKELPARAM(start,8),to=styleId?MAKELPARAM(8,finish):MAKELPARAM(finish,8);
            PostMessageW(target,WM_MOUSEMOVE,MK_LBUTTON,to);PostMessageW(target,WM_LBUTTONUP,0,to);SendMessageW(target,WM_LBUTTONDOWN,MK_LBUTTON,from);
            MSG msg;while(PeekMessageW(&msg,NULL,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageW(&msg);}
        }
        DestroyWindow(target);
    }
    DestroyWindow(parent);puts("]");return 0;
}
