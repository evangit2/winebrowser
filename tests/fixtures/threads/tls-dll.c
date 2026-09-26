#include <windows.h>
volatile DWORD template_value __attribute__((section(".tls$AAA"))) = 0xa1b2c3d4;
DWORD _tls_index;
extern unsigned char __tls_start__, __tls_end__;
static volatile DWORD attached, detached, failures;
static volatile DWORD *block(void) {
    DWORD *vector;
    __asm__("movl %%fs:0x2c, %0" : "=r"(vector));
    return (volatile DWORD *)vector[_tls_index];
}
static void WINAPI callback(void *module, DWORD reason, void *reserved) {
    (void)module; (void)reserved;
    if (reason == DLL_THREAD_ATTACH) block()[1] = 2;
    if (reason == DLL_THREAD_DETACH) block()[1] = 3;
}
__attribute__((section(".CRT$XLB"), used)) PIMAGE_TLS_CALLBACK callbacks[] = { callback, 0 };
IMAGE_TLS_DIRECTORY32 _tls_used __attribute__((section(".rdata$T"), used)) = {
    (DWORD)&__tls_start__, (DWORD)&__tls_end__, (DWORD)&_tls_index, (DWORD)callbacks, 8, 0
};
BOOL WINAPI DllMain(void *module, DWORD reason, void *reserved) {
    (void)module; (void)reserved;
    if (reason == DLL_THREAD_ATTACH) { if (block()[1] != 2) failures++; attached++; }
    if (reason == DLL_THREAD_DETACH) { if (block()[1] != 3) failures++; detached++; }
    return TRUE;
}
__declspec(dllexport) DWORD WINAPI ProbeWorker(void *parameter) {
    if (block()[0] != 0xa1b2c3d4 || block()[1] != 2 || block()[2] != 0) return 251;
    block()[0] = (DWORD)parameter;
    Sleep(1);
    if (block()[0] != (DWORD)parameter) return 252;
    return (DWORD)parameter + 1;
}
__declspec(dllexport) DWORD WINAPI Counts(void) { return attached * 256 + detached; }
__declspec(dllexport) DWORD WINAPI Failures(void) { return failures; }
__declspec(dllexport) DWORD WINAPI MainValue(void) { return block()[0]; }
