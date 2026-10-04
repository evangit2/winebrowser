/* Original MIT native toolbar DLL; copyright 2026 WineBrowser contributors. */
#include <windows.h>
#include <commctrl.h>
static HINSTANCE instance;
BOOL WINAPI DllMain(HINSTANCE value,DWORD reason,LPVOID reserved){(void)reserved;if(reason==DLL_PROCESS_ATTACH)instance=value;return TRUE;}
__declspec(dllexport) HWND WINAPI BuildToolbar(HWND owner){
  TBBUTTON buttons[6]={{STD_FILENEW,101,TBSTATE_ENABLED,BTNS_BUTTON,{0},0x12345678,-1},
    {STD_FILESAVE,102,0,BTNS_BUTTON,{0},0,-1},
    {15,103,TBSTATE_ENABLED,BTNS_CHECK,{0},103,-1},
    {16,104,TBSTATE_ENABLED,BTNS_CHECKGROUP,{0},104,-1},
    {17,105,TBSTATE_ENABLED,BTNS_CHECKGROUP,{0},105,-1},
    {8,0,TBSTATE_ENABLED,BTNS_SEP,{0},0,-1}};
  HWND toolbar=CreateToolbarEx(owner,WS_CHILD|WS_VISIBLE|TBSTYLE_FLAT|TBSTYLE_TOOLTIPS,50,15,HINST_COMMCTRL,IDB_STD_SMALL_COLOR,buttons,6,24,24,16,16,sizeof(TBBUTTON));
  if(!toolbar)return NULL;
  TBADDBITMAP bitmap={instance,201};if(SendMessageA(toolbar,TB_ADDBITMAP,3,(LPARAM)&bitmap)!=15)return NULL;
  TBBUTTON unicode={I_IMAGENONE,107,TBSTATE_ENABLED,BTNS_AUTOSIZE,{0},107,(INT_PTR)L"\x03a9\x20ac"};
  if(!SendMessageW(toolbar,TB_INSERTBUTTONW,6,(LPARAM)&unicode))return NULL;
  return toolbar;
}
