/* Original WineBrowser contributors, MIT. Native window DPI and validity probe. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
int main(void){
 WNDCLASSW c={0};c.lpfnWndProc=DefWindowProcW;c.hInstance=GetModuleHandleW(NULL);c.lpszClassName=L"WindowDpiProbe";if(!RegisterClassW(&c))return 1;
 HWND p=CreateWindowExW(0,c.lpszClassName,L"",WS_POPUP,10,20,300,200,NULL,NULL,c.hInstance,NULL);
 HWND child=CreateWindowExW(0,L"BUTTON",L"",WS_CHILD|WS_VISIBLE,20,20,120,30,p,NULL,c.hInstance,NULL);
 HWND handles[]={NULL,(HWND)0x1234,(HWND)-1,p,child,GetDesktopWindow(),GetShellWindow(),child};
 for(unsigned i=0;i<sizeof(handles)/sizeof(handles[0]);i++){
 if(i==7)DestroyWindow(child);SetLastError(777);UINT dpi=GetDpiForWindow(handles[i]);DWORD error=GetLastError();printf("%u %u %lu\n",i,dpi,error);
 }
 DestroyWindow(p);return 0;
}
