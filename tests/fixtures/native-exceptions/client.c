/* Original MIT contract fixture: native Wine SEH search and continuation. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(__LINE__); } while (0)
static volatile unsigned searched,handled;
typedef EXCEPTION_DISPOSITION (__cdecl *HANDLER)(EXCEPTION_RECORD*,void*,CONTEXT*,void*);
typedef struct FRAME { struct FRAME *next; HANDLER handler; } FRAME;
static EXCEPTION_DISPOSITION __cdecl search(EXCEPTION_RECORD *record,void *frame,CONTEXT *context,void *dispatcher) {
  (void)frame;(void)context;(void)dispatcher;
  CHECK(record->ExceptionCode==0xe1234242);searched++;return ExceptionContinueSearch;
}
static EXCEPTION_DISPOSITION __cdecl accept_exception(EXCEPTION_RECORD *record,void *frame,CONTEXT *context,void *dispatcher) {
  (void)frame;(void)dispatcher;
  CHECK(record->ExceptionCode==0xe1234242&&record->NumberParameters==2);
  CHECK(record->ExceptionInformation[0]==0x12345678&&record->ExceptionInformation[1]==0xabcdef01);
  CHECK(!(record->ExceptionFlags&EXCEPTION_NONCONTINUABLE));CHECK(context->ContextFlags&CONTEXT_CONTROL);
  handled++;return ExceptionContinueExecution;
}
void start(void) {
  FRAME first,second;ULONG_PTR args[2]={0x12345678,0xabcdef01};
  __asm__ volatile("movl %%fs:0,%0":"=r"(first.next));first.handler=accept_exception;
  second.next=&first;second.handler=search;
  __asm__ volatile("movl %0,%%fs:0"::"r"(&second):"memory");
  RaiseException(0xe1234242,0,2,args);
  CHECK(searched==1&&handled==1);
  RaiseException(0xe1234242,0,2,args);CHECK(searched==2&&handled==2);
  __asm__ volatile("movl %0,%%fs:0"::"r"(first.next):"memory");
  ExitProcess(0);
}
