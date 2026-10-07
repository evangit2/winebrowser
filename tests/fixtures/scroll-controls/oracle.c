/* Original WineBrowser contributors, MIT. Native standalone scroll control state probe. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
static int first=1;
static void snapshot(HWND w,int style,const char *step,int returned,DWORD error){
    SCROLLINFO out={28,SIF_ALL,1,2,3,4,5};SetLastError(777);BOOL got=GetScrollInfo(w,SB_CTL,&out);DWORD e=GetLastError();
    int min=1,max=2;SetLastError(777);BOOL range=GetScrollRange(w,SB_CTL,&min,&max);DWORD re=GetLastError();
    SCROLLBARINFO b={0};b.cbSize=sizeof(b);SetLastError(777);BOOL bg=GetScrollBarInfo(w,OBJID_CLIENT,&b);DWORD be=GetLastError();
    printf("%s{\"style\":%d,\"step\":\"%s\",\"result\":%d,\"error\":%lu,\"got\":%d,\"getError\":%lu,\"state\":[%u,%u,%d,%d,%u,%d,%d],\"rangeResult\":%d,\"rangeError\":%lu,\"range\":[%d,%d],\"barResult\":%d,\"barError\":%lu,\"arrows\":[%lu,%lu]}",first?"":",\n",style,step,returned,error,got,e,out.cbSize,out.fMask,out.nMin,out.nMax,out.nPage,out.nPos,out.nTrackPos,range,re,min,max,bg,be,b.rgstate[1],b.rgstate[5]);first=0;
}
int main(void){
    WNDCLASSW cls={0};cls.lpfnWndProc=DefWindowProcW;cls.hInstance=GetModuleHandleW(NULL);cls.lpszClassName=L"ScrollControlParent";if(!RegisterClassW(&cls))return 1;
    HWND parent=CreateWindowExW(0,cls.lpszClassName,L"parent",WS_POPUP,10,20,240,160,NULL,NULL,cls.hInstance,NULL);
    puts("[");
    for(int style=0;style<2;style++){
        HWND w=CreateWindowExW(0,L"SCROLLBAR",L"",WS_CHILD|WS_VISIBLE|(style?SBS_VERT:SBS_HORZ),10,20,style?17:180,style?100:17,parent,NULL,cls.hInstance,NULL);if(!w)return 2;
        snapshot(w,style,"initial",0,777);
        SCROLLINFO in={28,SIF_ALL,10,40,8,50,999};SetLastError(777);int result=SetScrollInfo(w,SB_CTL,&in,FALSE);DWORD e=GetLastError();snapshot(w,style,"set-info",result,e);
        SetLastError(777);result=SetScrollPos(w,SB_CTL,31,FALSE);e=GetLastError();snapshot(w,style,"set-pos",result,e);
        SetLastError(777);result=SetScrollRange(w,SB_CTL,-20,60,FALSE);e=GetLastError();snapshot(w,style,"set-range",result,e);
        for(int size=20;size<=32;size+=4)for(unsigned mask=0;mask<33;mask++){
            in.cbSize=size;in.fMask=mask;in.nMin=10;in.nMax=40;in.nPage=8;in.nPos=50;SetLastError(777);result=SetScrollInfo(w,SB_CTL,&in,FALSE);e=GetLastError();char name[40];sprintf(name,"info-%d-%u",size,mask);snapshot(w,style,name,result,e);
        }
        for(unsigned flag=0;flag<5;flag++){
            SetLastError(777);result=EnableScrollBar(w,SB_CTL,flag);e=GetLastError();char name[30];sprintf(name,"enable-%u",flag);snapshot(w,style,name,result,e);
        }
        DestroyWindow(w);
    }
    DestroyWindow(parent);puts("]");return 0;
}
