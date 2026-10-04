#include <windows.h>
#include <commctrl.h>
static HINSTANCE instance;
static int applies, resets, initialized, releases;
static UINT CALLBACK page_callback(HWND w, UINT msg, LPPROPSHEETPAGEW p) {
 (void)w; (void)p;
 if (msg == PSPCB_RELEASE) ++releases;
 return 1;
}
static INT_PTR CALLBACK page_proc(HWND w, UINT msg, WPARAM wp, LPARAM lp) {
 if (msg == WM_INITDIALOG) {
  PROPSHEETPAGEW *p = (PROPSHEETPAGEW *)lp;
  if (p->lParam == 1) { SetWindowLongW(w, DWL_USER, 1); SetDlgItemTextW(w, 10, L"original"); }
  ++initialized; return TRUE;
 }
 if (msg == WM_COMMAND) {
  PropSheet_Changed(GetParent(w), w); return TRUE;
 }
 if (msg == WM_NOTIFY) {
  NMHDR *n = (NMHDR *)lp;
  int general = GetWindowLongW(w, DWL_USER) == 1;
  if (n->code == PSN_KILLACTIVE && general && IsDlgButtonChecked(w, 11)) {
   SetDlgItemTextW(w, 12, L"Native tab veto"); SetWindowLongW(w, DWL_MSGRESULT, TRUE); return TRUE;
  }
  if (n->code == PSN_APPLY) {
   if (!general && IsDlgButtonChecked(w, 20)) {
    SetDlgItemTextW(w, 22, L"Native Apply veto"); SetWindowLongW(w, DWL_MSGRESULT, PSNRET_INVALID); return TRUE;
   }
   ++applies; SetDlgItemTextW(w, general ? 12 : 22, L"Applied by native DLL");
   SetWindowLongW(w, DWL_MSGRESULT, PSNRET_NOERROR); return TRUE;
  }
  if (n->code == PSN_QUERYCANCEL && !general && IsDlgButtonChecked(w, 21)) {
   SetDlgItemTextW(w, 22, L"Native Cancel veto"); SetWindowLongW(w, DWL_MSGRESULT, TRUE); return TRUE;
  }
  if (n->code == PSN_RESET) ++resets;
 }
 (void)wp; return FALSE;
}
static int CALLBACK sheet_callback(HWND w, UINT msg, LPARAM lp) {
 if (msg == PSCB_PRECREATE) ((DLGTEMPLATE *)lp)->style &= ~DS_CONTEXTHELP;
 if (msg == PSCB_INITIALIZED) {
  if (!PropSheet_GetTabControl(w) || !PropSheet_GetCurrentPageHwnd(w)) ExitProcess(61);
 }
 return TRUE;
}
__declspec(dllexport) INT_PTR WINAPI OpenSettings(HWND owner, int modeless) {
 PROPSHEETPAGEW pages[2] = {0};
 PROPSHEETHEADERW header = {0};
 for (int i=0; i<2; ++i) {
  pages[i].dwSize = sizeof(pages[i]); pages[i].dwFlags = PSP_USETITLE | PSP_USECALLBACK;
  pages[i].hInstance = instance; pages[i].pszTemplate = MAKEINTRESOURCEW(101+i);
  pages[i].pszTitle = i ? L"Appearance \x03a9" : L"General";
  pages[i].pfnDlgProc = page_proc; pages[i].lParam = i ? 2 : 1; pages[i].pfnCallback = page_callback;
 }
 header.dwSize = sizeof(header); header.dwFlags = PSH_PROPSHEETPAGE | PSH_USECALLBACK | (modeless ? PSH_MODELESS : 0);
 header.hwndParent = owner; header.hInstance = instance; header.pszCaption = modeless ? L"Modeless native settings" : L"Modal native settings";
 header.nPages = 2; header.ppsp = pages; header.pfnCallback = sheet_callback;
 return PropertySheetW(&header);
}
__declspec(dllexport) int WINAPI VerifySettings(void) { return applies >= 4 && resets == 2 && initialized == 4 && releases == 4; }
BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID p) { if (reason == DLL_PROCESS_ATTACH) instance = h; (void)p; return TRUE; }
