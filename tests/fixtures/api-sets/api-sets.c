// SPDX-License-Identifier: MIT
// Native PE client of distinct Windows API-set contract families.
#include <windows.h>
#include <winternl.h>
#ifdef TEST_NATIVE_SCHEMA
__declspec(dllimport) LONG WINAPI ApiSetQueryApiSetPresenceEx(const UNICODE_STRING *, BOOLEAN *, BOOLEAN *);
#endif
static void report(const char *s) {
  DWORD size=0,written=0;while(s[size])size++;
  WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),s,size,&written,0);
}
#define CHECK(x,n) do { if (!(x)) { report("API SET FAIL\n"); ExitProcess(n); } } while(0)
void _start(void) {
  void *peb=0;__asm__("movl %%fs:0x30,%0":"=r"(peb));
  DWORD *schema=*(DWORD **)((BYTE *)peb+0x38);
  CHECK(schema&&schema[0]==6&&schema[3]==672,1);
  HANDLE heap=GetProcessHeap();BYTE *p=HeapAlloc(heap,HEAP_ZERO_MEMORY,37);CHECK(p,2);
  for(int i=0;i<37;i++)CHECK(p[i]==0,3);
  p[0]=91;p=HeapReAlloc(heap,HEAP_ZERO_MEMORY,p,91);CHECK(p&&p[0]==91&&p[90]==0,4);
  CHECK(HeapFree(heap,0,p),5);
  HANDLE file=CreateFileA("contract-test.txt",GENERIC_READ|GENERIC_WRITE,0,0,CREATE_ALWAYS,0,0);
  CHECK(file!=INVALID_HANDLE_VALUE,6);
  DWORD written=0;CHECK(WriteFile(file,"contract bytes",14,&written,0)&&written==14,7);
  CHECK(CloseHandle(file),8);
  file=CreateFileA("contract-test.txt",GENERIC_READ,0,0,OPEN_EXISTING,0,0);
  char text[14];DWORD read=0;CHECK(ReadFile(file,text,14,&read,0)&&read==14,9);
  for(int i=0;i<14;i++)CHECK(text[i]=="contract bytes"[i],10);
  CHECK(CloseHandle(file),11);
  HKEY key=0;DWORD disposition=0;
  CHECK(RegCreateKeyExW(HKEY_CURRENT_USER,L"Software\\WineBrowserContract",0,0,0,KEY_ALL_ACCESS,0,&key,&disposition)==0,12);
  DWORD value=0x12345678,type=0,size=4,copy=0;
  CHECK(RegSetValueExW(key,L"Value",0,REG_DWORD,(BYTE *)&value,4)==0,13);
  CHECK(RegQueryValueExW(key,L"Value",0,&type,(BYTE *)&copy,&size)==0&&type==REG_DWORD&&copy==value,14);
  CHECK(RegCloseKey(key)==0,15);
  CHECK(CharNextA("ab")[0]=='b',16);
  HMODULE first=LoadLibraryA("API-MS-WIN-CORE-HEAP-L1-1-99.DLL");CHECK(first,17);
  CHECK(first==GetModuleHandleW(L"kernelbase.dll"),18);
  CHECK(first==GetModuleHandleW(L"api-ms-win-core-file-l1-2-0.dll"),19);
  CHECK(GetProcAddress(first,"HeapAlloc")!=0&&GetProcAddress(first,"NoSuchFunction") == 0,20);
  CHECK(FreeLibrary(first),21);
#ifdef TEST_NATIVE_SCHEMA
  static const WCHAR names[][80]={L"api-ms-win-core-file-l1-1-0",L"ext-ms-win-xaudio-platform-l1-1-0",L"api-ms-win-made-up-l1-1-0"};
  for(int i=0;i<3;i++) {
    USHORT length=0;while(names[i][length])length++;
    UNICODE_STRING name={length*2,length*2+2,(WCHAR *)names[i]};
    BOOLEAN in_schema=9,present=9;
    CHECK(ApiSetQueryApiSetPresenceEx(&name,&in_schema,&present)==0,22);
    CHECK(in_schema==(i<2)&&present==(i==0),23);
  }
  report("NATIVE API SET SCHEMA PASS\n");
#else
  report("HOST API SET SERVICES PASS\n");
#endif
  ExitProcess(0);
}
