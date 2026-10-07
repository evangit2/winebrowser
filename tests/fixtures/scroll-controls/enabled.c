/* Original WineBrowser contributors, MIT. Scrollbar enabled-state transitions. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
static int first=1;
static void capture(HWND w,int visible,int disabled,int action,int redraw,int result,DWORD error){
 SCROLLBARINFO b={0};b.cbSize=60;GetScrollBarInfo(w,OBJID_CLIENT,&b);SCROLLINFO s={28,SIF_ALL,0,0,0,0,0};GetScrollInfo(w,SB_CTL,&s);
 printf("%s{\"visible\":%d,\"initialDisabled\":%d,\"action\":%d,\"redraw\":%d,\"result\":%d,\"error\":%lu,\"enabled\":%d,\"style\":%lu,\"state\":[%d,%d,%u,%d],\"arrows\":[%lu,%lu]}",first?"":",\n",visible,disabled,action,redraw,result,error,IsWindowEnabled(w),(DWORD)GetWindowLongW(w,GWL_STYLE),s.nMin,s.nMax,s.nPage,s.nPos,b.rgstate[1],b.rgstate[5]);first=0;
}
int main(void){WNDCLASSW cls={0};cls.lpfnWndProc=DefWindowProcW;cls.hInstance=GetModuleHandleW(NULL);cls.lpszClassName=L"ScrollEnabledProbe";if(!RegisterClassW(&cls))return 1;
 HWND parent=CreateWindowExW(0,cls.lpszClassName,L"",WS_POPUP|WS_VISIBLE,10,20,300,300,NULL,NULL,cls.hInstance,NULL);puts("[");
 for(int visible=0;visible<2;visible++)for(int disabled=0;disabled<2;disabled++)for(int redraw=0;redraw<2;redraw++)for(int action=0;action<15;action++){
 HWND w=CreateWindowExW(0,L"SCROLLBAR",L"",WS_CHILD|(visible?WS_VISIBLE:0)|(disabled?WS_DISABLED:0),30,40,180,17,parent,NULL,cls.hInstance,NULL);if(!w)return 2;
 SCROLLINFO s={28,SIF_ALL,10,40,8,20,0};SetLastError(777);int result=0;
 if(action<5)result=EnableScrollBar(w,SB_CTL,action);
 else if(action<7)result=EnableWindow(w,action-5);
 else if(action<9)result=SendMessageW(w,WM_ENABLE,action-7,0);
 else {if(action==10)s.fMask|=SIF_DISABLENOSCROLL;if(action>=10)s.nPage=100;if(action==12)s.fMask=SIF_POS;if(action==13)s.fMask=SIF_DISABLENOSCROLL;if(action==14)s.fMask=SIF_PAGE;result=SetScrollInfo(w,SB_CTL,&s,redraw);}
 DWORD error=GetLastError();capture(w,visible,disabled,action,redraw,result,error);DestroyWindow(w);
 }
 DestroyWindow(parent);puts("]");return 0;}
