// SPDX-License-Identifier: MIT
#include <windows.h>
static volatile DWORD phase;
static HANDLE complete_event;
static OVERLAPPED waiting;
static volatile HANDLE waiting_file;
static const char name[]="locked.bin";
#define CHECK(x,n) do{if(!(x))ExitProcess(n);}while(0)
static DWORD WINAPI competitor(void *arg){
  (void)arg;
  HANDLE file=CreateFileA(name,GENERIC_READ|GENERIC_WRITE,7,0,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,0);
  CHECK(file!=INVALID_HANDLE_VALUE,10);
  waiting_file=file;waiting.hEvent=complete_event;phase=1;
  CHECK(LockFileEx(file,LOCKFILE_EXCLUSIVE_LOCK,0,8,0,&waiting),11);
  CHECK(WaitForSingleObject(complete_event,0)==WAIT_OBJECT_0,12);
  DWORD read=0;BYTE data[8]={0};OVERLAPPED positioned={0};
  HANDLE event=CreateEventA(0,TRUE,FALSE,0);CHECK(event,13);
  positioned.hEvent=(HANDLE)((ULONG_PTR)event|1);
  CHECK(ReadFile(file,data,8,&read,&positioned)&&read==8&&data[0]==42&&data[7]==49,14);
  CHECK(WaitForSingleObject(event,0)==WAIT_OBJECT_0,15);
  CHECK(CloseHandle(event),16);
  phase=2;CHECK(UnlockFileEx(file,0,8,0,&waiting),17);
  CHECK(CloseHandle(file),18);return 0xc14;
}
void _start(void){
  HANDLE file=CreateFileA(name,GENERIC_READ|GENERIC_WRITE,7,0,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,0);
  CHECK(file!=INVALID_HANDLE_VALUE,1);
  const BYTE data[]={42,43,44,45,46,47,48,49};DWORD written;
  CHECK(WriteFile(file,data,8,&written,0)&&written==8,2);
  OVERLAPPED owner={0};CHECK(LockFileEx(file,LOCKFILE_EXCLUSIVE_LOCK|LOCKFILE_FAIL_IMMEDIATELY,0,8,0,&owner),3);
  complete_event=CreateEventA(0,TRUE,FALSE,0);CHECK(complete_event,4);
  HANDLE thread=CreateThread(0,0,competitor,0,0,0);CHECK(thread,5);
  DWORD attempts=0;while(!phase&&attempts++<5000)Sleep(1);
  CHECK(phase==1,6);CHECK(WaitForSingleObject(thread,0)==WAIT_TIMEOUT,7);
  CHECK(WaitForSingleObject(complete_event,0)==WAIT_TIMEOUT,8);
  CHECK(UnlockFileEx(file,0,8,0,&owner),9);
  CHECK(WaitForSingleObject(thread,5000)==WAIT_OBJECT_0&&phase==2,20);
  DWORD exit=0;CHECK(GetExitCodeThread(thread,&exit)&&exit==0xc14,21);
  CHECK(CloseHandle(thread)&&CloseHandle(complete_event)&&CloseHandle(file),22);
  // Terminating a parked guest cancels its pending lock before an owner can
  // release the region, even when unlock happens immediately after termination.
  file=CreateFileA(name,GENERIC_READ|GENERIC_WRITE,7,0,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,0);
  CHECK(file!=INVALID_HANDLE_VALUE,25);
  CHECK(LockFileEx(file,LOCKFILE_EXCLUSIVE_LOCK|LOCKFILE_FAIL_IMMEDIATELY,0,8,0,&owner),26);
  complete_event=CreateEventA(0,TRUE,FALSE,0);CHECK(complete_event,27);
  phase=0;thread=CreateThread(0,0,competitor,0,0,0);CHECK(thread,28);
  attempts=0;while(!phase&&attempts++<5000)Sleep(1);CHECK(phase==1,29);
  CHECK(TerminateThread(thread,0xdead),30);
  CHECK(UnlockFileEx(file,0,8,0,&owner),31);
  CHECK(WaitForSingleObject(thread,5000)==WAIT_OBJECT_0,32);
  CHECK(GetExitCodeThread(thread,&exit)&&exit==0xdead,33);
  CHECK(WaitForSingleObject(complete_event,0)==WAIT_TIMEOUT,34);
  CHECK(LockFileEx(file,LOCKFILE_EXCLUSIVE_LOCK|LOCKFILE_FAIL_IMMEDIATELY,0,8,0,&owner),35);
  CHECK(UnlockFileEx(file,0,8,0,&owner),36);
  CHECK(CloseHandle(waiting_file)&&CloseHandle(thread)&&CloseHandle(complete_event)&&CloseHandle(file),37);
  CHECK(DeleteFileA(name),23);
  const char message[]="NATIVE FILE LOCK WAIT/EVENT PASS\n";
  CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),message,sizeof(message)-1,&written,0),24);
  ExitProcess(0);
}
