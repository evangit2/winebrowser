/* Project-authored MIT fixture: native complex clipping and text isolation. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(1000+__LINE__); } while(0)
static LRESULT CALLBACK proc(HWND w, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg==WM_PAINT) {
    PAINTSTRUCT ps; HDC dc=BeginPaint(w,&ps); CHECK(dc);
    RECT all={0,0,320,160}, box;
    CHECK(FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH)));
    int saved=SaveDC(dc); CHECK(saved);
    CHECK(IntersectClipRect(dc,20,20,300,140)==SIMPLEREGION);
    CHECK(ExcludeClipRect(dc,120,60,200,100)==COMPLEXREGION);
    CHECK(GetClipBox(dc,&box)==COMPLEXREGION);
    CHECK(box.left==20 && box.top==20 && box.right==300 && box.bottom==140);
    HBRUSH brush=CreateSolidBrush(RGB(24,100,200)); CHECK(brush);
    CHECK(FillRect(dc,&all,brush)); CHECK(DeleteObject(brush));
    CHECK(SetPixel(dc,140,80,RGB(255,0,0))==CLR_INVALID);
    CHECK(GetPixel(dc,140,80)==CLR_INVALID);
    CHECK(SetBkMode(dc,TRANSPARENT)); CHECK(SetTextColor(dc,RGB(255,255,255))!=CLR_INVALID);
    RECT text={40,30,80,48}; CHECK(ExtTextOutA(dc,40,30,ETO_CLIPPED,&text,"Clipped native text",19,NULL));
    CHECK(RestoreDC(dc,saved)); CHECK(GetClipBox(dc,&box)==SIMPLEREGION);
    CHECK(GetPixel(dc,140,80)==RGB(255,255,255));
    CHECK(GetPixel(dc,30,80)==RGB(24,100,200));
    CHECK(GetPixel(dc,10,80)==RGB(255,255,255));
    CHECK(EndPaint(w,&ps)); SetWindowTextA(w,"Native clipping passed"); return 0;
  }
  if (msg==WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcA(w,msg,wp,lp);
}
void start(void) {
  HINSTANCE instance=GetModuleHandleA(NULL); WNDCLASSA cls={0};
  cls.hInstance=instance; cls.lpfnWndProc=proc; cls.lpszClassName="NativeClip";
  CHECK(RegisterClassA(&cls));
  HWND w=CreateWindowA(cls.lpszClassName,"Native clipping",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,336,199,NULL,NULL,instance,NULL); CHECK(w);
  CHECK(UpdateWindow(w)); MSG msg;
  while(GetMessageA(&msg,NULL,0,0)>0) { TranslateMessage(&msg); DispatchMessageA(&msg); }
  ExitProcess((UINT)msg.wParam);
}
