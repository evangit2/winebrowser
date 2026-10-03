// SPDX-License-Identifier: MIT
#include <windows.h>
#include <delayimp.h>
extern DWORD __cdecl __declspec(dllimport) DelayedAdd(DWORD,DWORD);
extern DWORD __cdecl __declspec(dllimport) DelayedOrdinal(void);
extern DWORD __cdecl __declspec(dllimport) NeverUsed(void);
extern int __cdecl __declspec(dllimport) _stricmp(const char *,const char *);
static DWORD notifications,load_failures,proc_failures;
static DWORD __cdecl fallback(void){return 0xdecaf;}
static FARPROC WINAPI failure(unsigned reason,PDelayLoadInfo info){
  if(reason==dliFailLoadLib){if(info->dwLastError!=ERROR_MOD_NOT_FOUND)ExitProcess(9);load_failures++;return (FARPROC)GetModuleHandleA("delayed.dll");}
  if(reason==dliFailGetProc){if(info->dwLastError!=ERROR_PROC_NOT_FOUND)ExitProcess(10);proc_failures++;return (FARPROC)fallback;}
  return 0;
}
static FARPROC WINAPI notice(unsigned reason, PDelayLoadInfo info) {
  (void)info;if(reason==dliNotePreLoadLibrary)notifications++;return 0;
}
#define CHECK(x,n) do{if(!(x))ExitProcess(n);}while(0)
// Keep a genuine optional delay descriptor while never calling its thunk.
DWORD try_optional(void){return NeverUsed();}
#ifdef NATIVE_RESOLVER
extern IMAGE_DOS_HEADER __ImageBase;
typedef void *(WINAPI *resolve_delay_t)(void *,PCImgDelayDescr,void *,void *,void *,ULONG);
static void resolve_native(void){
  resolve_delay_t resolve=(void*)GetProcAddress(GetModuleHandleA("ntdll.dll"),"LdrResolveDelayLoadedAPI");
  CHECK(resolve,14);
  BYTE *base=(BYTE*)&__ImageBase;
  IMAGE_NT_HEADERS32 *nt=(void*)(base+__ImageBase.e_lfanew);
  ImgDelayDescr *desc=(void*)(base+nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT].VirtualAddress);
  while(desc->rvaDLLName){
    char *name=(void*)(base+desc->rvaDLLName);
    if(name[0]=='d'&&name[1]=='e'&&name[2]=='l')break;
    desc++;
  }
  CHECK(desc->rvaDLLName,15);
  DWORD *lookup=(void*)(base+desc->rvaINT),*slots=(void*)(base+desc->rvaIAT);
  for(DWORD i=0;lookup[i];i++)CHECK(resolve(base,desc,0,0,slots+i,0),16);
}
#endif
void _start(void) {
  CHECK(!GetModuleHandleA("delayed.dll")&&!GetModuleHandleA("absent-optional.dll"),1);
  __pfnDliNotifyHook2=notice;
#ifdef NATIVE_RESOLVER
  resolve_native();
#endif
  CHECK(DelayedAdd(20,22)==42,2);
  HMODULE dll=GetModuleHandleA("delayed.dll");CHECK(dll,3);
  CHECK(DelayedOrdinal()==0xc14,4);
#ifdef NATIVE_RESOLVER
  CHECK(DelayedAdd(30,12)==42&&notifications==0,5);
#else
  CHECK(DelayedAdd(30,12)==42&&notifications==1,5);
#endif
  CHECK(!GetModuleHandleA("absent-optional.dll"),6);
  CHECK(_stricmp("WineBrowser","winebrowser")==0&&_stricmp("A","z")<0,17);
  __pfnDliFailureHook2=failure;
  CHECK(try_optional()==0xdecaf&&load_failures==1&&proc_failures==1,11);
  CHECK(try_optional()==0xdecaf&&load_failures==1&&proc_failures==1,12);
  CHECK(!GetModuleHandleA("absent-optional.dll"),13);
#ifdef NATIVE_RESOLVER
  const char message[]="NATIVE NTDLL DELAY RESOLVER PASS\n";
#else
  const char message[]="NATIVE DELAY IMPORT PASS\n";
#endif
  DWORD written;
  CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),message,sizeof(message)-1,&written,0),7);
  CHECK(FreeLibrary(dll)&&!GetModuleHandleA("delayed.dll"),8);
  ExitProcess(0);
}
