// Authored MIT fixture; geometry checked against native Wine.
#include <windows.h>
#include <commctrl.h>
static HWND edit,status,label;
static int typed,resized;
static LRESULT CALLBACK proc(HWND w,UINT m,WPARAM wp,LPARAM lp) {
 if(m==WM_COMMAND && LOWORD(wp)==20 && HIWORD(wp)==EN_CHANGE) {
  char text[64];GetWindowTextA(edit,text,sizeof(text));
  if(text[0]=='b' && text[1]=='r'){typed=1;SetWindowTextA(label,"Native editing verified");}
 }
 if(m==WM_SIZE && edit && status) {
  if(LOWORD(lp)>560)resized=1;
  MoveWindow(edit,10,50,LOWORD(lp)-20,HIWORD(lp)-90,TRUE);
  SendMessageA(status,WM_SIZE,wp,lp);return 0;
 }
 if(m==WM_DESTROY){PostQuitMessage(0);return 0;}
 return DefWindowProcA(w,m,wp,lp);
}
void start(void) {
 HINSTANCE i=GetModuleHandleA(0);WNDCLASSA c={0};c.lpfnWndProc=proc;c.hInstance=i;c.lpszClassName="ZeroControls";RegisterClassA(&c);
 HWND w=CreateWindowExA(0,c.lpszClassName,"Native zero-size controls",WS_OVERLAPPEDWINDOW|WS_VISIBLE,20,20,560,300,0,0,i,0);
 edit=CreateWindowExA(WS_EX_CLIENTEDGE|WS_EX_ACCEPTFILES,"EDIT","preserved while empty",WS_CHILD|ES_MULTILINE|ES_AUTOVSCROLL|WS_VSCROLL,10,50,0,0,w,(HMENU)20,i,0);
 if(!edit)ExitProcess(92);
 RECT outer,client;GetWindowRect(edit,&outer);GetClientRect(edit,&client);
 if(outer.right!=outer.left || outer.bottom!=outer.top || client.right || client.bottom)ExitProcess(93);
 if(!MoveWindow(edit,10,50,2,3,FALSE))ExitProcess(94);
 GetWindowRect(edit,&outer);GetClientRect(edit,&client);
 if(outer.right-outer.left!=2 || outer.bottom-outer.top!=3 || client.right!=2 || client.bottom!=3)ExitProcess(95);
 if(!MoveWindow(edit,10,50,320,80,FALSE))ExitProcess(96);
 GetClientRect(edit,&client);if(client.right!=316 || client.bottom!=76)ExitProcess(97);
 char text[64];if(GetWindowTextA(edit,text,sizeof(text))!=21 || text[0]!='p')ExitProcess(98);
 ShowWindow(edit,SW_SHOW);
 label=CreateWindowExA(0,"STATIC","Native tiny-control geometry verified",WS_CHILD|WS_VISIBLE,10,10,500,28,w,(HMENU)10,i,0);
 InitCommonControls();status=CreateWindowExA(WS_EX_DLGMODALFRAME,STATUSCLASSNAMEA,"Native status resize grip",WS_CHILD|WS_VISIBLE|SBARS_SIZEGRIP,0,0,0,0,w,(HMENU)30,i,0);
 if(!status)ExitProcess(99);
 MSG m;while(GetMessageA(&m,0,0,0)>0){TranslateMessage(&m);DispatchMessageA(&m);}
 ExitProcess(typed && resized ? 0 : 100);
}
