/* MIT. Original Windows SDK client: clipboard storage and native edit messages. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
static HWND owner,ansi,unicode,activeEdit;
static unsigned checks,rendered,destroyed;
#define CHECK(x) do{checks++;if(!(x)){ExitProcess(100+checks);}}while(0)
static HGLOBAL block(const void *bytes,SIZE_T size) {
  HGLOBAL h=GlobalAlloc(GMEM_MOVEABLE|GMEM_ZEROINIT,size);CHECK(h!=NULL);
  BYTE *p=GlobalLock(h);CHECK(p!=NULL);for(SIZE_T i=0;i<size;i++)p[i]=((const BYTE*)bytes)[i];GlobalUnlock(h);return h;
}
static void expect(UINT format,const void *bytes,SIZE_T size) {
  HGLOBAL h=GetClipboardData(format);CHECK(h!=NULL);BYTE *p=GlobalLock(h);CHECK(p!=NULL);
  CHECK(GlobalSize(h)>=size);for(SIZE_T i=0;i<size;i++)CHECK(p[i]==((const BYTE*)bytes)[i]);GlobalUnlock(h);
}
static LRESULT CALLBACK proc(HWND h,UINT m,WPARAM w,LPARAM l) {
  if(m==WM_RENDERFORMAT) { static const char value[]="delayed";rendered++;SetClipboardData((UINT)w,block(value,sizeof(value)));return 0; }
  if(m==WM_DESTROYCLIPBOARD){destroyed++;return 0;}
  if(m==WM_COMMAND) {
    unsigned id=LOWORD(w);if((id==1||id==2)&&HIWORD(w)==EN_SETFOCUS)activeEdit=(HWND)l;
    HWND edit=activeEdit?activeEdit:ansi;
    if(id>=10&&id<=13)SendMessageW(edit,id==10?WM_COPY:id==11?WM_PASTE:id==12?WM_CUT:WM_UNDO,0,0);
    if(id==14){SetFocus(unicode);SendMessageW(unicode,WM_PASTE,0,0);}
    return 0;
  }
  if(m==WM_CLOSE){DestroyWindow(h);return 0;}
  if(m==WM_DESTROY){PostQuitMessage(0);return 0;}
  return DefWindowProcW(h,m,w,l);
}
void _start(void) {
  WNDCLASSW c={0};c.lpfnWndProc=proc;c.hInstance=GetModuleHandleW(NULL);c.lpszClassName=L"ClipboardClient";c.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);
  WCHAR lower[]={65,0};CHECK(CharLowerW(lower)==lower);CHECK(lower[0]==97);
  CHECK(RegisterClassW(&c));owner=CreateWindowW(c.lpszClassName,L"Native clipboard editor",WS_OVERLAPPEDWINDOW,40,40,650,370,NULL,NULL,c.hInstance,NULL);CHECK(owner);
  SetLastError(0x1234);CHECK(!GetClipboardData(CF_TEXT));CHECK(GetLastError()==1418);
  CHECK(OpenClipboard(owner));CHECK(OpenClipboard(owner));CHECK(EmptyClipboard());CHECK(GetClipboardOwner()==owner);
  static const char narrow[]={99,97,102,(char)233,13,10,0};
  static const WCHAR wide[]={99,97,102,233,13,10,0};
  static const BYTE oem[]={99,97,102,130,13,10,0};
  HGLOBAL h=block(narrow,sizeof(narrow));CHECK(SetClipboardData(CF_TEXT,h)==h);CHECK(CountClipboardFormats()==1);CHECK(CloseClipboard());
  CHECK(CountClipboardFormats()==4);CHECK(IsClipboardFormatAvailable(CF_UNICODETEXT));CHECK(OpenClipboard(NULL));CHECK(GetClipboardOwner()==owner);
  CHECK(EnumClipboardFormats(0)==CF_TEXT);CHECK(EnumClipboardFormats(CF_TEXT)==CF_LOCALE);CHECK(EnumClipboardFormats(CF_LOCALE)==CF_OEMTEXT);CHECK(EnumClipboardFormats(CF_OEMTEXT)==CF_UNICODETEXT);
  expect(CF_TEXT,narrow,sizeof(narrow));expect(CF_UNICODETEXT,wide,sizeof(wide));expect(CF_OEMTEXT,oem,sizeof(oem));
  CHECK(CloseClipboard());CHECK(OpenClipboard(NULL));expect(CF_UNICODETEXT,wide,sizeof(wide));CHECK(EmptyClipboard());CHECK(GetClipboardOwner()==NULL);CHECK(CloseClipboard());CHECK(destroyed==1);
  CHECK(OpenClipboard(owner));CHECK(EmptyClipboard());SetClipboardData(CF_TEXT,NULL);CHECK(CloseClipboard());CHECK(OpenClipboard(NULL));
  static const WCHAR delayed[]={100,101,108,97,121,101,100,0};expect(CF_UNICODETEXT,delayed,sizeof(delayed));CHECK(rendered==1);CHECK(CloseClipboard());
  CHECK(OpenClipboard(NULL));expect(CF_UNICODETEXT,delayed,sizeof(delayed));CHECK(rendered==1);CHECK(EmptyClipboard());CHECK(CloseClipboard());
  ansi=CreateWindowExA(WS_EX_CLIENTEDGE,"EDIT","",WS_CHILD|WS_VISIBLE|ES_MULTILINE|ES_AUTOVSCROLL|WS_TABSTOP,16,30,600,100,owner,(HMENU)1,c.hInstance,NULL);CHECK(ansi);
  unicode=CreateWindowExW(WS_EX_CLIENTEDGE,L"EDIT",L"",WS_CHILD|WS_VISIBLE|ES_MULTILINE|ES_AUTOVSCROLL|WS_TABSTOP,16,160,600,100,owner,(HMENU)2,c.hInstance,NULL);CHECK(unicode);
  SetWindowTextA(ansi,narrow);SendMessageA(ansi,EM_SETSEL,0,4);SendMessageA(ansi,WM_COPY,0,0);SendMessageW(unicode,WM_PASTE,0,0);
  WCHAR read[128];GetWindowTextW(unicode,read,128);CHECK(lstrcmpW(read,L"caf\x00e9")==0);
  SendMessageW(unicode,EM_SETSEL,0,4);SendMessageW(unicode,WM_CUT,0,0);GetWindowTextW(unicode,read,128);CHECK(!read[0]);
  SendMessageW(unicode,WM_UNDO,0,0);GetWindowTextW(unicode,read,128);CHECK(lstrcmpW(read,L"caf\x00e9")==0);
  SetWindowTextW(unicode,L"\x03a9 \xd83d\xde00");SendMessageW(unicode,EM_SETSEL,0,4);SendMessageW(unicode,WM_COPY,0,0);
  SetWindowTextA(ansi,"");SendMessageA(ansi,WM_PASTE,0,0);GetWindowTextW(ansi,read,128);CHECK(lstrcmpW(read,L"\x03a9 \xd83d\xde00")==0);
  SendMessageW(ansi,EM_SETSEL,0,-1);SendMessageW(ansi,EM_REPLACESEL,TRUE,(LPARAM)L"\x03b2\x20ac tail");GetWindowTextW(ansi,read,128);CHECK(lstrcmpW(read,L"\x03b2\x20ac tail")==0);
  SetWindowTextA(ansi,"select text, then use Copy / Paste or Ctrl+C / Ctrl+V");SetWindowTextW(unicode,L"Unicode editor: caf\x00e9 \x03a9 \xd83d\xde00");
  for(int i=0;i<5;i++){static const WCHAR *names[]={L"Copy",L"Paste",L"Cut",L"Undo",L"Paste below"};CreateWindowW(L"BUTTON",names[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,16+i*120,280,112,26,owner,(HMENU)(INT_PTR)(10+i),c.hInstance,NULL);}
  static const char output[]="clipboard native startup checks passed\r\n";DWORD written;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),output,sizeof(output)-1,&written,NULL);
  char checkOnly[2];if(GetEnvironmentVariableA("CLIPBOARD_CHECK_ONLY",checkOnly,2))ExitProcess(0);
  ShowWindow(owner,SW_SHOW);UpdateWindow(owner);SetFocus(ansi);MSG msg;while(GetMessageW(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}ExitProcess(0);
}
