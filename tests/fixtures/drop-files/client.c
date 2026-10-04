// Authored MIT fixture. Browser file drops exercise unchanged PE32 imports.
#include <windows.h>
#include <shellapi.h>
static HWND owner;
static int batches;
static int accepting = 1;
static void fail(UINT code) { ExitProcess(code); }
static void read_file(LPCWSTR path, int unicode) {
 HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, 0, OPEN_EXISTING, 0, 0);
 if (file == INVALID_HANDLE_VALUE) fail(74);
 BYTE body[64]; DWORD done;
 if (!ReadFile(file,body,sizeof(body),&done,0)) fail(75);
 CloseHandle(file);
 if (unicode) {
  if (done != 14 || body[0]!=0xff || body[1]!=0xfe || !IsTextUnicode(body,(int)done,0)) fail(76);
 } else {
  if (done != 5 || body[0]!='h' || body[4]!='o' || IsTextUnicode(body,(int)done,0)) fail(77);
 }
}
static LRESULT CALLBACK proc(HWND w,UINT m,WPARAM wp,LPARAM lp) {
 if (m==WM_COMMAND && LOWORD(wp)==100) {
  accepting=!accepting; DragAcceptFiles(w,accepting);
  SetDlgItemTextA(w,100,accepting ? "Disable file drops" : "Enable file drops"); return 0;
 }
 if (m==WM_DROPFILES) {
  HDROP drop=(HDROP)wp;
  if (!accepting || DragQueryFileW(drop,0xffffffff,0,0)!=2 || DragQueryFileA(drop,0xffffffff,0,0)!=2) fail(70);
  POINT point; if (!DragQueryPoint(drop,&point) || point.x!=24 || point.y!=76) fail(71);
  for (UINT i=0;i<2;i++) {
   WCHAR path[512]; char ansi[512];
   UINT n=DragQueryFileW(drop,i,0,0);
   if (!n || DragQueryFileW(drop,i,path,512)!=n) fail(72);
   if (!DragQueryFileA(drop,i,ansi,512)) fail(73);
   WCHAR short_path[5]={0,0,0,0,0x4321};
   if (DragQueryFileW(drop,i,short_path,4)!=3 || short_path[3] || short_path[4]!=0x4321) fail(78);
   read_file(path,i==1);
  }
  DragFinish(drop);
  if (GlobalFlags(drop)!=GMEM_INVALID_HANDLE) fail(79);
  batches++;
  SetDlgItemTextW(w,10,batches==1 ? L"Native read: hello and Unicode café Ω" : L"Second native file drop verified");
  return 0;
 }
 if (m==WM_DESTROY) { PostQuitMessage(0); return 0; }
 return DefWindowProcW(w,m,wp,lp);
}
void start(void) {
 HINSTANCE instance=GetModuleHandleW(0);
 WNDCLASSW c={0};c.lpfnWndProc=proc;c.hInstance=instance;c.lpszClassName=L"NativeDropFiles";
 if (!RegisterClassW(&c)) fail(65);
 owner=CreateWindowExW(WS_EX_ACCEPTFILES,c.lpszClassName,L"Native dropped file editor",WS_OVERLAPPEDWINDOW|WS_VISIBLE,20,20,560,240,0,0,instance,0);
 if (!owner) fail(66);
 CreateWindowExW(0,L"STATIC",L"Drop text files here",WS_CHILD|WS_VISIBLE,10,10,500,28,owner,(HMENU)10,instance,0);
 CreateWindowExW(0,L"BUTTON",L"Disable file drops",WS_CHILD|WS_VISIBLE|WS_TABSTOP,10,110,180,30,owner,(HMENU)100,instance,0);
 MSG msg;while(GetMessageW(&msg,0,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}
 ExitProcess(batches==2 ? 0 : 67);
}
