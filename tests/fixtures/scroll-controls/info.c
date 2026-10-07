/* Original WineBrowser contributors, MIT. Native scrollbar information probe. */
#define UNICODE
#include <windows.h>
#include <stdio.h>
static int first=1;
static void capture(HWND w,int vertical,int visible,int stage,int size,LONG object){
 SCROLLBARINFO b;memset(&b,0x55,sizeof(b));b.cbSize=size;SetLastError(777);
 int returned=GetScrollBarInfo(w,object,&b);DWORD error=GetLastError();
 DWORD flags=GetWindowLongW(w,GWL_STYLE);int enabled=IsWindowEnabled(w);
 printf("%s{\"vertical\":%d,\"visible\":%d,\"stage\":%d,\"size\":%d,\"object\":%ld,\"result\":%d,\"error\":%lu,\"flags\":%lu,\"enabled\":%d,\"out\":[",first?"":",\n",vertical,visible,stage,size,object,returned,error,flags,enabled);first=0;
 for(unsigned i=0;i<sizeof(b)/4;i++)printf("%s%ld",i?",":"",((LONG*)&b)[i]);puts("]}");
}
int main(void){WNDCLASSW c={0};c.lpfnWndProc=DefWindowProcW;c.hInstance=GetModuleHandleW(NULL);c.lpszClassName=L"ScrollInfoProbe";if(!RegisterClassW(&c))return 1;
 HWND parent=CreateWindowExW(0,c.lpszClassName,L"",WS_POPUP|WS_VISIBLE,10,20,300,300,NULL,NULL,c.hInstance,NULL);puts("[");
 for(int v=0;v<2;v++)for(int visible=0;visible<2;visible++){
 HWND w=CreateWindowExW(0,L"SCROLLBAR",L"",WS_CHILD|(visible?WS_VISIBLE:0)|v,30,40,v?17:180,v?180:17,parent,NULL,c.hInstance,NULL);
 SCROLLINFO s={28,SIF_ALL,10,40,8,20,0};SetScrollInfo(w,SB_CTL,&s,FALSE);
 int sizes[]={0,4,56,59,60,64};LONG objects[]={OBJID_CLIENT,OBJID_HSCROLL,OBJID_VSCROLL,OBJID_WINDOW,1};
 for(int st=0;st<6;st++){
 EnableScrollBar(w,SB_CTL,st<4?st:0);EnableWindow(w,st!=4);
 if(st==5){s.nPage=100;SetScrollInfo(w,SB_CTL,&s,FALSE);}
 for(int z=0;z<6;z++)for(int o=0;o<5;o++)capture(w,v,visible,st,sizes[z],objects[o]);
 }
 DestroyWindow(w);
 }
 DestroyWindow(parent);puts("]");return 0;}
