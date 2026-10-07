/* Original WineBrowser contributors, MIT. Native queued message position probe. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
static int first=1;
static void row(const char *step,int method,int removed,BOOL found,MSG *msg){
 SetLastError(777);DWORD result=GetMessagePos(),error=GetLastError();
 printf("%s{\"step\":\"%s\",\"method\":%d,\"remove\":%d,\"found\":%d,\"message\":%u,\"point\":[%ld,%ld],\"position\":%lu,\"error\":%lu}",first?"":",\n",step,method,removed,found,msg->message,msg->pt.x,msg->pt.y,result,error);first=0;
}
static DWORD WINAPI worker(void *unused){
 (void)unused;MSG msg={0};row("thread-initial",3,0,0,&msg);PeekMessageW(&msg,NULL,0,0,PM_NOREMOVE);
 SetCursorPos(410,440);PostThreadMessageW(GetCurrentThreadId(),WM_APP+7,0,0);SetCursorPos(450,480);
 BOOL found=GetMessageW(&msg,NULL,WM_APP+7,WM_APP+7);row("thread-get",3,1,found,&msg);return 0;
}
int main(void){POINT saved;GetCursorPos(&saved);WNDCLASSW c={0};c.lpfnWndProc=DefWindowProcW;c.hInstance=GetModuleHandleW(NULL);c.lpszClassName=L"MessagePositionProbe";if(!RegisterClassW(&c))return 1;
 HWND w=CreateWindowExW(0,c.lpszClassName,L"",WS_POPUP|WS_VISIBLE,20,60,200,160,NULL,NULL,c.hInstance,NULL);if(!w)return 2;
 MSG msg={0};PeekMessageW(&msg,NULL,0,0,PM_NOREMOVE);puts("[");
 for(int method=0;method<2;method++){
  SetCursorPos(80+method*10,110+method*10);if(method)PostThreadMessageW(GetCurrentThreadId(),WM_APP+7,0,MAKELPARAM(501,601));else PostMessageW(w,WM_APP+7,0,MAKELPARAM(501,601));
  SetCursorPos(140,170);BOOL found=PeekMessageW(&msg,NULL,WM_APP+7,WM_APP+7,PM_NOREMOVE);row("peek",method,0,found,&msg);
  SetCursorPos(180,210);found=PeekMessageW(&msg,NULL,WM_APP+7,WM_APP+7,PM_REMOVE);row("remove",method,1,found,&msg);
  SetCursorPos(220,250);found=PeekMessageW(&msg,NULL,WM_APP+7,WM_APP+7,PM_REMOVE);row("empty",method,1,found,&msg);
  SetCursorPos(100,130);if(method)PostThreadMessageW(GetCurrentThreadId(),WM_APP+7,0,MAKELPARAM(501,601));else PostMessageW(w,WM_APP+7,0,MAKELPARAM(501,601));
  SetCursorPos(200,230);found=GetMessageW(&msg,NULL,WM_APP+7,WM_APP+7);row("get",method,1,found,&msg);
 }
 SetCursorPos(300,330);InvalidateRect(w,NULL,TRUE);BOOL found=PeekMessageW(&msg,NULL,WM_PAINT,WM_PAINT,PM_NOREMOVE);row("paint-peek",2,0,found,&msg);
 SetCursorPos(340,370);found=PeekMessageW(&msg,NULL,WM_PAINT,WM_PAINT,PM_REMOVE);row("paint-remove",2,1,found,&msg);
 HANDLE thread=CreateThread(NULL,0,worker,NULL,0,NULL);if(!thread)return 3;WaitForSingleObject(thread,INFINITE);CloseHandle(thread);row("main-after-thread",4,1,1,&msg);
 SetCursorPos(saved.x,saved.y);DestroyWindow(w);puts("]");return 0;
}
