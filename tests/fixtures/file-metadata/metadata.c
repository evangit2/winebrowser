#define _WIN32_WINNT 0x0601
#include <windows.h>
#include <winternl.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
void *memset(void *target, int value, size_t size)
{
    volatile unsigned char *bytes = target;
    while (size--) *bytes++ = (unsigned char)value;
    return target;
}
static void output(const char *text, DWORD size)
{
    DWORD written = 0;
    CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text, size, &written, NULL) && written == size);
}
void start(void)
{
    CHECK(GetFileAttributesA(".") == FILE_ATTRIBUTE_DIRECTORY);
    CHECK(GetFileAttributesW(L"C:\\winebrowser\\") == FILE_ATTRIBUTE_DIRECTORY);
    CHECK(GetFileAttributesA("absent.bin") == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_FILE_NOT_FOUND);
    CHECK(GetFileAttributesW(L"missing\\file.bin") == INVALID_FILE_ATTRIBUTES && GetLastError() == ERROR_PATH_NOT_FOUND);
    struct { WIN32_FILE_ATTRIBUTE_DATA info; DWORD sentinel; } metadata;
    metadata.sentinel = 0xabcdef01;
    DWORD data_attributes = GetFileAttributesA("DATA");
    if (data_attributes != INVALID_FILE_ATTRIBUTES) {
        CHECK(data_attributes == FILE_ATTRIBUTE_DIRECTORY);
        CHECK(GetFileAttributesExW(L"data\\payload.bin", GetFileExInfoStandard, &metadata.info));
        CHECK(metadata.info.dwFileAttributes == FILE_ATTRIBUTE_ARCHIVE && metadata.info.nFileSizeLow == 6 && metadata.info.nFileSizeHigh == 0);
        CHECK(metadata.info.ftCreationTime.dwHighDateTime != 0 && metadata.sentinel == 0xabcdef01);
        output("data-ok\n", 8);
        CHECK(CreateFileA("data", GENERIC_WRITE, 3, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL) == INVALID_HANDLE_VALUE);
    } else {
        CHECK(GetLastError() == ERROR_FILE_NOT_FOUND);
        output("no-data\n", 8);
    }
    CHECK(CreateFileA("missing\\new.bin", GENERIC_WRITE, 3, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL) == INVALID_HANDLE_VALUE && GetLastError() == ERROR_PATH_NOT_FOUND);
    HANDLE file = CreateFileW(L"output.bin", GENERIC_READ | GENERIC_WRITE, 3, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    CHECK(file != INVALID_HANDLE_VALUE);
    const unsigned char bytes[5] = {0, 42, 128, 255, 7};
    DWORD written = 0;
    CHECK(WriteFile(file, bytes, sizeof(bytes), &written, NULL) && written == sizeof(bytes));
    CHECK(GetFileAttributesExA("output.bin", GetFileExInfoStandard, &metadata.info));
    CHECK(metadata.info.dwFileAttributes == FILE_ATTRIBUTE_ARCHIVE && metadata.info.nFileSizeLow == 5 && metadata.info.nFileSizeHigh == 0);
    CHECK(metadata.info.ftCreationTime.dwHighDateTime != 0 && metadata.sentinel == 0xabcdef01);
#ifdef NATIVE_TEST
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    typedef LONG (WINAPI *QUERY_PATH)(OBJECT_ATTRIBUTES *, void *);
    typedef LONG (WINAPI *QUERY_HANDLE)(HANDLE, IO_STATUS_BLOCK *, void *, ULONG, ULONG);
    QUERY_PATH basic = (QUERY_PATH)(void *)GetProcAddress(ntdll, "NtQueryAttributesFile");
    QUERY_PATH full = (QUERY_PATH)(void *)GetProcAddress(ntdll, "NtQueryFullAttributesFile");
    QUERY_HANDLE information = (QUERY_HANDLE)(void *)GetProcAddress(ntdll, "NtQueryInformationFile");
    CHECK(basic && full && information);
    WCHAR path[] = L"\\??\\C:\\winebrowser\\output.bin";
    UNICODE_STRING name = {sizeof(path) - 2, sizeof(path), path};
    OBJECT_ATTRIBUTES attr = {sizeof(attr), NULL, &name, 0x40, NULL, NULL};
    DWORD result[15];
    memset(result, 0xcc, sizeof(result));
    CHECK(basic(&attr, result) == 0 && result[8] == FILE_ATTRIBUTE_ARCHIVE && result[10] == 0xcccccccc);
    CHECK(result[0] == metadata.info.ftCreationTime.dwLowDateTime && result[1] == metadata.info.ftCreationTime.dwHighDateTime);
    CHECK(full(&attr, result) == 0 && result[8] == 4096 && result[9] == 0 && result[10] == 5 && result[11] == 0);
    CHECK(result[12] == FILE_ATTRIBUTE_ARCHIVE && result[14] == 0xcccccccc);
    IO_STATUS_BLOCK io;
    CHECK(information(file, &io, result, 56, 34) == 0 && io.Information == 56 && result[10] == 5 && result[14] == 0xcccccccc);
    HANDLE query = CreateFileA("output.bin", FILE_READ_ATTRIBUTES, 3, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    CHECK(query != INVALID_HANDLE_VALUE);
    CHECK(information(query, &io, result, 40, 4) == 0 && io.Information == 40 && result[8] == FILE_ATTRIBUTE_ARCHIVE);
    unsigned char denied;
    CHECK(!ReadFile(query, &denied, 1, &written, NULL) && GetLastError() == ERROR_ACCESS_DENIED);
    CHECK(CloseHandle(query));
#endif
    CHECK(CloseHandle(file));
    file = CreateFileA("output.bin", GENERIC_READ, 3, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    CHECK(file != INVALID_HANDLE_VALUE);
    unsigned char read[6] = {0};
    CHECK(ReadFile(file, read, sizeof(read), &written, NULL) && written == 5);
    for (unsigned i = 0; i < 5; ++i) CHECK(read[i] == bytes[i]);
    CHECK(CloseHandle(file));
    output("metadata-ok\n", 12);
    ExitProcess(0);
}
