// SPDX-License-Identifier: MIT
#define _WIN32_WINNT 0x0601
#include <windows.h>

static void report(const char *text)
{
    DWORD length = 0, written;
    while (text[length]) length++;
    WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, length, &written, NULL);
}
#define CHECK(x) do { if (!(x)) { report("PROCESS SYNC FAIL\n"); ExitProcess(__LINE__); } } while (0)
static int has(const WCHAR *text, const WCHAR *part)
{
    for (; *text; text++) {
        const WCHAR *a = text, *b = part;
        while (*b && *a == *b) { a++; b++; }
        if (!*b) return 1;
    }
    return 0;
}
static PROCESS_INFORMATION spawn(const WCHAR *mode)
{
    WCHAR path[512], command[1024];
    DWORD length = GetModuleFileNameW(NULL, path, 512), n = 0;
    CHECK(length > 0 && length < 512);
    command[n++] = '"';
    for (DWORD i = 0; i < length; i++) command[n++] = path[i];
    command[n++] = '"'; command[n++] = ' ';
    while (*mode) command[n++] = *mode++;
    command[n] = 0;
    STARTUPINFOW si = {0}; PROCESS_INFORMATION pi = {0};
    si.cb = sizeof(si);
    CHECK(CreateProcessW(NULL, command, NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi));
    return pi;
}
static void join(PROCESS_INFORMATION pi)
{
    DWORD code = 999;
    CHECK(WaitForSingleObject(pi.hProcess, 15000) == WAIT_OBJECT_0);
    CHECK(GetExitCodeProcess(pi.hProcess, &code) && code == 0);
    CHECK(CloseHandle(pi.hThread) && CloseHandle(pi.hProcess));
}
static HANDLE ready, work, lock;
static void queryLock(HANDLE handle, LONG count, BYTE owned)
{
    typedef LONG (WINAPI *QUERY)(HANDLE, ULONG, void *, ULONG, ULONG *);
    QUERY query = (QUERY)(void *)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtQueryMutant");
    DWORD info[3] = {0, 0, 0xabcdef01}, size = 0;
    CHECK(query && query(handle, 0, info, 8, &size) == 0);
    CHECK(size == 8 && info[0] == (DWORD)count && ((BYTE *)info)[4] == owned && ((BYTE *)info)[5] == 0 && info[2] == 0xabcdef01);
}
static DWORD WINAPI abandonedThread(void *parameter)
{
    CHECK(WaitForSingleObject(lock, 15000) == WAIT_OBJECT_0);
    CHECK(SetEvent(ready));
    if (parameter) CHECK(WaitForSingleObject(work, INFINITE) == WAIT_OBJECT_0);
    return 0; // Deliberately exit owning the mutex.
}
static DWORD WINAPI afterMainExit(void *parameter)
{
    (void)parameter;
    CHECK(WaitForSingleObject(lock, 15000) == WAIT_ABANDONED_0);
    CHECK(ReleaseMutex(lock) && CloseHandle(lock));
    report("MAIN THREAD ABANDONMENT PASS\n");
    return 0;
}
void _start(void)
{
    const WCHAR *command = GetCommandLineW();
    if (has(command, L"--worker")) {
        ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, L"Local\\FamilyReady");
        work = OpenEventA(SYNCHRONIZE, FALSE, "FamilyWork");
        lock = OpenMutexW(MUTEX_ALL_ACCESS, FALSE, L"Local\\FamilyLock");
        HANDLE tokens = OpenSemaphoreW(SEMAPHORE_ALL_ACCESS, FALSE, L"Global\\FamilyTokens");
        CHECK(ready && work && lock && tokens);
        HANDLE alias = CreateMutexA(NULL, TRUE, "FamilyLock");
        CHECK(alias && GetLastError() == ERROR_ALREADY_EXISTS);
        queryLock(alias, -1, FALSE);
        CHECK(!ReleaseMutex(alias) && GetLastError() == ERROR_NOT_OWNER);
        CHECK(!OpenSemaphoreW(SEMAPHORE_ALL_ACCESS, FALSE, L"FamilyTokens") && GetLastError() == ERROR_INVALID_HANDLE);
        CHECK(SetEvent(ready));
        CHECK(WaitForSingleObject(work, 15000) == WAIT_OBJECT_0);
        CHECK(WaitForSingleObject(lock, 0) == WAIT_TIMEOUT);
        CHECK(SetEvent(ready));
        HANDLE list[2] = {work, tokens};
        CHECK(WaitForMultipleObjects(2, list, TRUE, 15000) == WAIT_OBJECT_0);
        CHECK(WaitForSingleObject(tokens, 0) == WAIT_OBJECT_0);
        CHECK(WaitForSingleObject(tokens, 0) == WAIT_TIMEOUT);
        CHECK(WaitForSingleObject(lock, 15000) == WAIT_OBJECT_0);
        CHECK(WaitForSingleObject(alias, 0) == WAIT_OBJECT_0);
        CHECK(ReleaseMutex(lock) && ReleaseMutex(alias));
        CHECK(!ReleaseMutex(lock) && GetLastError() == ERROR_NOT_OWNER);
        CHECK(SetEvent(ready));
        CHECK(CloseHandle(ready) && CloseHandle(work) && CloseHandle(tokens) && CloseHandle(lock) && CloseHandle(alias));
        report("CHILD IPC PASS\n"); ExitProcess(0);
    }
    if (has(command, L"--abandon") || has(command, L"--survivor")) {
        ready = OpenEventW(EVENT_MODIFY_STATE, FALSE, L"FamilyReady");
        lock = OpenMutexW(MUTEX_ALL_ACCESS, FALSE, L"FamilyLock");
        CHECK(ready && lock);
        if (has(command, L"--survivor")) {
            CHECK(SetEvent(ready));
            CHECK(WaitForSingleObject(lock, 15000) == WAIT_ABANDONED_0);
            CHECK(SetEvent(ready) && ReleaseMutex(lock));
            CHECK(CloseHandle(ready) && CloseHandle(lock));
            report("SURVIVING CHILD PASS\n");
        } else {
            CHECK(WaitForSingleObject(lock, 15000) == WAIT_OBJECT_0);
            CHECK(SetEvent(ready)); // ExitProcess abandons an owned lock.
            report("ABANDONING CHILD PASS\n");
        }
        ExitProcess(0);
    }
    if (has(command, L"--main-exit")) {
        lock = CreateMutexW(NULL, TRUE, NULL);
        CHECK(lock && CreateThread(NULL, 0, afterMainExit, NULL, 0, NULL));
        ExitThread(0);
    }
    ready = CreateEventW(NULL, FALSE, FALSE, L"FamilyReady");
    work = CreateEventW(NULL, FALSE, FALSE, L"Local\\FamilyWork");
    lock = CreateMutexExW(NULL, L"FamilyLock", CREATE_MUTEX_INITIAL_OWNER, MUTEX_ALL_ACCESS);
    CHECK(ready && work && lock && GetLastError() == 0);
    if (has(command, L"--detached")) {
        PROCESS_INFORMATION pi = spawn(L"--survivor");
        CHECK(WaitForSingleObject(ready, 15000) == WAIT_OBJECT_0);
        CHECK(CloseHandle(pi.hProcess) && CloseHandle(pi.hThread));
        report("PARENT IPC EXIT\n"); ExitProcess(0);
    }
    if (has(command, L"--hold")) {
        report("IPC PARKED\n");
        CHECK(WaitForSingleObject(work, INFINITE) == WAIT_OBJECT_0);
    }
    HANDLE tokens = CreateSemaphoreW(NULL, 0, 2, L"Global\\FamilyTokens");
    HANDLE local = CreateEventW(NULL, TRUE, TRUE, L"Local\\FamilyTokens");
    CHECK(tokens && local);
    CHECK(!CreateEventW(NULL, TRUE, TRUE, L"FamilyLock") && GetLastError() == ERROR_INVALID_HANDLE);
    CHECK(WaitForSingleObject(lock, 0) == WAIT_OBJECT_0); // Recursion depth two.
    queryLock(lock, -1, TRUE);
    PROCESS_INFORMATION pi = spawn(L"--worker");
    CHECK(WaitForSingleObject(ready, 15000) == WAIT_OBJECT_0);
    CHECK(ReleaseMutex(lock) && SetEvent(work)); // Child must still be blocked.
    CHECK(WaitForSingleObject(ready, 15000) == WAIT_OBJECT_0);
    CHECK(ReleaseMutex(lock));
    CHECK(ReleaseSemaphore(tokens, 2, NULL) && SetEvent(work));
    CHECK(WaitForSingleObject(ready, 15000) == WAIT_OBJECT_0);
    join(pi);
    CHECK(!ReleaseMutex(lock) && GetLastError() == ERROR_NOT_OWNER);
    for (int forced = 0; forced < 2; forced++) {
        HANDLE thread = CreateThread(NULL, 0, abandonedThread, (void *)(ULONG_PTR)forced, 0, NULL);
        CHECK(thread && WaitForSingleObject(ready, 15000) == WAIT_OBJECT_0);
        if (forced) CHECK(TerminateThread(thread, 0));
        CHECK(WaitForSingleObject(thread, 15000) == WAIT_OBJECT_0);
        HANDLE list[2] = {work, lock};
        CHECK(WaitForMultipleObjects(2, list, FALSE, 15000) == WAIT_ABANDONED_0 + 1);
        CHECK(WaitForSingleObject(lock, 0) == WAIT_OBJECT_0);
        CHECK(ReleaseMutex(lock) && ReleaseMutex(lock) && CloseHandle(thread));
    }
    pi = spawn(L"--abandon");
    CHECK(WaitForSingleObject(ready, 15000) == WAIT_OBJECT_0);
    CHECK(WaitForSingleObject(lock, 15000) == WAIT_ABANDONED_0);
    CHECK(ReleaseMutex(lock)); join(pi);
    CHECK(CloseHandle(ready) && CloseHandle(work) && CloseHandle(lock) && CloseHandle(tokens) && CloseHandle(local));
    CHECK(!OpenMutexW(MUTEX_ALL_ACCESS, FALSE, L"FamilyLock") && GetLastError() == ERROR_FILE_NOT_FOUND);
    report("PROCESS SYNC PASS\n"); ExitProcess(0);
}
