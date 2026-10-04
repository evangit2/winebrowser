/* Original MIT native toolbar EXE; copyright 2026 WineBrowser contributors. */
#include <windows.h>
#include <commctrl.h>
#define CHECK(x) do{if(!(x))ExitProcess(__LINE__);}while(0)
static HWND toolbar,status;static unsigned clicks;
static void say(const char *value){SetWindowTextA(status,value);}
static LRESULT CALLBACK proc(HWND window,UINT msg,WPARAM wp,LPARAM lp){
  if(msg==WM_SIZE&&toolbar){SendMessageA(toolbar,TB_AUTOSIZE,0,0);return 0;}
  if(msg==WM_COMMAND){
    UINT id=LOWORD(wp);
    if((HWND)lp==toolbar){
      CHECK(HIWORD(wp)==0);clicks++;
      if(id==101)say("New: native toolbar command");
      if(id==102){CHECK(SendMessageA(toolbar,TB_ISBUTTONENABLED,102,0));say("Save: native toolbar command");}
      if(id==103){CHECK(SendMessageA(toolbar,TB_ISBUTTONCHECKED,103,0));say("Check: native toolbar state");}
      if(id==104){CHECK(SendMessageA(toolbar,TB_ISBUTTONCHECKED,104,0)&&!SendMessageA(toolbar,TB_ISBUTTONCHECKED,105,0));say("First group selected");}
      if(id==105){CHECK(SendMessageA(toolbar,TB_ISBUTTONCHECKED,105,0)&&!SendMessageA(toolbar,TB_ISBUTTONCHECKED,104,0));say("Second group selected");}
      if(id==107)say("Unicode: native toolbar command");
      return 0;
    }
    if(id==201){CHECK(SendMessageA(toolbar,TB_ENABLEBUTTON,102,MAKELONG(TRUE,0)));say("Save enabled");return 0;}
    if(id==202){
      TBBUTTONINFOA info={0};info.cbSize=sizeof(info);info.dwMask=TBIF_TEXT|TBIF_SIZE;info.pszText="Search";info.cx=80;
      CHECK(SendMessageA(toolbar,TB_SETBUTTONINFOA,101,(LPARAM)&info));
      char text[32]={0};info.dwMask=TBIF_TEXT|TBIF_COMMAND;info.pszText=text;info.cchText=sizeof(text);
      CHECK(SendMessageA(toolbar,TB_GETBUTTONINFOA,101,(LPARAM)&info)==0);CHECK(info.idCommand==101&&text[0]=='S'&&text[5]=='h'&&text[6]==0);
      say("Button label changed through native TBBUTTONINFO");return 0;
    }
    if(id==203){CHECK(SendMessageA(toolbar,TB_HIDEBUTTON,107,MAKELONG(TRUE,0)));CHECK(SendMessageA(toolbar,TB_DELETEBUTTON,1,0));say("Unicode hidden; Save deleted");return 0;}
  }
  if(msg==WM_DESTROY){CHECK(clicks>=6);PostQuitMessage(0);return 0;}
  return DefWindowProcA(window,msg,wp,lp);
}
void start(void){
  HINSTANCE instance=GetModuleHandleA(NULL);WNDCLASSA cls={0};cls.hInstance=instance;cls.lpfnWndProc=proc;cls.lpszClassName="NativeToolbarOwner";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);CHECK(RegisterClassA(&cls));
  RECT rect={0,0,400,180};CHECK(AdjustWindowRect(&rect,WS_OVERLAPPEDWINDOW,FALSE));
  HWND owner=CreateWindowA(cls.lpszClassName,"Native toolbar EXE and DLL",WS_OVERLAPPEDWINDOW|WS_VISIBLE,30,30,rect.right-rect.left,rect.bottom-rect.top,NULL,NULL,instance,NULL);CHECK(owner);
  HMODULE library=LoadLibraryA("toolbar-resources.dll");CHECK(library);
  union{FARPROC raw;HWND(WINAPI *fn)(HWND);} build;build.raw=GetProcAddress(library,"BuildToolbar");CHECK(build.raw);toolbar=build.fn(owner);CHECK(toolbar);CHECK(FreeLibrary(library));
  CHECK(SendMessageA(toolbar,TB_BUTTONCOUNT,0,0)==7);CHECK(SendMessageA(toolbar,TB_COMMANDTOINDEX,107,0)==6);
  TBBUTTON button;CHECK(SendMessageA(toolbar,TB_GETBUTTON,0,(LPARAM)&button));CHECK(button.idCommand==101&&button.dwData==0x12345678&&button.iBitmap==STD_FILENEW);
  WCHAR unicode[8]={0};CHECK(SendMessageW(toolbar,TB_GETBUTTONTEXTW,107,(LPARAM)unicode)==2);CHECK(unicode[0]==0x03a9&&unicode[1]==0x20ac);
  RECT item;CHECK(SendMessageA(toolbar,TB_GETITEMRECT,0,(LPARAM)&item));CHECK(item.right-item.left==24&&item.bottom-item.top==24);
  CHECK(SendMessageA(toolbar,TB_GETROWS,0,0)==1);
  status=CreateWindowA("STATIC","Native toolbar ready",WS_CHILD|WS_VISIBLE,8,46,380,24,owner,(HMENU)10,instance,NULL);CHECK(status);
  CHECK(CreateWindowA("BUTTON","Enable save",WS_CHILD|WS_VISIBLE,8,84,112,28,owner,(HMENU)201,instance,NULL));
  CHECK(CreateWindowA("BUTTON","Change label",WS_CHILD|WS_VISIBLE,132,84,112,28,owner,(HMENU)202,instance,NULL));
  CHECK(CreateWindowA("BUTTON","Hide/delete",WS_CHILD|WS_VISIBLE,256,84,112,28,owner,(HMENU)203,instance,NULL));
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}ExitProcess((UINT)msg.wParam);
}
