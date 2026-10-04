#include <windows.h>
#include <commctrl.h>
typedef INT_PTR (WINAPI *OPEN)(HWND,int);
typedef int (WINAPI *VERIFY)(void);
static OPEN open_settings;
static VERIFY verify;
static HWND modeless;
static int modal_ok;
static LRESULT CALLBACK proc(HWND w, UINT m, WPARAM wp, LPARAM lp) {
 if (m==WM_COMMAND && LOWORD(wp)==100) {
  modal_ok = open_settings(w, 0) == 1;
  SetDlgItemTextA(w, 10, modal_ok ? "Modal native success" : "Modal native failure"); return 0;
 }
 if (m==WM_COMMAND && LOWORD(wp)==101) {
  modeless = (HWND)open_settings(w, 1); if (!modeless || modeless == (HWND)-1) ExitProcess(62); return 0;
 }
 if (m==WM_DESTROY) { PostQuitMessage(0); return 0; }
 return DefWindowProcA(w,m,wp,lp);
}
void start(void) {
 HMODULE lib=LoadLibraryA("settings-pages.dll"); if (!lib) ExitProcess(60);
 open_settings=(OPEN)(void *)GetProcAddress(lib,"OpenSettings"); verify=(VERIFY)(void *)GetProcAddress(lib,"VerifySettings");
 if (!open_settings || !verify) ExitProcess(65);
 WNDCLASSA c={0}; c.lpfnWndProc=proc; c.hInstance=GetModuleHandleA(0); c.lpszClassName="SettingsOwner"; RegisterClassA(&c);
 HWND w=CreateWindowExA(0,c.lpszClassName,"Native property sheet EXE and DLL",WS_OVERLAPPEDWINDOW|WS_VISIBLE,20,20,560,230,0,0,c.hInstance,0);
 CreateWindowExA(0,"STATIC","Settings ready",WS_CHILD|WS_VISIBLE,10,10,500,28,w,(HMENU)10,c.hInstance,0);
 CreateWindowExA(0,"BUTTON","Modal settings",WS_CHILD|WS_VISIBLE|WS_TABSTOP,10,50,160,30,w,(HMENU)100,c.hInstance,0);
 CreateWindowExA(0,"BUTTON","Modeless settings",WS_CHILD|WS_VISIBLE|WS_TABSTOP,180,50,160,30,w,(HMENU)101,c.hInstance,0);
 MSG msg; while (GetMessageA(&msg,0,0,0)>0) {
  if (!modeless || !PropSheet_IsDialogMessage(modeless,&msg)) { TranslateMessage(&msg); DispatchMessageA(&msg); }
  if (modeless && !PropSheet_GetCurrentPageHwnd(modeless)) {
   if (PropSheet_GetResult(modeless)) ExitProcess(63);
   DestroyWindow(modeless); modeless=0;
   if (!modal_ok || !verify()) ExitProcess(64);
   SetDlgItemTextA(w, 10, "Settings callbacks verified");
  }
 }
 FreeLibrary(lib); ExitProcess(0);
}
