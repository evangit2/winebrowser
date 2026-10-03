// SPDX-License-Identifier: MIT
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <winternl.h>
#ifdef NATIVE_BASE
__declspec(dllimport) LONG WINAPI ApiSetQueryApiSetPresenceEx(const UNICODE_STRING *,BOOLEAN *,BOOLEAN *);
#endif
static void report(const char *s) {
  DWORD length=0,written=0;while(s[length])length++;
  WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),s,length,&written,0);
}
#define CHECK(value,code) do { if(!(value)) {report("DLL SEARCH FAIL\n");ExitProcess(code);} } while(0)
typedef int (__cdecl *function)(void);
static int identify(HMODULE module) {
  function f=(function)(void *)GetProcAddress(module,"identify");CHECK(f,90);return f();
}
void _start(void) {
#ifdef NATIVE_BASE
  static WCHAR contract[]=L"api-ms-win-core-file-l1-1-0";
  UNICODE_STRING name={sizeof(contract)-2,sizeof(contract),contract};
  BOOLEAN present=0,in_schema=0;
  CHECK(ApiSetQueryApiSetPresenceEx(&name,&in_schema,&present)==0&&in_schema&&present,1);
#endif
  CHECK(!LoadLibraryExA("helper.dll",0,LOAD_LIBRARY_SEARCH_SYSTEM32)&&GetLastError()==ERROR_MOD_NOT_FOUND,2);
  HMODULE application=LoadLibraryExW(L"helper.dll",0,LOAD_LIBRARY_SEARCH_APPLICATION_DIR);
  CHECK(application&&identify(application)==202,3);CHECK(FreeLibrary(application),4);
  CHECK(!GetModuleHandleA("helper.dll"),5);
  HMODULE plugin=LoadLibraryExW(L"C:\\winebrowser\\plugins\\plugin.dll",0,
                              LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR|LOAD_LIBRARY_SEARCH_SYSTEM32);
  CHECK(plugin,6);
  function invoke=(function)(void *)GetProcAddress(plugin,"invoke");CHECK(invoke&&invoke()==606,7);
  HMODULE helper=GetModuleHandleW(L"helper.dll");CHECK(helper&&identify(helper)==303,8);
  WCHAR path[260];CHECK(GetModuleFileNameW(helper,path,260)>0,9);
  static const WCHAR expected[]=L"C:\\winebrowser\\plugins\\helper.dll";
  for(unsigned i=0;i<sizeof(expected)/sizeof(WCHAR);i++)CHECK(path[i]==expected[i],10);
  CHECK(FreeLibrary(plugin)&&!GetModuleHandleA("helper.dll")&&!GetModuleHandleA("plugin.dll"),11);
  CHECK(!LoadLibraryExA("helper.dll",0,LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR)&&GetLastError()==ERROR_INVALID_PARAMETER,12);
  CHECK(!LoadLibraryExA("helper.dll",0,LOAD_WITH_ALTERED_SEARCH_PATH|LOAD_LIBRARY_SEARCH_SYSTEM32)
        &&GetLastError()==ERROR_INVALID_PARAMETER,13);
#ifdef NATIVE_BASE
  DLL_DIRECTORY_COOKIE cookie=AddDllDirectory(L"C:\\winebrowser\\plugins");CHECK(cookie,14);
  helper=LoadLibraryExW(L"helper.dll",0,LOAD_LIBRARY_SEARCH_USER_DIRS);
  CHECK(helper&&identify(helper)==303,15);CHECK(FreeLibrary(helper),16);
  CHECK(RemoveDllDirectory(cookie),17);
  CHECK(!LoadLibraryExW(L"helper.dll",0,LOAD_LIBRARY_SEARCH_USER_DIRS)&&GetLastError()==ERROR_MOD_NOT_FOUND,18);
  CHECK(SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_USER_DIRS),19);
  CHECK(!LoadLibraryA("helper.dll")&&GetLastError()==ERROR_MOD_NOT_FOUND,20);
  cookie=AddDllDirectory(L"C:\\winebrowser\\plugins");CHECK(cookie,21);
  helper=LoadLibraryA("helper.dll");CHECK(helper&&identify(helper)==303,22);
  CHECK(FreeLibrary(helper)&&RemoveDllDirectory(cookie),23);
  report("NATIVE DLL SEARCH PASS\n");
#else
  report("HOST DLL SEARCH PASS\n");
#endif
  ExitProcess(0);
}
