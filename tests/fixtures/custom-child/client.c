/* Original MIT fixture: unchanged PE32 EXE + DLL, compiled to Wasm by the browser. */
#include "control.h"
__declspec(dllimport) ATOM WINAPI RegisterCanvas(HINSTANCE instance);
__declspec(dllimport) unsigned WINAPI CanvasCounts(void);
static CANVAS_CONTEXT contexts[2];
static HWND first, second;
static WNDPROC previous;
static unsigned subclassed, visibility;
static LRESULT CALLBACK subclass(HWND w,UINT msg,WPARAM wp,LPARAM lp) {
  if (msg==TEST_MESSAGE) return CallWindowProcA(previous,w,msg,wp,lp)+1;
  if (msg==WM_LBUTTONDOWN) subclassed++;
  return CallWindowProcA(previous,w,msg,wp,lp);
}
static LRESULT CALLBACK root_proc(HWND w,UINT msg,WPARAM wp,LPARAM lp) {
  if (msg==WM_COMMAND) {
    if (LOWORD(wp)==80) {
      BOOL visible=IsWindowVisible(second); ShowWindow(second,visible?SW_HIDE:SW_SHOW);
      CHECK(IsWindowVisible(second)!=visible); visibility|=visible?1:2;
      CHECK(SetWindowTextA(w,visible?"Hidden":"Shown")); return 0;
    }
    if (LOWORD(wp)==81) {
      BOOL enabled=IsWindowEnabled(second); EnableWindow(second,!enabled);
      CHECK(IsWindowEnabled(second)!=enabled); visibility|=enabled?4:8;
      CHECK(SetWindowTextA(w,enabled?"Disabled":"Enabled")); return 0;
    }
  }
  if (msg==WM_CLOSE) {
    CHECK((contexts[0].flags&127)==127 && subclassed>=2 && visibility==15);
    CHECK(contexts[1].flags&1);
    CHECK((WNDPROC)GetWindowLongA(first,GWL_WNDPROC)==subclass);
    CHECK((WNDPROC)SetWindowLongA(first,GWL_WNDPROC,(LONG)previous)==subclass);
    CHECK(SendMessageA(first,TEST_MESSAGE,7,0)==0x12340007);
  }
  if (msg==WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcA(w,msg,wp,lp);
}
void start(void) {
  HINSTANCE instance=GetModuleHandleA(NULL); CHECK(RegisterCanvas(instance));
  WNDCLASSA cls={0}; cls.lpfnWndProc=root_proc; cls.hInstance=instance;
  cls.lpszClassName="NativeCanvasRoot"; cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);
  CHECK(RegisterClassA(&cls)); RECT r={0,0,520,360};
  CHECK(AdjustWindowRect(&r,WS_OVERLAPPEDWINDOW,FALSE));
  HWND root=CreateWindowA(cls.lpszClassName,"Custom child ready",WS_OVERLAPPEDWINDOW|WS_VISIBLE,
    40,40,r.right-r.left,r.bottom-r.top,NULL,NULL,instance,NULL); CHECK(root);
  contexts[0].root=contexts[1].root=root; contexts[0].color=RGB(24,100,200); contexts[1].color=RGB(200,80,24);
  first=CreateWindowExA(WS_EX_CLIENTEDGE,CONTROL_CLASS,"DLL canvas",WS_CHILD|WS_VISIBLE|WS_TABSTOP,
    20,20,220,160,root,(HMENU)70,instance,&contexts[0]); CHECK(first);
  second=CreateWindowA(CONTROL_CLASS,"Second DLL canvas",WS_CHILD|WS_VISIBLE|WS_BORDER,
    280,20,180,120,root,(HMENU)71,instance,&contexts[1]); CHECK(second);
  CHECK(CanvasCounts()==200); CHECK(UpdateWindow(first) && UpdateWindow(second));
  HDC dc=GetDC(first); CHECK(dc); CHECK(GetPixel(dc,60,70)==contexts[0].color); CHECK(ReleaseDC(first,dc));
  dc=GetDC(second); CHECK(dc); CHECK(GetPixel(dc,60,70)==contexts[1].color); CHECK(ReleaseDC(second,dc));
  previous=(WNDPROC)GetWindowLongA(first,GWL_WNDPROC); CHECK(previous);
  CHECK((WNDPROC)SetWindowLongA(first,GWL_WNDPROC,(LONG)subclass)==previous);
  CHECK(SendMessageA(first,TEST_MESSAGE,7,0)==0x12340008);
  CHECK(SendMessageA(second,TEST_MESSAGE,7,0)==0x12340007);
  CHECK(CreateWindowA("BUTTON","Move and resize",WS_CHILD|WS_VISIBLE|WS_TABSTOP,
    10,10,150,26,first,(HMENU)90,instance,NULL));
  CHECK(CreateWindowA("BUTTON","Hide or show",WS_CHILD|WS_VISIBLE|WS_TABSTOP,
    20,280,150,26,root,(HMENU)80,instance,NULL));
  CHECK(CreateWindowA("BUTTON","Disable or enable",WS_CHILD|WS_VISIBLE|WS_TABSTOP,
    200,280,150,26,root,(HMENU)81,instance,NULL));
  MSG msg; while(GetMessageA(&msg,NULL,0,0)>0) { TranslateMessage(&msg); DispatchMessageA(&msg); }
  CHECK(CanvasCounts()==202 && !IsWindow(first) && !IsWindow(second));
  CHECK(!GetDC(first) && GetLastError()==ERROR_INVALID_WINDOW_HANDLE);
  ExitProcess((UINT)msg.wParam);
}
