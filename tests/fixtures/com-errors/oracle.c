/* Original WineBrowser contributors, MIT. Native COM error-info reference. */
#define COBJMACROS
#include <windows.h>
#include <oleauto.h>
#include <stdio.h>
typedef struct { IErrorInfo iface; LONG refs; } ErrorObject;
static HRESULT WINAPI query(IErrorInfo *iface,REFIID iid,void **out){(void)iid;*out=iface;InterlockedIncrement(&((ErrorObject*)iface)->refs);return S_OK;}
static ULONG WINAPI add(IErrorInfo *iface){return InterlockedIncrement(&((ErrorObject*)iface)->refs);}
static ULONG WINAPI release(IErrorInfo *iface){return InterlockedDecrement(&((ErrorObject*)iface)->refs);}
static IErrorInfoVtbl vtable={query,add,release,NULL,NULL,NULL,NULL,NULL};
static ErrorObject first={{&vtable},1},second={{&vtable},1};
static int initial=1;
static void row(const char *step,HRESULT hr,IErrorInfo *value){printf("%s{\"step\":\"%s\",\"hr\":%lu,\"value\":%d,\"refs\":[%ld,%ld],\"error\":%lu}",initial?"":",\n",step,(DWORD)hr,value==&first.iface?1:value==&second.iface?2:value==NULL?0:9,first.refs,second.refs,GetLastError());initial=0;}
static DWORD WINAPI worker(void *unused){(void)unused;IErrorInfo *value=(IErrorInfo*)0x12345678;SetLastError(777);HRESULT hr=GetErrorInfo(0,&value);row("thread-empty",hr,value);hr=SetErrorInfo(0,&first.iface);row("thread-set",hr,NULL);return 0;}
int main(void){IErrorInfo *value=(IErrorInfo*)0x12345678;HRESULT hr;SetLastError(777);puts("[");
 hr=GetErrorInfo(0,&value);row("empty",hr,value);
 hr=SetErrorInfo(0,&first.iface);row("set-first",hr,NULL);
 value=(IErrorInfo*)0x12345678;hr=GetErrorInfo(1,&value);row("get-reserved",hr,value);
 hr=SetErrorInfo(1,&second.iface);row("set-reserved",hr,NULL);
 hr=GetErrorInfo(0,NULL);row("get-null",hr,NULL);
 hr=GetErrorInfo(0,&value);row("take",hr,value);IErrorInfo_Release(value);row("caller-release",0,NULL);
 hr=SetErrorInfo(0,&first.iface);row("set-again",hr,NULL);
 hr=SetErrorInfo(0,&second.iface);row("replace",hr,NULL);
 HANDLE thread=CreateThread(NULL,0,worker,NULL,0,NULL);WaitForSingleObject(thread,INFINITE);CloseHandle(thread);SetLastError(777);row("after-thread",0,NULL);
 hr=GetErrorInfo(0,&value);row("main-take",hr,value);IErrorInfo_Release(value);
 hr=SetErrorInfo(0,&first.iface);row("set-before-clear",hr,NULL);hr=SetErrorInfo(0,NULL);row("clear",hr,NULL);
 value=(IErrorInfo*)0x12345678;hr=GetErrorInfo(0,&value);row("empty-after-clear",hr,value);puts("]");return 0;}
