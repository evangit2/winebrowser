// SPDX-License-Identifier: MIT
#include <windows.h>
static void report(const char *s){DWORD n=0,w=0;while(s[n])n++;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),s,n,&w,0);}
#define CHECK(x,c) do{if(!(x)){report("PROCESS FAIL\n");ExitProcess(c);}}while(0)
static int contains(const WCHAR *s,const WCHAR *v){for(;*s;s++){const WCHAR *a=s,*b=v;while(*b&&*a==*b){a++;b++;}if(!*b)return 1;}return 0;}
static void outputFile(const WCHAR *name,const char *value){HANDLE h=CreateFileW(name,GENERIC_WRITE,0,0,CREATE_ALWAYS,0,0);DWORD n=0,w=0;while(value[n])n++;CHECK(h!=INVALID_HANDLE_VALUE,90);CHECK(WriteFile(h,value,n,&w,0)&&w==n,91);CHECK(CloseHandle(h),92);}
static LRESULT CALLBACK proc(HWND h,UINT m,WPARAM w,LPARAM l){if(m==WM_DESTROY){PostQuitMessage(0);return 0;}return DefWindowProcW(h,m,w,l);}
void _start(void){
  if(contains(GetCommandLineW(),L"--detached")){
    CHECK(WinExec("\"engine folder\\worker renamed.exe\" --detached",SW_SHOW)>31,80);
    report("LAUNCHER EXIT\n");ExitProcess(0);
  }
  if(contains(GetCommandLineW(),L"--gui")){
    WNDCLASSW c={0};c.lpfnWndProc=proc;c.hInstance=GetModuleHandleW(0);c.lpszClassName=L"ProcessParent";
    CHECK(RegisterClassW(&c),83);CHECK(CreateWindowW(c.lpszClassName,L"Independent parent window",WS_OVERLAPPEDWINDOW|WS_VISIBLE,380,40,320,200,0,0,c.hInstance,0),84);
    STARTUPINFOW si={0};PROCESS_INFORMATION pi={0};si.cb=sizeof(si);
    WCHAR cmd[]=L"\"engine folder\\worker renamed.exe\" --gui";
    CHECK(CreateProcessW(0,cmd,0,0,FALSE,0,0,0,&si,&pi),81);
    CHECK(CloseHandle(pi.hThread)&&CloseHandle(pi.hProcess),82);
    report("GUI PARENT READY\n");MSG m;while(GetMessageW(&m,0,0,0)>0){TranslateMessage(&m);DispatchMessageW(&m);}
    report("GUI LAUNCHER EXIT\n");ExitProcess(0);
  }
  outputFile(L"seed.txt","SHARED SEED");
  STARTUPINFOW si={0};PROCESS_INFORMATION pi={0};si.cb=sizeof(si);
  WCHAR cmd[]=L"\"engine folder\\worker renamed.exe\" \"two words\" \"quoted\\\"value\"";
  WCHAR env[]=L"PROCESS_TEST=child value\0SystemRoot=C:\\Windows\0\0";
  CHECK(CreateProcessW(0,cmd,0,0,FALSE,CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT,env,L"engine folder",&si,&pi),1);
  CHECK(pi.dwProcessId!=GetCurrentProcessId()&&pi.dwThreadId!=GetCurrentThreadId(),2);
  DWORD code=0;CHECK(GetExitCodeProcess(pi.hProcess,&code)&&code==STILL_ACTIVE,3);
  CHECK(WaitForSingleObject(pi.hProcess,0)==WAIT_TIMEOUT,4);
  CHECK(ResumeThread(pi.hThread)==1,5);
  HANDLE copy=0;CHECK(DuplicateHandle(GetCurrentProcess(),pi.hProcess,GetCurrentProcess(),&copy,0,FALSE,DUPLICATE_SAME_ACCESS),6);
  CHECK(WaitForSingleObject(copy,15000)==WAIT_OBJECT_0,7);
  CHECK(WaitForSingleObject(pi.hThread,0)==WAIT_OBJECT_0,8);
  CHECK(GetExitCodeProcess(pi.hProcess,&code)&&code==73,9);
  HANDLE h=CreateFileW(L"engine folder\\child-output.txt",GENERIC_READ,FILE_SHARE_READ,0,OPEN_EXISTING,0,0);char data[8]={0};DWORD n=0;
  CHECK(h!=INVALID_HANDLE_VALUE&&ReadFile(h,data,7,&n,0)&&n==7&&data[0]=='S'&&data[5]=='D'&&data[6]=='!',10);
  CHECK(CloseHandle(h)&&CloseHandle(copy)&&CloseHandle(pi.hThread)&&CloseHandle(pi.hProcess),11);
  CHECK(!GetExitCodeProcess(pi.hProcess,&code)&&GetLastError()==ERROR_INVALID_HANDLE,12);
  char ansi[]= "\"engine folder\\worker renamed.exe\" --ansi";STARTUPINFOA sa={0};sa.cb=sizeof(sa);
  CHECK(CreateProcessA(0,ansi,0,0,FALSE,0,0,0,&sa,&pi),13);
  CHECK(WaitForSingleObject(pi.hProcess,15000)==WAIT_OBJECT_0&&GetExitCodeProcess(pi.hProcess,&code)&&code==74,14);
  CHECK(CloseHandle(pi.hProcess)&&CloseHandle(pi.hThread),15);
  WCHAR missing[]=L"missing.exe";CHECK(!CreateProcessW(0,missing,0,0,FALSE,0,0,0,&si,&pi),16);
  WCHAR unsupported[]=L"\"engine folder\\worker renamed.exe\" --ansi";
  CHECK(!CreateProcessW(0,unsupported,0,0,TRUE,0,0,0,&si,&pi),17);
  WCHAR stopped[]=L"\"engine folder\\worker renamed.exe\" --ansi";
  CHECK(CreateProcessW(0,stopped,0,0,FALSE,CREATE_SUSPENDED,0,0,&si,&pi),18);
  HANDLE opened=OpenProcess(PROCESS_QUERY_INFORMATION|SYNCHRONIZE,FALSE,pi.dwProcessId);CHECK(opened,19);
  CHECK(TerminateProcess(pi.hProcess,91)&&WaitForSingleObject(opened,0)==WAIT_OBJECT_0,20);
  CHECK(GetExitCodeProcess(opened,&code)&&code==91,21);
  CHECK(CloseHandle(opened)&&CloseHandle(pi.hThread)&&CloseHandle(pi.hProcess),22);
  report("PROCESS PASS\n");ExitProcess(0);
}
