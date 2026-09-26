#include <windows.h>
#define CHECK(c) do {if(!(c))ExitProcess(__LINE__);} while(0)
#ifndef MAIN_EXIT
static HANDLE gate;
#endif
static DWORD WINAPI worker(void *value) {
#ifdef MAIN_EXIT
 HANDLE main=value;DWORD code=0;
 CHECK(GetThreadId(main)!=GetCurrentThreadId());
 CHECK(WaitForSingleObject(main,5000)==WAIT_OBJECT_0);
 CHECK(GetExitCodeThread(main,&code) && code==99);
 CHECK(CloseHandle(main));
 return 0;
#else
 (void)value;CHECK(WaitForSingleObject(gate,5000)==WAIT_OBJECT_0);return 67;
#endif
}
void start(void) {
 HANDLE process=GetCurrentProcess(), main=0;
 CHECK(DuplicateHandle(process,GetCurrentThread(),process,&main,0,FALSE,DUPLICATE_SAME_ACCESS));
 CHECK(main!=GetCurrentThread() && GetThreadId(main)==GetCurrentThreadId());
 CHECK(WaitForSingleObject(main,0)==WAIT_TIMEOUT);
#ifdef MAIN_EXIT
 HANDLE thread=CreateThread(0,0,worker,main,0,0);CHECK(thread && CloseHandle(thread));
 ExitThread(99);
#else
 HANDLE copy=0;
 CHECK(DuplicateHandle(process,main,process,&copy,0,FALSE,DUPLICATE_SAME_ACCESS|DUPLICATE_CLOSE_SOURCE));
 CHECK(GetThreadId(copy)==GetCurrentThreadId() && !GetThreadId(main));CHECK(CloseHandle(copy));
 HANDLE event=CreateEventA(0,FALSE,FALSE,0);CHECK(event);
 CHECK(DuplicateHandle(process,event,process,&gate,SYNCHRONIZE,FALSE,0));
 CHECK(!SetEvent(gate) && GetLastError()==ERROR_ACCESS_DENIED);
 HANDLE original=CreateThread(0,0,worker,0,0,0), retained=0;CHECK(original);
 CHECK(DuplicateHandle(process,original,process,&retained,0,FALSE,DUPLICATE_SAME_ACCESS));
 DWORD id=GetThreadId(original);CHECK(id && GetThreadId(retained)==id);
 CHECK(CloseHandle(original) && SetEvent(event) && CloseHandle(event));
 CHECK(WaitForSingleObject(retained,5000)==WAIT_OBJECT_0);
 DWORD code=0;CHECK(GetExitCodeThread(retained,&code) && code==67);
 CHECK(CloseHandle(retained) && CloseHandle(gate));
 event=CreateEventA(0,TRUE,FALSE,0);CHECK(event);
 CHECK(DuplicateHandle(process,event,0,0,0,FALSE,DUPLICATE_CLOSE_SOURCE));
 CHECK(!SetEvent(event) && GetLastError()==ERROR_INVALID_HANDLE);
 ExitProcess(0);
#endif
}
