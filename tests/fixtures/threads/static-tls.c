#define _WIN32_WINNT 0x0601
#include <windows.h>
#define CHECK(c) do { if (!(c)) ExitProcess(__LINE__); } while(0)
volatile DWORD template_value __attribute__((section(".tls$AAA"))) = 0x12345678;
DWORD _tls_index;
extern unsigned char __tls_start__, __tls_end__;
static volatile DWORD attached, detached, failures, fls_sum;
static DWORD tls_slot, fls_slot;
static DWORD (WINAPI *dll_worker)(void *);
static DWORD (WINAPI *counts)(void);
static volatile DWORD *block(void) {
 DWORD *vector; __asm__("movl %%fs:0x2c, %0" : "=r"(vector));
 return (volatile DWORD *)vector[_tls_index];
}
static void WINAPI callback(void *module,DWORD reason,void *reserved) {
 (void)module;(void)reserved;
 if (reason == DLL_PROCESS_ATTACH) block()[1]=1;
 if (reason == DLL_THREAD_ATTACH) {
  if(block()[0]!=0x12345678 || block()[1] || block()[2]) failures++;
  if(!counts || (counts()>>8)!=attached+1) failures++;
  block()[1]=2;attached++;
 }
 if(reason == DLL_THREAD_DETACH) {
  if(block()[1]!=2 || (counts()&255)!=detached+1) failures++;
  block()[1]=3;detached++;
 }
}
__attribute__((section(".CRT$XLB"),used)) PIMAGE_TLS_CALLBACK callbacks[]={callback,0};
IMAGE_TLS_DIRECTORY32 _tls_used __attribute__((section(".rdata$T"),used))={
 (DWORD)&__tls_start__,(DWORD)&__tls_end__,(DWORD)&_tls_index,(DWORD)callbacks,8,0
};
static void WINAPI cleanup(void *value) {
 if(block()[1]!=2 || block()[0]!=(DWORD)value) failures++;
 fls_sum+=(DWORD)value;
}
static DWORD WINAPI worker(void *value) {
 CHECK(block()[0]==0x12345678 && block()[1]==2 && !block()[2]);
 CHECK(TlsGetValue(tls_slot)==0 && FlsGetValue(fls_slot)==0);
 CHECK(TlsSetValue(tls_slot,value) && FlsSetValue(fls_slot,value));
 block()[0]=(DWORD)value;
 CHECK(dll_worker(value)==(DWORD)value+1);
 CHECK(block()[0]==(DWORD)value && block()[1]==2);
 CHECK(TlsGetValue(tls_slot)==value);
 if((DWORD)value&1) ExitThread((DWORD)value+10);
 return (DWORD)value+10;
}
void start(void) {
 CHECK(block()[0]==0x12345678 && block()[1]==1 && !block()[2]);
 HMODULE dll=LoadLibraryA("thread-tls.dll");CHECK(dll);
 dll_worker=(void*)GetProcAddress(dll,"ProbeWorker@4");
 counts=(void*)GetProcAddress(dll,"Counts@0");
 DWORD (WINAPI *dll_failures)(void)=(void*)GetProcAddress(dll,"Failures@0");
 DWORD (WINAPI *main_value)(void)=(void*)GetProcAddress(dll,"MainValue@0");
 CHECK(dll_worker && counts && dll_failures && main_value);
 tls_slot=TlsAlloc();fls_slot=FlsAlloc(cleanup);
 CHECK(tls_slot!=TLS_OUT_OF_INDEXES && fls_slot!=FLS_OUT_OF_INDEXES);
 CHECK(TlsSetValue(tls_slot,(void*)0xabcdef));
 for(DWORD wave=0;wave<2;wave++) {
  HANDLE threads[2];DWORD code;
  for(DWORD i=0;i<2;i++) {threads[i]=CreateThread(0,0,worker,(void*)(1+wave*2+i),0,0);CHECK(threads[i]);}
  CHECK(WaitForMultipleObjects(2,threads,TRUE,5000)==WAIT_OBJECT_0);
  for(DWORD i=0;i<2;i++) {CHECK(GetExitCodeThread(threads[i],&code) && code==11+wave*2+i);CHECK(CloseHandle(threads[i]));}
 }
 CHECK(attached==4 && detached==4 && !failures && fls_sum==10);
 CHECK(counts()==0x404 && !dll_failures() && main_value()==0xa1b2c3d4);
 CHECK(block()[0]==0x12345678 && block()[1]==1 && (DWORD)TlsGetValue(tls_slot)==0xabcdef);
 CHECK(TlsFree(tls_slot) && FlsFree(fls_slot));
 CHECK(FreeLibrary(dll));
 DWORD written;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),"static-tls-ok\n",14,&written,0)&&written==14);
 ExitProcess(0);
}
