#include <windows.h>
#define CHECK(x) do {if(!(x))ExitProcess(__LINE__+1000);} while(0)
typedef struct { HWND root; WNDPROC previous; int wide,veto; unsigned texts,keys,clicks,destroyed; } HOOK;
#define HOOK_MESSAGE (WM_APP+71)
#ifdef HOOK_BUILD
#define HOOK_API __declspec(dllexport)
#else
#define HOOK_API __declspec(dllimport)
#endif
HOOK_API BOOL WINAPI InstallHook(HWND window,HOOK *context);
