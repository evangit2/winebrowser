/* Original MIT native common-dialog hook and resource library. */
#include <windows.h>
#include <commdlg.h>
static LPARAM expected;
static unsigned initialized,veto;
__declspec(dllexport) void WINAPI Expect(LPARAM pointer){expected=pointer;veto=0;}
__declspec(dllexport) unsigned WINAPI Initializations(void){return initialized;}
__declspec(dllexport) UINT_PTR CALLBACK FindHook(HWND window,UINT message,WPARAM wp,LPARAM lp){
  if(message==WM_INITDIALOG){if(lp!=expected||!GetDlgItem(window,1152))ExitProcess(201);initialized++;return TRUE;}
  if(message==WM_COMMAND&&LOWORD(wp)==IDOK&&initialized==1&&!veto){veto=1;SetWindowTextA(GetDlgItem(GetWindow(window,GW_OWNER),10),"Hook A: Find Next vetoed");return TRUE;}
  return FALSE;
}
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,void *reserved){(void)instance;(void)reason;(void)reserved;return TRUE;}
