#define _WIN32_WINNT 0x0601
#include <windows.h>
static DWORD WINAPI work(void *parameter)
{
    (void)parameter;
    Sleep(1);
#if CASE == 0
    ExitProcess(77);
#elif CASE == 2
    __asm__("ud2");
#endif
    return 77;
}
void start(void)
{
    HANDLE worker = CreateThread(NULL, 0, work, NULL, 0, NULL);
    if (!worker) ExitProcess(251);
#if CASE == 1
    ExitThread(33);
#else
    WaitForSingleObject(worker, INFINITE);
    ExitProcess(252);
#endif
}
