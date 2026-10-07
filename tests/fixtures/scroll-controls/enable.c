/* Original WineBrowser contributors, MIT. EnableScrollBar validation/forwarding. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
int main(void){HWND w=CreateWindowExW(0,L"STATIC",L"",WS_POPUP,1,2,100,80,NULL,NULL,GetModuleHandleW(NULL),NULL);if(!w)return 1;puts("[");int first=1;
 for(int valid=0;valid<2;valid++)for(int bar=0;bar<5;bar++)for(unsigned flag=0;flag<5;flag++){
 SetLastError(777);BOOL result=EnableScrollBar(valid?w:(HWND)(UINT_PTR)0x1234,bar,flag);DWORD error=GetLastError();
 printf("%s{\"valid\":%d,\"bar\":%d,\"flag\":%u,\"result\":%d,\"error\":%lu}",first?"":",\n",valid,bar,flag,result,error);first=0;
 }puts("]");DestroyWindow(w);return 0;}
