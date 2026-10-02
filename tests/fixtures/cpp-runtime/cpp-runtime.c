// SPDX-License-Identifier: MIT
// Unchanged native x86 ABI client for source-built Visual C++ runtime DLLs.
#include <windows.h>
__declspec(dllimport) int __cdecl _Mtx_init(void **,int);
__declspec(dllimport) int __cdecl _Mtx_lock(void *);
__declspec(dllimport) int __cdecl _Mtx_trylock(void *);
__declspec(dllimport) int __cdecl _Mtx_current_owns(void *);
__declspec(dllimport) int __cdecl _Mtx_unlock(void *);
__declspec(dllimport) void __cdecl _Mtx_destroy(void *);
struct exception_data {const char *what;int dofree;};
__declspec(dllimport) void __cdecl __std_exception_copy(const struct exception_data *,struct exception_data *);
__declspec(dllimport) void __cdecl __std_exception_destroy(struct exception_data *);
__declspec(dllimport) void *__cdecl _Aligned_new_delete_resource(void);
typedef void *(__attribute__((thiscall)) *resource_allocate)(void *,SIZE_T,SIZE_T);
typedef void (__attribute__((thiscall)) *resource_deallocate)(void *,void *,SIZE_T,SIZE_T);
static void report(const char *s) {DWORD n=0,w=0;while(s[n])n++;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),s,n,&w,0);}
#define CHECK(x,n) do {if(!(x)){report("CPP RUNTIME FAIL\n");ExitProcess(n);}}while(0)
static void check_runtime(void) {
  void *mutex=0;
  CHECK(_Mtx_init(&mutex,2)==0&&mutex,1);
  CHECK(_Mtx_current_owns(mutex)==0&&_Mtx_lock(mutex)==0,2);
  CHECK(_Mtx_current_owns(mutex)==1&&_Mtx_trylock(mutex)==3,3);
  CHECK(_Mtx_unlock(mutex)==0&&_Mtx_current_owns(mutex)==0,4);
  CHECK(_Mtx_trylock(mutex)==0&&_Mtx_unlock(mutex)==0,5);_Mtx_destroy(mutex);
  char message[]="native C++ message";
  struct exception_data source={message,1},copy={0,0};
  __std_exception_copy(&source,&copy);
  CHECK(copy.what&&copy.what!=source.what&&copy.dofree==1,6);
  for(int i=0;i<(int)sizeof(message);i++)CHECK(copy.what[i]==message[i],7);
  message[0]='X';CHECK(copy.what[0]=='n',8);__std_exception_destroy(&copy);
  CHECK(copy.what==0&&copy.dofree==0,9);
  void *resource=_Aligned_new_delete_resource();CHECK(resource,10);
  void **vtable=*(void ***)resource;
  void *aligned=((resource_allocate)vtable[1])(resource,96,64);
  CHECK(aligned&&((ULONG_PTR)aligned&63)==0,11);
  for(int i=0;i<96;i++)((BYTE *)aligned)[i]=(BYTE)(i^0x5a);
  ((resource_deallocate)vtable[2])(resource,aligned,96,64);
  HMODULE concurrency=LoadLibraryA("concrt140.dll");CHECK(concurrency,12);
  void *(__cdecl *allocate)(SIZE_T)=(void *(__cdecl *)(SIZE_T))(void *)GetProcAddress(concurrency,"?Alloc@Concurrency@@YAPAXI@Z");
  void (__cdecl *release)(void *)=(void (__cdecl *)(void *))(void *)GetProcAddress(concurrency,"?Free@Concurrency@@YAXPAX@Z");
  CHECK(allocate&&release,13);
  void *memory=allocate(128);CHECK(memory,14);
  for(int i=0;i<128;i++){((BYTE *)memory)[i]=(BYTE)i;}
  release(memory);
  CHECK(FreeLibrary(concurrency),15);
  report("NATIVE CPP RUNTIME PASS\n");
}
#ifdef CPP_RUNTIME_DLL
__declspec(dllexport) int WINAPI RunCppRuntimeChecks(void) {check_runtime();return 0xc14;}
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,LPVOID reserved) {(void)instance;(void)reason;(void)reserved;return TRUE;}
#else
void _start(void) {check_runtime();ExitProcess(0);}
#endif
