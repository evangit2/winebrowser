#include <windows.h>
#include <mmsystem.h>

struct event { DWORD msg, id, handle, first, second; };
struct state { DWORD count, errors; struct event events[64]; };
static struct state log;
typedef void (WINAPI *configure_fn)(struct state *, DWORD);
typedef HDRVR (WINAPI *open_ansi_fn)(LPCSTR, LPCSTR, LPARAM);
#define CHECK(expr) do { if (!(expr)) ExitProcess(__LINE__); } while (0)

static void events(const DWORD *messages, DWORD count) {
    CHECK(log.count == count); CHECK(log.errors == 0);
    for (DWORD i = 0; i < count; ++i) CHECK(log.events[i].msg == messages[i]);
}
static void reset(configure_fn configure, DWORD mode) {
    log.count = 0; log.errors = 0; configure(&log, mode);
}
void start(void) {
    HMODULE module = LoadLibraryW(L"plugins\\codec.dll");
    CHECK(module);
    configure_fn configure = (configure_fn)GetProcAddress(module, "Configure");
    CHECK(configure);
    reset(configure, 0);
    HDRVR a = OpenDriver(L"plugins\\codec.dll configuration", 0, 0);
    CHECK(a && GetDriverModuleHandle(a) == module);
    HDRVR b = OpenDriver(L"plugins\\codec.dll", 0, 0);
    CHECK(b && b != a);
    CHECK(SendDriverMessage(a, DRV_USER, 12, 34) == ((101 << 16) | 46));
    CHECK(SendDriverMessage(b, DRV_USER, 7, 9) == ((102 << 16) | 16));
    CHECK(CloseDriver(a, 33, 44));
    CHECK(!CloseDriver(a, 0, 0) && !GetDriverModuleHandle(a) && !SendDriverMessage(a, DRV_USER, 0, 0));
    CHECK(CloseDriver(b, 55, 66));
    const DWORD direct[] = {DRV_LOAD, DRV_ENABLE, DRV_OPEN, DRV_OPEN, DRV_USER, DRV_USER,
                             DRV_CLOSE, DRV_CLOSE, DRV_DISABLE, DRV_FREE};
    events(direct, sizeof(direct) / sizeof(*direct));
    CHECK(log.events[6].id == 101 && log.events[6].first == 33 && log.events[6].second == 44);
    CHECK(log.events[7].id == 102 && log.events[7].first == 55 && log.events[7].second == 66);
    CHECK(GetModuleHandleW(L"codec.dll") == module);

    reset(configure, 0);
    a = OpenDriver(L"plugins\\codec.dll", 0, 0x12345678);
    CHECK(a);
    b = OpenDriver(L"plugins\\codec.dll", 0, 0x11223344);
    CHECK(b);
    CHECK(SendDriverMessage(a, DRV_USER, 1, 2) == ((102 << 16) | 3));
    CHECK(CloseDriver(a, 0, 0));
    CHECK(CloseDriver(b, 0, 0));
    const DWORD sessions[] = {DRV_LOAD, DRV_ENABLE, DRV_OPEN, DRV_OPEN, DRV_OPEN,
        DRV_USER, DRV_CLOSE, DRV_CLOSE, DRV_CLOSE, DRV_DISABLE, DRV_FREE};
    events(sessions, sizeof(sessions) / sizeof(*sessions));
    CHECK(log.events[2].second == 0 && log.events[3].second == 0x12345678);
    CHECK(log.events[4].second == 0x11223344 && log.events[8].id == 101);

    HKEY key;
    CHECK(!RegCreateKeyW(HKEY_LOCAL_MACHINE,
        L"Software\\Microsoft\\Windows NT\\CurrentVersion\\Drivers32", &key));
    const WCHAR registration[] = L"plugins\\codec.dll configuration";
    CHECK(!RegSetValueExW(key, L"sample", 0, REG_SZ, (const BYTE *)registration, sizeof(registration)));
    CHECK(!RegCloseKey(key));
    reset(configure, 0);
    a = OpenDriver(L"sample", L"Drivers32", 0);
    CHECK(a && CloseDriver(a, 0, 0));
    a = OpenDriver(L"sample", 0, 0);
    CHECK(a && CloseDriver(a, 0, 0));
    open_ansi_fn open_ansi = (open_ansi_fn)GetProcAddress(GetModuleHandleA("winmm.dll"), "OpenDriverA");
    CHECK(open_ansi);
    a = open_ansi("sample", "Drivers32", 0);
    CHECK(a && CloseDriver(a, 0, 0));
    CHECK(log.count == 18 && !log.errors);

    reset(configure, 1);
    CHECK(!OpenDriver(L"plugins\\codec.dll", 0, 0));
    const DWORD failed_load[] = {DRV_LOAD};
    events(failed_load, 1);
    reset(configure, 2);
    CHECK(!OpenDriver(L"plugins\\codec.dll", 0, 0));
    const DWORD failed_open[] = {DRV_LOAD, DRV_ENABLE, DRV_OPEN, DRV_DISABLE, DRV_FREE};
    events(failed_open, 5);
    reset(configure, 3);
    CHECK(!OpenDriver(L"plugins\\codec.dll", 0, 1));
    const DWORD failed_session[] = {DRV_LOAD, DRV_ENABLE, DRV_OPEN, DRV_OPEN, DRV_CLOSE, DRV_DISABLE, DRV_FREE};
    events(failed_session, 7);
    CHECK(!OpenDriver(L"missing.dll", 0, 0));
    CHECK(!OpenDriver(L"bad.dll", 0, 0));
    CHECK(!GetModuleHandleA("bad.dll"));
    CHECK(!GetDriverModuleHandle((HDRVR)0xdeadbeef));
    CHECK(!CloseDriver((HDRVR)0xdeadbeef, 0, 0));
    CHECK(!OpenDriver(0, 0, 0));
    CHECK(FreeLibrary(module));
    CHECK(log.events[log.count-1].msg == 0xff);
    CHECK(!GetModuleHandleW(L"codec.dll"));
    ExitProcess(0);
}
