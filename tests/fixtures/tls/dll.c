/* Original freestanding PE TLS fixture; no runtime library is required. */
typedef unsigned long DWORD;
typedef int BOOL;
typedef void *PVOID;
typedef void *HANDLE;

#define CALLBACK __attribute__((stdcall))
#define EXPORT __attribute__((dllexport))

extern HANDLE CALLBACK __attribute__((dllimport)) GetStdHandle(DWORD);
extern BOOL CALLBACK __attribute__((dllimport)) WriteFile(
    HANDLE, const void *, DWORD, DWORD *, PVOID);

volatile DWORD dllTlsTemplateValue __attribute__((section(".tls$AAA"))) = 0xa1b2c3d4;
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

volatile DWORD RejectAttach = 0x1234abcd;
volatile DWORD events[16];
volatile DWORD eventCount;

static void CALLBACK record(DWORD value) {
  if (eventCount < 16) events[eventCount++] = value;
}

static void CALLBACK tlsCallbackOne(PVOID module, DWORD reason, PVOID reserved) {
  (void)module;
  (void)reserved;
  if (reserved) record(91);
  else if (reason == 1) record(1);
  else if (reason == 0) record(6);
}

static void CALLBACK tlsCallbackTwo(PVOID module, DWORD reason, PVOID reserved) {
  (void)module;
  (void)reserved;
  if (reserved) record(92);
  else if (reason == 1) record(2);
  else if (reason == 0) record(7);
}

/* The linker sorts these records into the image TLS callback array. */
__attribute__((section(".CRT$XLA"), used)) void(CALLBACK *const tlsFirst[])(PVOID, DWORD, PVOID) = {0};
__attribute__((section(".CRT$XLB"), used)) void(CALLBACK *const tlsCallbacks[])(PVOID, DWORD, PVOID) = {
  tlsCallbackOne, tlsCallbackTwo, 0};

IMAGE_TLS_DIRECTORY32 _tls_used __attribute__((section(".rdata$T"), used)) = {
  (DWORD)&__tls_start__, (DWORD)&__tls_end__, (DWORD)&_tls_index,
  (DWORD)tlsCallbacks, 8, 0};

EXPORT DWORD GetTlsValue(void) { return tlsBlock()[0]; }
EXPORT void SetTlsValue(DWORD value) { tlsBlock()[0] = value; }
EXPORT void RecordTlsEvent(DWORD value) { record(value); }
EXPORT DWORD GetTlsEventCount(void) { return eventCount; }
EXPORT DWORD GetTlsEvent(DWORD index) { return index < eventCount ? events[index] : 0xffffffff; }

BOOL CALLBACK DllMain(PVOID module, DWORD reason, PVOID reserved) {
  (void)module;
  (void)reserved;
  if (reason == 1) {
    if (eventCount != 2 || events[0] != 1 || events[1] != 2) return 0;
    record(3);
    return RejectAttach == 0xdeadbeef ? 0 : 1;
  }
  if (reason == 0) {
    char output[32] = "TLS events:";
    DWORD length = 11;
    DWORD written = 0;
    record(8);
    for (DWORD index = 0; index < eventCount; ++index)
      output[length++] = (char)('0' + events[index]);
    output[length++] = '\r';
    output[length++] = '\n';
    WriteFile(GetStdHandle((DWORD)-11), output, length, &written, 0);
  }
  return 1;
}
