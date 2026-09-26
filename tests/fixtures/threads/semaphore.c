#include <windows.h>
#define CHECK(c) do { if (!(c)) ExitProcess(__LINE__); } while (0)
static HANDLE gate, ready, done;
static DWORD WINAPI worker(void *value) {
    (void)value;
    CHECK(ReleaseSemaphore(ready, 1, 0));
    CHECK(WaitForSingleObject(gate, 5000) == WAIT_OBJECT_0);
    CHECK(ReleaseSemaphore(done, 1, 0));
    return 37;
}
void start(void) {
    LONG previous = -1;
    HANDLE original = CreateSemaphoreA(0, 1, 3, "CountingGate");
    CHECK(original);
    HANDLE alias = CreateSemaphoreW(0, 0, 8, L"Local\\CountingGate");
    CHECK(alias && GetLastError() == ERROR_ALREADY_EXISTS);
    CHECK(WaitForSingleObject(alias, 0) == WAIT_OBJECT_0);
    CHECK(WaitForSingleObject(original, 0) == WAIT_TIMEOUT);
    CHECK(ReleaseSemaphore(alias, 3, &previous) && previous == 0);
    previous = -1;
    CHECK(!ReleaseSemaphore(original, 1, &previous));
    CHECK(GetLastError() == ERROR_TOO_MANY_POSTS && previous == -1);
    HANDLE restricted = OpenSemaphoreW(SYNCHRONIZE, FALSE, L"CountingGate");
    CHECK(restricted && !ReleaseSemaphore(restricted, 1, 0) && GetLastError() == ERROR_ACCESS_DENIED);
    for (int i = 0; i < 3; i++) CHECK(WaitForSingleObject(restricted, 0) == WAIT_OBJECT_0);
    CHECK(WaitForSingleObject(alias, 0) == WAIT_TIMEOUT);
    CHECK(!CreateEventW(0, FALSE, FALSE, L"CountingGate") && GetLastError() == ERROR_INVALID_HANDLE);
    CHECK(DuplicateHandle(GetCurrentProcess(), original, GetCurrentProcess(), &gate, 0, FALSE, DUPLICATE_SAME_ACCESS));
    CHECK(CloseHandle(original) && CloseHandle(alias) && CloseHandle(restricted));
    ready = CreateSemaphoreExA(0, 0, 3, 0, 0, SEMAPHORE_ALL_ACCESS);
    done = CreateSemaphoreExW(0, 0, 3, 0, 0, SEMAPHORE_ALL_ACCESS);
    CHECK(ready && done);
    HANDLE threads[3];
    for (int i = 0; i < 3; i++) { threads[i] = CreateThread(0, 0, worker, 0, 0, 0); CHECK(threads[i]); }
    for (int i = 0; i < 3; i++) CHECK(WaitForSingleObject(ready, 5000) == WAIT_OBJECT_0);
    CHECK(ReleaseSemaphore(gate, 2, &previous) && previous == 0);
    for (int i = 0; i < 2; i++) CHECK(WaitForSingleObject(done, 5000) == WAIT_OBJECT_0);
    CHECK(WaitForSingleObject(done, 0) == WAIT_TIMEOUT);
    CHECK(ReleaseSemaphore(gate, 1, 0));
    CHECK(WaitForSingleObject(done, 5000) == WAIT_OBJECT_0);
    CHECK(WaitForMultipleObjects(3, threads, TRUE, 5000) == WAIT_OBJECT_0);
    for (int i = 0; i < 3; i++) { DWORD code; CHECK(GetExitCodeThread(threads[i], &code) && code == 37); CHECK(CloseHandle(threads[i])); }
    HANDLE event = CreateEventA(0, FALSE, FALSE, 0), pair[2] = {gate, event};
    CHECK(event && ReleaseSemaphore(gate, 1, 0));
    CHECK(WaitForMultipleObjects(2, pair, TRUE, 0) == WAIT_TIMEOUT);
    CHECK(WaitForSingleObject(gate, 0) == WAIT_OBJECT_0);
    CHECK(ReleaseSemaphore(gate, 1, 0) && SetEvent(event));
    CHECK(WaitForMultipleObjects(2, pair, TRUE, 0) == WAIT_OBJECT_0);
    CHECK(WaitForSingleObject(gate, 0) == WAIT_TIMEOUT && WaitForSingleObject(event, 0) == WAIT_TIMEOUT);
    CHECK(SignalObjectAndWait(gate, gate, 0, FALSE) == WAIT_OBJECT_0);
    CHECK(CloseHandle(gate) && CloseHandle(ready) && CloseHandle(done) && CloseHandle(event));
    CHECK(!OpenSemaphoreA(SEMAPHORE_ALL_ACCESS, FALSE, "CountingGate") && GetLastError() == ERROR_FILE_NOT_FOUND);
    DWORD written; CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "semaphore-ok\n", 13, &written, 0));
    ExitProcess(0);
}
