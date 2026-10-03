/* Original MIT contract fixture. The window procedure lives in a companion DLL. */
#include "control.h"
static unsigned created, destroyed;
static LRESULT CALLBACK control_proc(HWND w, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg==WM_NCCREATE) {
    CREATESTRUCTA *cs=(CREATESTRUCTA*)lp;
    CHECK(!GetWindowLongA(w,0));
    CHECK(!SetWindowLongA(w,0,(LONG)cs->lpCreateParams));
    return TRUE;
  }
  CANVAS_CONTEXT *c=(CANVAS_CONTEXT*)GetWindowLongA(w,0);
  if (msg==WM_CREATE) { CHECK(c && GetParent(w)==c->root); created++; return 0; }
  if (msg==TEST_MESSAGE) return 0x12340000+wp;
  if (msg==WM_PAINT) {
    PAINTSTRUCT ps; HDC dc=BeginPaint(w,&ps); CHECK(dc);
    RECT r; CHECK(GetClientRect(w,&r));
    HBRUSH brush=CreateSolidBrush(c->color); CHECK(brush);
    CHECK(FillRect(dc,&r,brush)); CHECK(DeleteObject(brush));
    CHECK(EndPaint(w,&ps)); c->flags|=1; return 0;
  }
  if (msg==WM_LBUTTONDOWN) {
    CHECK((short)LOWORD(lp)==60 && (short)HIWORD(lp)==70);
    c->flags|=2; return 0;
  }
  if (msg==WM_LBUTTONUP) { CHECK(SetWindowTextA(c->root,c->flags&4?"Double click":"Child clicked")); return 0; }
  if (msg==WM_LBUTTONDBLCLK) { c->flags|=4; CHECK(SetWindowTextA(c->root,"Double click")); return 0; }
  if (msg==WM_MOUSEWHEEL) {
    CHECK((short)HIWORD(wp)==-120);
    POINT p={(short)LOWORD(lp),(short)HIWORD(lp)};
    CHECK(ScreenToClient(w,&p)); CHECK(p.x==60 && p.y==70);
    c->flags|=8; CHECK(SetWindowTextA(c->root,"Wheel received")); return 0;
  }
  if (msg==WM_CONTEXTMENU) {
    CHECK((HWND)wp==w);
    POINT p={(short)LOWORD(lp),(short)HIWORD(lp)};
    CHECK(ScreenToClient(w,&p)); CHECK(p.x==60 && p.y==70);
    c->flags|=16; CHECK(SetWindowTextA(c->root,"Context received")); return 0;
  }
  if (msg==WM_CHAR && wp=='a') { c->flags|=32; CHECK(SetWindowTextA(c->root,"Key received")); return 0; }
  if (msg==WM_COMMAND && LOWORD(wp)==90) {
    HWND sibling=GetDlgItem(c->root,71); CHECK(sibling);
    CHECK(MoveWindow(sibling,280,170,200,140,TRUE));
    CHECK(UpdateWindow(sibling));
    RECT r; CHECK(GetClientRect(sibling,&r) && r.right==198 && r.bottom==138);
    c->flags|=64; CHECK(SetWindowTextA(c->root,"Resized")); return 0;
  }
  if (msg==WM_NCDESTROY) { CHECK(c); destroyed++; CHECK(SetWindowLongA(w,0,0)==(LONG)c); }
  return DefWindowProcA(w,msg,wp,lp);
}
__declspec(dllexport) ATOM WINAPI RegisterCanvas(HINSTANCE instance) {
  WNDCLASSA cls={0}; cls.style=CS_DBLCLKS; cls.cbWndExtra=4;
  cls.lpfnWndProc=control_proc; cls.hInstance=instance; cls.lpszClassName=CONTROL_CLASS;
  return RegisterClassA(&cls);
}
__declspec(dllexport) unsigned WINAPI CanvasCounts(void) { return created*100+destroyed; }
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,LPVOID reserved) {
  (void)instance; (void)reason; (void)reserved; return TRUE;
}
