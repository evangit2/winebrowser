#include <windows.h>
#include <mmsystem.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
static ULONGLONG shared_time(DWORD offset) {
    volatile const DWORD *p = (volatile const DWORD *)(0x7ffe0000 + offset);
    DWORD high, low;
    do { high = p[1]; low = p[0]; } while (high != p[2]);
    return ((ULONGLONG)high << 32) | low;
}
void start(void) {
    ULONGLONG before = GetTickCount64();
    ULONGLONG direct = shared_time(0x320);
    ULONGLONG after = GetTickCount64();
    CHECK(before <= direct && direct <= after);
    CHECK(*(volatile const DWORD *)0x7ffe0004 == (1u << 24));
    DWORD legacy = GetTickCount();
    DWORD winmm = timeGetTime();
    direct = shared_time(0x320);
    CHECK((DWORD)(winmm - legacy) < 10000 && (DWORD)((DWORD)direct - winmm) < 10000);
    before = shared_time(8);
    direct = shared_time(0x320);
    after = shared_time(8);
    CHECK(before <= direct * 10000 + 9999 && direct * 10000 <= after);
    CHECK(shared_time(0x20) == 0); /* UTC, same as the NT timezone provider. */
    CHECK(shared_time(0x14) > 116444736000000000ULL); /* FILETIME after 1970. */
    CHECK(*(volatile const ULONGLONG *)0x7ffe0300 == 1000000000ULL);
    for (DWORD i = 0; i < 64; ++i)
        CHECK(*(volatile const BYTE *)(0x7ffe0274 + i) == (i == 8));
    ExitProcess(0);
}
