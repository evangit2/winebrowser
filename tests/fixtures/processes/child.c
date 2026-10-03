// SPDX-License-Identifier: MIT
#include <windows.h>
static void report(const char *s){DWORD n=0,w=0;while(s[n])n++;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),s,n,&w,0);}
#define CHECK(x,c) do{if(!(x)){report("CHILD FAIL\n");ExitProcess(c);}}while(0)
static int contains(const WCHAR *s,const WCHAR *v){for(;*s;s++){const WCHAR *a=s,*b=v;while(*b&&*a==*b){a++;b++;}if(!*b)return 1;}return 0;}
static int same(const WCHAR *a,const WCHAR *b){while(*a&&*a==*b){a++;b++;}return *a==*b;}
static LRESULT CALLBACK proc(HWND h,UINT m,WPARAM w,LPARAM l){if(m==WM_DESTROY){PostQuitMessage(0);return 0;}return DefWindowProcW(h,m,w,l);}
void _start(void){
  WCHAR native[]=L"A";CHECK(CharLowerBuffW(native,1)==1&&native[0]=='a',50);
  const WCHAR *cmd=GetCommandLineW();
  CHECK(GetCurrentProcessId()!=1&&GetCurrentThreadId()!=1,51);
  if(contains(cmd,L"--detached")){Sleep(250);report("DETACHED CHILD PASS\n");ExitProcess(75);}
  if(contains(cmd,L"--gui")){
    WNDCLASSW c={0};c.lpfnWndProc=proc;c.hInstance=GetModuleHandleW(0);c.lpszClassName=L"ProcessChild";
    CHECK(RegisterClassW(&c),60);HWND h=CreateWindowW(c.lpszClassName,L"Independent child window",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,320,200,0,0,c.hInstance,0);CHECK(h,61);
    report("GUI CHILD READY\n");MSG m;while(GetMessageW(&m,0,0,0)>0){TranslateMessage(&m);DispatchMessageW(&m);}report("GUI CHILD CLOSED\n");ExitProcess(0);
  }
  if(contains(cmd,L"--ansi")){report("ANSI CHILD PASS\n");ExitProcess(74);}
  WCHAR value[260];CHECK(GetEnvironmentVariableW(L"PROCESS_TEST",value,260)==11&&same(value,L"child value"),52);
  CHECK(contains(cmd,L"\"two words\" \"quoted\\\"value\""),53);
  CHECK(GetCurrentDirectoryW(260,value)>0&&contains(value,L"engine folder"),54);
  HANDLE h=CreateFileW(L"..\\seed.txt",GENERIC_READ,FILE_SHARE_READ,0,OPEN_EXISTING,0,0);char data[12]={0};DWORD n=0;
  CHECK(h!=INVALID_HANDLE_VALUE&&ReadFile(h,data,11,&n,0)&&n==11&&data[0]=='S'&&data[10]=='D',55);CHECK(CloseHandle(h),56);
  h=CreateFileW(L"child-output.txt",GENERIC_WRITE,0,0,CREATE_ALWAYS,0,0);CHECK(h!=INVALID_HANDLE_VALUE,57);CHECK(WriteFile(h,"SHARED!",7,&n,0)&&n==7&&CloseHandle(h),58);
  report("WIDE CHILD PASS\n");ExitProcess(73);
}
