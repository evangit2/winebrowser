/* Original WineBrowser contributors, MIT. Native aligned scrollbar creation geometry. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
int main(void){WNDCLASSW c={0};c.lpfnWndProc=DefWindowProcW;c.hInstance=GetModuleHandleW(NULL);c.lpszClassName=L"ScrollAlignProbe";if(!RegisterClassW(&c))return 1;
 HWND parent=CreateWindowExW(0,c.lpszClassName,L"",WS_POPUP|WS_VISIBLE,10,20,400,400,NULL,NULL,c.hInstance,NULL);puts("[");int first=1;
 int lengths[]={33,180},thicknesses[]={8,25,40};
 for(int v=0;v<2;v++)for(int align=0;align<4;align++)for(int l=0;l<2;l++)for(int t=0;t<3;t++){
 int width=v?thicknesses[t]:lengths[l],height=v?lengths[l]:thicknesses[t];DWORD style=WS_CHILD|WS_VISIBLE|v|(align<<1);
 HWND w=CreateWindowExW(0,L"SCROLLBAR",L"",style,30,40,width,height,parent,NULL,c.hInstance,NULL);if(!w)return 2;
 RECT rect,client;GetWindowRect(w,&rect);GetClientRect(w,&client);POINT point={rect.left,rect.top};ScreenToClient(parent,&point);
 printf("%s{\"vertical\":%d,\"align\":%d,\"input\":[30,40,%d,%d],\"rect\":[%ld,%ld,%ld,%ld],\"client\":[%ld,%ld],\"style\":%lu}",first?"":",\n",v,align,width,height,point.x,point.y,rect.right-rect.left,rect.bottom-rect.top,client.right,client.bottom,(DWORD)GetWindowLongW(w,GWL_STYLE));first=0;DestroyWindow(w);
 }
 DestroyWindow(parent);puts("]");return 0;}
