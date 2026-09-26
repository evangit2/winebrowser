#include <windows.h>
#include <mmsystem.h>

struct event { DWORD msg, id, handle, first, second; };
struct state { DWORD count, errors; struct event events[64]; };
static struct state *log;
static HMODULE self;
static DWORD mode, next_id;

__declspec(dllexport) void WINAPI Configure(struct state *target, DWORD flags) {
    log = target; mode = flags; next_id = 100;
}
__declspec(dllexport) LRESULT CALLBACK DriverProc(DWORD_PTR id, HDRVR handle, UINT msg,
                                                  LPARAM first, LPARAM second) {
    if (log && log->count < 64) {
        struct event *e = &log->events[log->count++];
        e->msg = msg; e->id = id; e->handle = (DWORD)handle;
        e->first = first; e->second = second;
        if (GetDriverModuleHandle(handle) != self) log->errors++;
        if (msg == DRV_OPEN && first) {
            const WCHAR *a = (const WCHAR *)first, *b = L"configuration";
            while (*a && *a == *b) { ++a; ++b; }
            if (*a != *b) log->errors++;
        }
    }
    if (msg == DRV_LOAD && mode == 1) return 0;
    if (msg == DRV_OPEN) {
        if (mode == 2 || (mode == 3 && second)) return 0;
        return ++next_id;
    }
    if (msg == DRV_USER) return (id << 16) | ((first + second) & 0xffff);
    return DefDriverProc(id, handle, msg, first, second);
}
BOOL WINAPI DllMain(HINSTANCE module, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) self = module;
    if (reason == DLL_PROCESS_DETACH && log && log->count < 64)
        log->events[log->count++].msg = 0xff;
    return TRUE;
}
