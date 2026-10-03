/* MIT license: see README.md. Native Win32 menu contract fixture. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(__LINE__); } while (0)
static HMENU context;
static unsigned round_no;
static LRESULT CALLBACK proc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
  if (message == WM_RBUTTONUP) {
    POINT point; CHECK(GetCursorPos(&point));
    if (round_no == 0) {
      UINT selected = TrackPopupMenu(context, TPM_RETURNCMD | TPM_RIGHTBUTTON, point.x, point.y, 0, window, NULL);
      CHECK(selected == 8); CHECK(SetWindowTextW(window, L"Returned 8"));
    } else if (round_no == 1) {
      CHECK(TrackPopupMenuEx(context, TPM_RETURNCMD, point.x, point.y, window, NULL) == 0);
      CHECK(SetWindowTextA(window, "Cancelled"));
    } else CHECK(TrackPopupMenuEx(context, 0, point.x, point.y, window, NULL));
    round_no++; return 0;
  }
  if (message == WM_COMMAND && LOWORD(wp) == 7) {
    CHECK(SetWindowTextA(window, "WM_COMMAND 7")); return 0;
  }
  if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcA(window, message, wp, lp);
}
void start(void) {
  HINSTANCE instance=GetModuleHandleA(NULL);
  WNDCLASSA cls={0}; cls.hInstance=instance;cls.lpfnWndProc=proc;cls.lpszClassName="NativeMenus";cls.hbrBackground=(HBRUSH)(COLOR_WINDOW+1);
  CHECK(RegisterClassA(&cls));
  context=CreatePopupMenu();CHECK(context);
  CHECK(AppendMenuA(context,MF_GRAYED,42,"Disabled"));
  CHECK(AppendMenuW(context,MF_STRING,7,L"&Run"));
  CHECK(AppendMenuW(context,MF_CHECKED,8,L"&Checked"));
  HMENU bar=CreateMenu();CHECK(bar);CHECK(AppendMenuA(bar,MF_POPUP,(UINT_PTR)context,"&Actions"));
  CHECK(GetSubMenu(bar,0)==context);CHECK(GetSubMenu(bar,1)==NULL);
  CHECK(GetMenuItemID(bar,0)==(UINT)-1);CHECK(GetMenuItemID(context,1)==7);
  RECT rect={0,0,240,140};CHECK(AdjustWindowRect(&rect,WS_OVERLAPPEDWINDOW,TRUE));
  HWND window=CreateWindowA(cls.lpszClassName,"Native menus",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,rect.right-rect.left,rect.bottom-rect.top,NULL,bar,instance,NULL);CHECK(window);
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}
  CHECK(DestroyMenu(bar));ExitProcess((UINT)msg.wParam);
}
