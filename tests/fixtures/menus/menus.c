/* MIT license: see README.md. Native Win32 menu contract fixture. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(__LINE__); } while (0)
static HMENU context;
static unsigned round_no;
static HWND owner_draw;
static HBRUSH dialog_brush;
static INT_PTR CALLBACK dialog_proc(HWND window,UINT message,WPARAM wp,LPARAM lp) {
  (void)wp;
  if(message==WM_INITDIALOG){SetWindowLongA(window,DLGWINDOWEXTRA,lp);return TRUE;}
  if(message==WM_CTLCOLORDLG && dialog_brush) return (INT_PTR)dialog_brush;
  if(message==WM_USER){SetWindowLongA(window,DWLP_MSGRESULT,GetWindowLongA(window,DLGWINDOWEXTRA));return TRUE;}
  return FALSE;
}
static void custom_dialog(HINSTANCE instance) {
  WNDCLASSA klass={0};klass.hInstance=instance;klass.lpfnWndProc=DefDlgProcA;
  klass.hbrBackground=(HBRUSH)(COLOR_BACKGROUND+1);
  klass.cbWndExtra=DLGWINDOWEXTRA+sizeof(LONG_PTR);klass.lpszClassName="NativeDialog";CHECK(RegisterClassA(&klass));
  unsigned char bytes[128]={0};DLGTEMPLATE *tpl=(DLGTEMPLATE*)bytes;
  tpl->style=WS_POPUP|WS_CAPTION|DS_MODALFRAME;tpl->cx=80;tpl->cy=40;
  WORD *at=(WORD*)(bytes+18);*at++=0;
  const WCHAR *name=L"NativeDialog";do{*at++=*name;}while(*name++);*at++=0;
  HWND dialog=CreateDialogIndirectParamA(instance,tpl,NULL,dialog_proc,0x12345678);CHECK(dialog);
  CHECK(GetClassLongA(dialog,GCL_CBWNDEXTRA)==DLGWINDOWEXTRA+sizeof(LONG_PTR));
  CHECK(GetWindowLongA(dialog,DLGWINDOWEXTRA)==0x12345678);
  CHECK(SendMessageA(dialog,WM_USER,0,0)==0x12345678);
  HDC dc=GetDC(dialog);CHECK(dc);
  CHECK(SendMessageA(dialog,WM_ERASEBKGND,(WPARAM)dc,0));
  CHECK(GetPixel(dc,10,10)==GetSysColor(COLOR_BTNFACE));
  dialog_brush=CreateSolidBrush(RGB(71,82,93));CHECK(dialog_brush);
  CHECK(SendMessageA(dialog,WM_ERASEBKGND,(WPARAM)dc,0));
  CHECK(GetPixel(dc,10,10)==RGB(71,82,93));
  CHECK(ReleaseDC(dialog,dc));CHECK(DeleteObject(dialog_brush));dialog_brush=NULL;
  CHECK(DestroyWindow(dialog));
}
static LRESULT CALLBACK proc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
  if(message==WM_DRAWITEM) {
    DRAWITEMSTRUCT *item=(DRAWITEMSTRUCT*)lp;
    CHECK(item->CtlType==ODT_STATIC&&item->CtlID==60&&wp==60&&item->hwndItem==owner_draw);
    CHECK(item->itemAction==ODA_DRAWENTIRE&&item->rcItem.left==0&&item->rcItem.top==0);
    HBRUSH brush=CreateSolidBrush(item->itemState&ODS_DISABLED?RGB(90,80,70):RGB(17,34,51));CHECK(brush);
    CHECK(FillRect(item->hDC,&item->rcItem,brush));CHECK(DeleteObject(brush));
    CHECK(SetPixel(item->hDC,2,3,RGB(171,205,239))!=CLR_INVALID);return TRUE;
  }
  if(message==WM_COMMAND&&LOWORD(wp)==61) {
    CHECK(SetWindowTextA(owner_draw,"Resized native child"));
    CHECK(MoveWindow(owner_draw,120,40,100,50,TRUE));
    EnableWindow(owner_draw,FALSE);CHECK(UpdateWindow(owner_draw));return 0;
  }
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
  char username[64];DWORD characters=0;
  CHECK(!GetUserNameA(NULL,&characters));CHECK(GetLastError()==ERROR_INSUFFICIENT_BUFFER);
  CHECK(characters<=sizeof(username));CHECK(GetUserNameA(username,&characters));CHECK(characters>1);
  HINSTANCE instance=GetModuleHandleA(NULL);
  custom_dialog(instance);
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
  HWND edit=CreateWindowExA(WS_EX_STATICEDGE,"EDIT","Read only",WS_CHILD|WS_VISIBLE|ES_READONLY,120,10,110,24,window,(HMENU)50,instance,NULL);CHECK(edit);
  RECT client;CHECK(GetClientRect(edit,&client));CHECK(client.right==108&&client.bottom==22);
  owner_draw=CreateWindowA("STATIC","Native painted",WS_CHILD|WS_VISIBLE|SS_OWNERDRAW,120,40,110,55,window,(HMENU)60,instance,NULL);CHECK(owner_draw);
  CHECK(CreateWindowA("BUTTON","Repaint child",WS_CHILD|WS_VISIBLE,120,100,110,24,window,(HMENU)61,instance,NULL));
  CHECK(UpdateWindow(owner_draw));
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}
  CHECK(DestroyMenu(bar));ExitProcess((UINT)msg.wParam);
}
