// Authored MIT fixture for the runtime's actual zero-queue installation.
#include <windows.h>
#include <commdlg.h>
static int abort_calls,print_checked,page_checked;
static BOOL CALLBACK abort_proc(HDC dc,int error) { if (!dc || error) ExitProcess(87); abort_calls++; return TRUE; }
static LRESULT CALLBACK proc(HWND w,UINT m,WPARAM wp,LPARAM lp) {
 if (m==WM_COMMAND && LOWORD(wp)==100) {
  PRINTDLGA p={0};p.lStructSize=sizeof(p);p.hwndOwner=w;
  if (PrintDlgA(&p) || CommDlgExtendedError()!=0 || p.hDC || p.hDevMode || p.hDevNames) ExitProcess(88);
  print_checked=1;SetDlgItemTextA(w,10,"Native PrintDlg: no installed queues");return 0;
 }
 if (m==WM_COMMAND && LOWORD(wp)==101) {
  PAGESETUPDLGW p={0};p.lStructSize=sizeof(p);p.hwndOwner=w;
  if (PageSetupDlgW(&p) || CommDlgExtendedError()!=PDERR_NODEFAULTPRN || !(p.Flags & PSD_INTHOUSANDTHSOFINCHES)) ExitProcess(89);
  page_checked=1;SetDlgItemTextA(w,10,"Native PageSetup: no default printer");return 0;
 }
 if (m==WM_DESTROY) {PostQuitMessage(0);return 0;}
 return DefWindowProcA(w,m,wp,lp);
}
void start(void) {
 PRINTDLGW p={0};p.lStructSize=sizeof(p);p.Flags=PD_RETURNDEFAULT;
 if (PrintDlgW(&p) || CommDlgExtendedError()!=PDERR_NODEFAULTPRN) ExitProcess(80);
 p.hDevMode=(HGLOBAL)1;if (PrintDlgW(&p) || CommDlgExtendedError()!=PDERR_RETDEFFAILURE) ExitProcess(81);
 PAGESETUPDLGA page={0};page.lStructSize=sizeof(page);page.Flags=PSD_NOWARNING;
 if (PageSetupDlgA(&page) || CommDlgExtendedError()!=PDERR_NODEFAULTPRN) ExitProcess(82);
 if (StartPage((HDC)0xdead)!=SP_ERROR || SetAbortProc((HDC)0xdead,abort_proc)) ExitProcess(83);
 HDC dc=CreateCompatibleDC(0);DOCINFOA doc={0};doc.cbSize=sizeof(doc);doc.lpszDocName="No print job";
 if (!dc || !SetAbortProc(dc,abort_proc) || StartDocA(dc,&doc)!=0 || abort_calls!=1) ExitProcess(84);
 if (StartPage(dc)!=1 || EndPage(dc)!=0 || EndDoc(dc)!=0 || AbortDoc(dc)!=0) ExitProcess(85);
 DeleteDC(dc);
 HINSTANCE instance=GetModuleHandleA(0);WNDCLASSA c={0};c.lpfnWndProc=proc;c.hInstance=instance;c.lpszClassName="PrinterlessCheck";
 RegisterClassA(&c);HWND w=CreateWindowExA(0,c.lpszClassName,"Native printerless contracts",WS_OVERLAPPEDWINDOW|WS_VISIBLE,20,20,540,220,0,0,instance,0);
 CreateWindowExA(0,"STATIC","Native default-printer and GDI checks passed",WS_CHILD|WS_VISIBLE,10,10,500,28,w,(HMENU)10,instance,0);
 CreateWindowExA(0,"BUTTON","Print",WS_CHILD|WS_VISIBLE,10,60,120,30,w,(HMENU)100,instance,0);
 CreateWindowExA(0,"BUTTON","Page Setup",WS_CHILD|WS_VISIBLE,140,60,140,30,w,(HMENU)101,instance,0);
 MSG msg;while(GetMessageA(&msg,0,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}
 ExitProcess(print_checked && page_checked ? 0 : 86);
}
