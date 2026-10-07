/* Original WineBrowser contributors, MIT. Native scrollbar keyboard notification probe. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
static int first=1,styleId,keyId,phase;static HWND target;
static LRESULT CALLBACK procedure(HWND w,UINT m,WPARAM wp,LPARAM lp){
    if(m==WM_HSCROLL||m==WM_VSCROLL){SCROLLINFO out={0};out.cbSize=28;out.fMask=SIF_ALL;GetScrollInfo((HWND)lp,SB_CTL,&out);
        printf("%s{\"style\":%d,\"key\":%d,\"phase\":%d,\"message\":%u,\"command\":%u,\"positionWord\":%u,\"target\":%d,\"pos\":%d,\"track\":%d}",first?"":",\n",styleId,keyId,phase,m,LOWORD(wp),HIWORD(wp),(HWND)lp==target,out.nPos,out.nTrackPos);first=0;return 0;}
    return DefWindowProcW(w,m,wp,lp);
}
int main(void){WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=GetModuleHandleW(NULL);cls.lpszClassName=L"ScrollKeysParent";if(!RegisterClassW(&cls))return 1;
    HWND parent=CreateWindowExW(0,cls.lpszClassName,L"parent",WS_POPUP|WS_VISIBLE,10,20,240,160,NULL,NULL,cls.hInstance,NULL);
    const int keys[]={VK_LEFT,VK_RIGHT,VK_UP,VK_DOWN,VK_HOME,VK_END,VK_PRIOR,VK_NEXT,VK_SPACE,VK_RETURN,'A'};puts("[");
    for(styleId=0;styleId<2;styleId++){
        target=CreateWindowExW(0,L"SCROLLBAR",L"",WS_CHILD|WS_VISIBLE|(styleId?SBS_VERT:SBS_HORZ),10,20,styleId?17:180,styleId?100:17,parent,NULL,cls.hInstance,NULL);if(!target)return 2;
        SCROLLINFO in={28,SIF_ALL,10,40,8,20,0};SetScrollInfo(target,SB_CTL,&in,FALSE);SetFocus(target);
        for(unsigned i=0;i<sizeof(keys)/sizeof(keys[0]);i++){keyId=keys[i];phase=0;SendMessageW(target,WM_KEYDOWN,keyId,1);phase=1;SendMessageW(target,WM_KEYUP,keyId,0xc0000001);}
        DestroyWindow(target);
    }
    DestroyWindow(parent);puts("]");return 0;
}
