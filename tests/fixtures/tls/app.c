/* Original freestanding PE TLS fixture; no runtime library is required. */
typedef unsigned long DWORD;
typedef void *PVOID;

#define CALLBACK __attribute__((stdcall))
#define IMPORT __attribute__((dllimport))

extern DWORD IMPORT GetTlsValue(void);
extern void IMPORT SetTlsValue(DWORD value);
extern void IMPORT RecordTlsEvent(DWORD value);
extern DWORD IMPORT GetTlsEventCount(void);
extern DWORD IMPORT GetTlsEvent(DWORD index);
extern void CALLBACK ExitProcess(DWORD code) __attribute__((noreturn, dllimport));

volatile DWORD appTlsTemplateValue __attribute__((section(".tls$AAA"))) = 0x12345678;
DWORD _tls_index;
extern unsigned char __tls_start__, __tls_end__;

typedef struct {
  DWORD startAddressOfRawData;
  DWORD endAddressOfRawData;
  DWORD addressOfIndex;
  DWORD addressOfCallbacks;
  DWORD sizeOfZeroFill;
  DWORD characteristics;
} IMAGE_TLS_DIRECTORY32;

static volatile DWORD *tlsBlock(void) {
  DWORD *vector;
  __asm__ volatile("movl %%fs:0x2c, %0" : "=r"(vector));
  return (volatile DWORD *)vector[_tls_index];
}

static void CALLBACK appTlsCallback(PVOID module, DWORD reason, PVOID reserved) {
  (void)module;
  (void)reserved;
  if (reserved) RecordTlsEvent(94);
  else if (reason == 1) RecordTlsEvent(4);
  else if (reason == 0) RecordTlsEvent(5);
}

__attribute__((section(".CRT$XLA"), used)) void(CALLBACK *const tlsFirst[])(PVOID, DWORD, PVOID) = {0};
__attribute__((section(".CRT$XLB"), used)) void(CALLBACK *const tlsCallbacks[])(PVOID, DWORD, PVOID) = {
  appTlsCallback, 0};

IMAGE_TLS_DIRECTORY32 _tls_used __attribute__((section(".rdata$T"), used)) = {
  (DWORD)&__tls_start__, (DWORD)&__tls_end__, (DWORD)&_tls_index,
  (DWORD)tlsCallbacks, 8, 0};

void __attribute__((noreturn)) _start(void) {
  if (tlsBlock()[0] != 0x12345678 || tlsBlock()[1] || tlsBlock()[2]) ExitProcess(1);
  if (GetTlsValue() != 0xa1b2c3d4) ExitProcess(2);
  if (GetTlsEventCount() != 4) ExitProcess(3);
  for (DWORD index = 0; index < 4; index++)
    if (GetTlsEvent(index) != index + 1) ExitProcess(4 + index);

  tlsBlock()[0] = 0x87654321;
  SetTlsValue(0x4a3b2c1d);
  if (tlsBlock()[0] != 0x87654321 || GetTlsValue() != 0x4a3b2c1d) ExitProcess(8);
  RecordTlsEvent(9);
  ExitProcess(0);
}
