#define _WIN32_WINNT 0x0601
#include <windows.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
static HANDLE gate, ready[2], finished, sleeping;
static volatile DWORD phases[2], tids[2], tebs[2];
#ifdef NATIVE_TEST
static DWORD tls_index, fls_index;
static volatile DWORD fls_sum;
static void WINAPI cleanup_fls(void *value) { fls_sum += (DWORD)value; }
#endif
__declspec(dllexport) DWORD WINAPI SimpleWorker(void *parameter)
{
    Sleep(1);
    return (DWORD)parameter;
}
static DWORD fs(DWORD offset) { DWORD value; __asm__("movl %%fs:(%1), %0" : "=r"(value) : "r"(offset)); return value; }
static DWORD WINAPI work(void *parameter)
{
    DWORD index = (DWORD)parameter;
    tids[index] = GetCurrentThreadId();
    tebs[index] = fs(0x18);
    CHECK(tids[index] == fs(0x24) && tebs[index] != 0);
    DWORD local = 0;
    CHECK((DWORD)&local >= fs(8) && (DWORD)&local < fs(4));
    SetLastError(0x100 + index);
#ifdef NATIVE_TEST
    CHECK(TlsGetValue(tls_index) == NULL);
    CHECK(TlsSetValue(tls_index, (void *)(0x100 + index)));
    CHECK(FlsSetValue(fls_index, (void *)(index + 1)));
    SetLastError(0x100 + index);
#endif
    CHECK(SetEvent(ready[index]));
    CHECK(WaitForSingleObject(gate, INFINITE) == WAIT_OBJECT_0);
    CHECK(GetLastError() == 0x100 + index && fs(0x34) == 0x100 + index);
#ifdef NATIVE_TEST
    CHECK((DWORD)TlsGetValue(tls_index) == 0x100 + index);
#endif
    phases[index] = 1;
    DWORD spins = 0;
    while (!phases[1 - index]) CHECK(++spins < 10000000);
    if (index) ExitThread(22);
    return 21;
}
static DWORD WINAPI closed(void *unused)
{
    (void)unused;
    CHECK(WaitForSingleObject(gate, INFINITE) == WAIT_OBJECT_0);
    CHECK(SetEvent(finished));
    return 23;
}
static DWORD WINAPI abandoned(void *unused)
{
    (void)unused;
    CHECK(SetEvent(sleeping));
    CHECK(WaitForSingleObject(gate, INFINITE) == WAIT_OBJECT_0);
    ExitProcess(250); /* must never run after the process exits */
    return 0;
}
void start(void)
{
#ifdef NATIVE_TEST
    tls_index = TlsAlloc();
    fls_index = FlsAlloc(cleanup_fls);
    CHECK(tls_index != TLS_OUT_OF_INDEXES && fls_index != FLS_OUT_OF_INDEXES);
    CHECK(TlsSetValue(tls_index, (void *)0xabcdef));
#endif
    gate = CreateEventA(NULL, TRUE, FALSE, NULL);
    ready[0] = CreateEventA(NULL, TRUE, FALSE, NULL);
    ready[1] = CreateEventA(NULL, TRUE, FALSE, NULL);
    CHECK(gate && ready[0] && ready[1]);
    DWORD ids[2] = {0}, code = 0;
    HANDLE workers[2];
    workers[0] = CreateThread(NULL, 0, work, (void *)0, CREATE_SUSPENDED, &ids[0]);
    workers[1] = CreateThread(NULL, 0, work, (void *)1, CREATE_SUSPENDED, &ids[1]);
    CHECK(workers[0] && workers[1] && ids[0] != ids[1] && ids[0] != GetCurrentThreadId());
    CHECK(GetThreadId(workers[0]) == ids[0]);
    CHECK(GetExitCodeThread(workers[0], &code) && code == STILL_ACTIVE);
    CHECK(GetThreadPriority(workers[0]) == THREAD_PRIORITY_NORMAL);
    CHECK(SetThreadPriority(workers[0], THREAD_PRIORITY_HIGHEST));
    CHECK(GetThreadPriority(workers[0]) == THREAD_PRIORITY_HIGHEST);
    CHECK(SetThreadPriority(workers[0], THREAD_PRIORITY_NORMAL));
    CHECK(WaitForSingleObject(workers[0], 0) == WAIT_TIMEOUT);
    CHECK(SuspendThread(workers[0]) == 1);
    CHECK(ResumeThread(workers[0]) == 2 && ResumeThread(workers[0]) == 1 && ResumeThread(workers[0]) == 0);
    CHECK(ResumeThread(workers[1]) == 1);
    SetLastError(0x1234);
    CHECK(WaitForMultipleObjects(2, ready, TRUE, 5000) == WAIT_OBJECT_0);
    CHECK(GetLastError() == 0x1234);
    CHECK(tids[0] == ids[0] && tids[1] == ids[1] && tebs[0] != tebs[1] && tebs[0] != fs(0x18));
    CHECK(SetEvent(gate));
    CHECK(WaitForMultipleObjects(2, workers, TRUE, 5000) == WAIT_OBJECT_0);
    CHECK(GetExitCodeThread(workers[0], &code) && code == 21);
    CHECK(GetExitCodeThread(workers[1], &code) && code == 22);
#ifdef NATIVE_TEST
    CHECK(fls_sum == 3 && (DWORD)TlsGetValue(tls_index) == 0xabcdef);
    CHECK(TlsFree(tls_index) && FlsFree(fls_index));
#endif
    CHECK(WaitForSingleObject(workers[0], 0) == WAIT_OBJECT_0);
    CHECK(CloseHandle(workers[0]) && CloseHandle(workers[1]));
    CHECK(!GetExitCodeThread(workers[0], &code) && GetLastError() == ERROR_INVALID_HANDLE);
    finished = CreateEventW(NULL, FALSE, FALSE, NULL);
    CHECK(ResetEvent(gate));
    HANDLE detached = CreateThread(NULL, 0, closed, NULL, 0, NULL);
    CHECK(detached && CloseHandle(detached));
    CHECK(SetEvent(gate));
    CHECK(WaitForSingleObject(finished, 5000) == WAIT_OBJECT_0);
    CHECK(ResetEvent(gate));
    sleeping = CreateEventA(NULL, TRUE, FALSE, NULL);
    HANDLE pending = CreateThread(NULL, 0, abandoned, NULL, 0, NULL);
    CHECK(pending && WaitForSingleObject(sleeping, 5000) == WAIT_OBJECT_0);
    CHECK(WaitForSingleObject(pending, 0) == WAIT_TIMEOUT);
    ExitProcess(0);
}
