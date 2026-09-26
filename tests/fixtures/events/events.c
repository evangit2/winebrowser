#define _WIN32_WINNT 0x0601
#include <windows.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
void *memset(void *target, int value, size_t size)
{
    volatile unsigned char *bytes = target;
    while (size--) *bytes++ = (unsigned char)value;
    return target;
}
void start(void)
{
    HANDLE automatic = CreateEventA(NULL, FALSE, TRUE, NULL);
    HANDLE manual = CreateEventW(NULL, TRUE, FALSE, L"Local\\WineBrowserEvent");
    CHECK(automatic && manual && GetLastError() == 0);
    CHECK(WaitForSingleObject(automatic, 0) == WAIT_OBJECT_0);
    CHECK(WaitForSingleObject(automatic, 0) == WAIT_TIMEOUT);
    CHECK(SetEvent(automatic) && SetEvent(automatic));
    CHECK(WaitForSingleObjectEx(automatic, 0, TRUE) == WAIT_OBJECT_0);
    CHECK(WaitForSingleObject(automatic, 0) == WAIT_TIMEOUT);
    CHECK(SetEvent(manual));
    CHECK(WaitForSingleObject(manual, 0) == WAIT_OBJECT_0);
    CHECK(WaitForSingleObject(manual, 0) == WAIT_OBJECT_0);
    HANDLE again = CreateEventA(NULL, FALSE, FALSE, "WineBrowserEvent");
    CHECK(again && again != manual && GetLastError() == ERROR_ALREADY_EXISTS);
    CHECK(WaitForSingleObject(again, 0) == WAIT_OBJECT_0);
    CHECK(ResetEvent(again));
    CHECK(WaitForSingleObject(manual, 0) == WAIT_TIMEOUT);
    HANDLE wait_only = OpenEventW(SYNCHRONIZE, FALSE, L"Local\\WineBrowserEvent");
    CHECK(wait_only && !SetEvent(wait_only) && GetLastError() == ERROR_ACCESS_DENIED);
    CHECK(SetEvent(again));
    CHECK(WaitForSingleObject(wait_only, 0) == WAIT_OBJECT_0);
    CHECK(ResetEvent(manual));
    HANDLE list[2] = {automatic, manual};
    CHECK(SetEvent(automatic));
    CHECK(WaitForMultipleObjects(2, list, TRUE, 0) == WAIT_TIMEOUT);
    CHECK(WaitForSingleObject(automatic, 0) == WAIT_OBJECT_0);
    CHECK(SetEvent(automatic) && SetEvent(manual));
    CHECK(WaitForMultipleObjectsEx(2, list, TRUE, 0, TRUE) == WAIT_OBJECT_0);
    CHECK(WaitForSingleObject(automatic, 0) == WAIT_TIMEOUT);
    CHECK(WaitForMultipleObjects(2, list, FALSE, 0) == WAIT_OBJECT_0 + 1);
    CHECK(ResetEvent(manual));
    DWORD before = GetTickCount();
    CHECK(WaitForMultipleObjects(2, list, FALSE, 20) == WAIT_TIMEOUT);
    CHECK(GetTickCount() - before >= 15);
    CHECK(SignalObjectAndWait(automatic, automatic, 0, FALSE) == WAIT_OBJECT_0);
    CHECK(WaitForSingleObject(automatic, 0) == WAIT_TIMEOUT);
    CHECK(PulseEvent(manual));
    CHECK(WaitForSingleObject(manual, 0) == WAIT_TIMEOUT);
    HANDLE global = CreateEventExW(NULL, L"Global\\WineBrowserEvent", CREATE_EVENT_INITIAL_SET, EVENT_ALL_ACCESS);
    CHECK(global && GetLastError() == 0);
    CHECK(WaitForSingleObject(global, 0) == WAIT_OBJECT_0);
    CHECK(WaitForSingleObject(manual, 0) == WAIT_TIMEOUT);
#ifdef NATIVE_TEST
    HMODULE ntdll = GetModuleHandleA("ntdll.dll");
    CHECK(ntdll && ntdll == GetModuleHandleW(L"ntdll.dll") && ntdll != GetModuleHandleA(NULL));
    typedef LONG (WINAPI *QUERY)(HANDLE, ULONG, void *, ULONG, ULONG *);
    typedef LONG (WINAPI *CHANGE)(HANDLE, LONG *);
    QUERY query = (QUERY)(void *)GetProcAddress(ntdll, "NtQueryEvent");
    CHANGE set = (CHANGE)(void *)GetProcAddress(ntdll, "NtSetEvent");
    CHECK(ntdll && query && set);
    typedef LONG (WINAPI *ACTIVE)(void **);
    ACTIVE active = (ACTIVE)(void *)GetProcAddress(ntdll, "RtlGetActiveActivationContext");
    void *context = (void *)0xdeadbeef;
    CHECK(active && active(&context) == 0 && !context);
    DWORD info[3] = {0, 0, 0xabcdef01}, size = 0;
    CHECK(query(manual, 0, info, 8, &size) == 0 && size == 8 && info[0] == 0 && info[1] == 0 && info[2] == 0xabcdef01);
    LONG previous = 99;
    CHECK(set(manual, &previous) == 0 && previous == 0);
    CHECK(set(manual, &previous) == 0 && previous == 1);
    CHECK(WaitForSingleObject(wait_only, 0) == WAIT_OBJECT_0);
    CHECK(query(automatic, 0, info, 8, &size) == 0 && info[0] == 1 && info[1] == 0);
#endif
    CHECK(CloseHandle(global) && CloseHandle(automatic));
    CHECK(!CloseHandle(automatic) && GetLastError() == ERROR_INVALID_HANDLE);
    CHECK(CloseHandle(manual) && CloseHandle(again) && CloseHandle(wait_only));
    CHECK(!OpenEventA(EVENT_ALL_ACCESS, FALSE, "WineBrowserEvent") && GetLastError() == ERROR_FILE_NOT_FOUND);
    HANDLE fresh = CreateEventW(NULL, FALSE, TRUE, L"WineBrowserEvent");
    CHECK(fresh && GetLastError() == 0);
    CHECK(WaitForSingleObject(fresh, 0) == WAIT_OBJECT_0 && WaitForSingleObject(fresh, 0) == WAIT_TIMEOUT);
    CHECK(CloseHandle(fresh));
    ExitProcess(0);
}
