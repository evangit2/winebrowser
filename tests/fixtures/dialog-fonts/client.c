#include <windows.h>
static int mode, failure, initialized, assigned;
static HFONT lastFont;
static void check(BOOL value, int code) { if (!value && !failure) failure = code; }
static BOOL CALLBACK dialogProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  (void)lp;
  if (msg == WM_SETFONT) { assigned++; return FALSE; }
  if (msg == WM_INITDIALOG) {
    LOGFONTW font;
    RECT mapped = {8,30,128,48}, actual, whole = {0,0,220,90}, client;
    POINT origin;
    HFONT handle = (HFONT)SendMessageW(hwnd,WM_GETFONT,0,0);
    lastFont = handle;
    initialized++;
    check(mode == 103 ? handle == NULL : handle != NULL,10);
    if (handle) {
      check(GetObjectW(handle,sizeof(font),&font) == sizeof(font),11);
      check(font.lfHeight == (mode == 101 ? -16 : -15),12);
      check(font.lfWeight == (mode == 101 ? 400 : 700),13);
      check(font.lfItalic == (mode == 102),14);
      check(font.lfCharSet == DEFAULT_CHARSET,15);
      check(lstrcmpW(font.lfFaceName,L"Arial") == 0,16);
      check(assigned == 1,17);
    }
    check((HFONT)SendDlgItemMessageW(hwnd,11,WM_GETFONT,0,0) == handle,18);
    check((HFONT)SendDlgItemMessageW(hwnd,10,WM_GETFONT,0,0) == handle,19);
    check(MapDialogRect(hwnd,&mapped),20);
    check(GetWindowRect(GetDlgItem(hwnd,11),&actual),21);
    origin.x = actual.left; origin.y = actual.top;
    check(ScreenToClient(hwnd,&origin),22);
    check(origin.x == mapped.left && origin.y == mapped.top,23);
    check(actual.right-actual.left == mapped.right-mapped.left,24);
    check(actual.bottom-actual.top == mapped.bottom-mapped.top,25);
    check(MapDialogRect(hwnd,&whole),26);
    check(GetClientRect(hwnd,&client),27);
    check(client.right == whole.right && client.bottom == whole.bottom,28);
    if (mode == 103) check(mapped.left == 16 && mapped.top == 60,29);
    return TRUE;
  }
  if (msg == WM_COMMAND && LOWORD(wp) == IDOK) { EndDialog(hwnd,failure); return TRUE; }
  if (msg == WM_CLOSE) { EndDialog(hwnd,failure); return TRUE; }
  return FALSE;
}
void start(void) {
  HINSTANCE instance = GetModuleHandleW(NULL);
  int id;
  for (id=101;id<=103;id++) {
    HWND hwnd;
    LOGFONTW font;
    mode=id; assigned=0;
    hwnd = id == 102 ? CreateDialogParamW(instance,MAKEINTRESOURCEW(id),NULL,dialogProc,0)
      : CreateDialogParamA(instance,MAKEINTRESOURCEA(id),NULL,dialogProc,0);
    check(hwnd != NULL,30);
    if (hwnd) DestroyWindow(hwnd);
    if (lastFont) check(GetObjectW(lastFont,sizeof(font),&font) == 0,31);
    if (failure) ExitProcess(failure);
  }
  check(initialized == 3,32);
  mode=102; assigned=0;
  check(DialogBoxParamW(instance,MAKEINTRESOURCEW(102),NULL,dialogProc,0) == 0,33);
  check(initialized == 4,34);
  ExitProcess(failure);
}
