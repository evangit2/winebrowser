#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <winternl.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
static unsigned char payload[65573];
static unsigned char expected(unsigned i) { return (unsigned char)(i * 7 + 31); }
static void verify(const unsigned char *bytes, unsigned offset, unsigned size)
{
    for (unsigned i = 0; i < size; ++i) CHECK(bytes[i] == expected(offset + i));
}
void start(void)
{
    for (unsigned i = 0; i < sizeof(payload); ++i) payload[i] = expected(i);
    HANDLE file = CreateFileA("mapped.bin", GENERIC_READ | GENERIC_WRITE, 3, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    CHECK(file != INVALID_HANDLE_VALUE);
    DWORD count;
    CHECK(WriteFile(file, payload, sizeof(payload), &count, NULL) && count == sizeof(payload));
    HANDLE reader = CreateFileW(L"mapped.bin", GENERIC_READ, 3, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    CHECK(reader != INVALID_HANDLE_VALUE);
    HANDLE section = CreateFileMappingA(reader, NULL, PAGE_READONLY, 0, 0, NULL);
    CHECK(section && GetLastError() == 0);
    CHECK(CloseHandle(reader));
    unsigned char *full = MapViewOfFile(section, FILE_MAP_READ, 0, 0, 0);
    CHECK(full);
    verify(full, 0, sizeof(payload));
    CHECK(full[sizeof(payload)] == 0 && full[69631] == 0);
    unsigned char *tail = MapViewOfFile(section, FILE_MAP_READ, 0, 65536, 0);
    CHECK(tail);
    verify(tail, 65536, 37);
    CHECK(tail[37] == 0 && tail[4095] == 0);
    CHECK(!MapViewOfFile(section, FILE_MAP_WRITE, 0, 0, 0));
    CHECK(!MapViewOfFile(section, FILE_MAP_READ, 0, 1, 0) && GetLastError() == ERROR_MAPPED_ALIGNMENT);
    CHECK(!MapViewOfFile(section, FILE_MAP_READ, 0, 65536, 38));
    CHECK(!MapViewOfFileEx(section, FILE_MAP_READ, 0, 65536, 0, tail) && GetLastError() == ERROR_INVALID_ADDRESS);
#ifdef NATIVE_TEST
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    typedef LONG (WINAPI *QUERY)(HANDLE, ULONG, void *, ULONG, ULONG *);
    typedef LONG (WINAPI *CREATE)(HANDLE *, ULONG, OBJECT_ATTRIBUTES *, LARGE_INTEGER *, ULONG, ULONG, HANDLE);
    typedef LONG (WINAPI *MAP)(HANDLE, HANDLE, void **, ULONG, SIZE_T, LARGE_INTEGER *, SIZE_T *, ULONG, ULONG, ULONG);
    QUERY query = (QUERY)(void *)GetProcAddress(ntdll, "NtQuerySection");
    CREATE create = (CREATE)(void *)GetProcAddress(ntdll, "NtCreateSection");
    MAP map = (MAP)(void *)GetProcAddress(ntdll, "NtMapViewOfSection");
    CHECK(query && create && map);
    DWORD info[5] = {0,0,0,0,0xaabbccdd}, length = 0;
    CHECK(query(section, 0, info, 16, &length) == 0 && length == 16);
    CHECK(info[0] == 0 && info[1] == 0x800000 && info[2] == sizeof(payload) && info[3] == 0 && info[4] == 0xaabbccdd);
    HANDLE small;
    LARGE_INTEGER maximum; maximum.QuadPart = 36;
    OBJECT_ATTRIBUTES attr = {sizeof(attr), NULL, NULL, 0x40, NULL, NULL};
    CHECK(create(&small, 5, &attr, &maximum, PAGE_READONLY, SEC_COMMIT, file) == 0);
    void *small_view = NULL;
    SIZE_T size = 37;
    CHECK((ULONG)map(small, GetCurrentProcess(), &small_view, 0, 0, NULL, &size, 1, 0, PAGE_READONLY) == 0xc000001f);
    CHECK(small_view == NULL && size == 37);
    size = 36;
    CHECK(map(small, GetCurrentProcess(), &small_view, 0, 0, NULL, &size, 1, 0, PAGE_READONLY) == 0 && size == 4096);
    verify(small_view, 0, 4096);
    CHECK(CloseHandle(small) && UnmapViewOfFile((char *)small_view + 100));
#endif
    CHECK(CloseHandle(section));
    verify(full, 0, sizeof(payload));
    CHECK(UnmapViewOfFile(full + 4096));
    verify(tail, 65536, 37);
    CHECK(UnmapViewOfFile(tail + 4095));
    CHECK(!UnmapViewOfFile(tail) && GetLastError() == ERROR_INVALID_ADDRESS);
    CHECK(CloseHandle(file));
    file = CreateFileA("mapped.bin", GENERIC_READ, 3, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    CHECK(file != INVALID_HANDLE_VALUE);
    section = CreateFileMappingW(file, NULL, PAGE_READONLY, 0, 36, NULL);
    CHECK(section);
    full = MapViewOfFile(section, FILE_MAP_READ, 0, 0, 36);
    CHECK(full);
    verify(full, 0, 4096);
    CHECK(CloseHandle(file) && CloseHandle(section) && UnmapViewOfFile(full));
    /* A dropped sidecar is read by the same mapping path as generated data. */
    file = CreateFileA("payload.bin", GENERIC_READ, 3, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (file != INVALID_HANDLE_VALUE) {
        section = CreateFileMappingW(file, NULL, PAGE_READONLY, 0, 0, NULL);
        CHECK(section && CloseHandle(file));
        full = MapViewOfFile(section, FILE_MAP_READ, 0, 0, 0);
        CHECK(full && CloseHandle(section));
        verify(full, 0, sizeof(payload));
        CHECK(UnmapViewOfFile(full));
        CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "sidecar-ok\n", 11, &count, NULL));
    } else CHECK(GetLastError() == ERROR_FILE_NOT_FOUND);
    CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "sections-ok\n", 12, &count, NULL));
    ExitProcess(0);
}
