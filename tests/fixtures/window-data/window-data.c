#include <windows.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
static unsigned int created, detached;
static DWORD values[2] = {0x12345678, 0x87654321};
static LRESULT CALLBACK proc(HWND window, UINT message, WPARAM wp, LPARAM lp)
{
    if (message == WM_NCCREATE) {
        CHECK(!GetWindowLongA(window, GWL_USERDATA));
        CHECK(!GetWindowLongW(window, 0) && !GetWindowLongA(window, 8));
        const CREATESTRUCTA *cs = (const CREATESTRUCTA *)lp;
        CHECK(!SetWindowLongW(window, GWL_USERDATA, (LONG)cs->lpCreateParams));
        CHECK(!SetWindowLongA(window, 3, 0xdeadbeef));
        return TRUE;
    }
    if (message == WM_CREATE) {
        DWORD *value = (DWORD *)GetWindowLongA(window, GWL_USERDATA);
        CHECK(value && (*value == values[0] || *value == values[1]));
        CHECK((DWORD)GetWindowLongW(window, 3) == 0xdeadbeef);
        CHECK(GetWindowLongW(window, 0) == (LONG)0xef000000);
        CHECK(!GetWindowLongW(window, GWL_HWNDPARENT));
        CHECK((HINSTANCE)GetWindowLongW(window, GWL_HINSTANCE) == GetModuleHandleA(NULL));
        created++;
        return 0;
    }
    if (message == WM_NCDESTROY) {
        CHECK(GetWindowLongA(window, GWL_USERDATA));
        CHECK((DWORD)GetWindowLongW(window, 3) == 0xdeadbeef);
        CHECK(SetWindowLongA(window, GWL_USERDATA, 0));
        CHECK(!GetWindowLongW(window, GWL_USERDATA));
        detached++;
    }
    return DefWindowProcA(window, message, wp, lp);
}
void start(void)
{
    WNDCLASSA cls = {0};
    cls.cbWndExtra = 12; cls.lpfnWndProc = proc;
    cls.hInstance = GetModuleHandleA(NULL); cls.lpszClassName = "NativeWindowData";
    CHECK(RegisterClassA(&cls));
    HWND first = CreateWindowExA(0, cls.lpszClassName, "Metadata first", WS_OVERLAPPEDWINDOW,
        10, 20, 160, 120, NULL, NULL, cls.hInstance, &values[0]);
    HWND second = CreateWindowExA(WS_EX_TOPMOST, cls.lpszClassName, "Metadata second", WS_POPUP,
        30, 40, 160, 120, NULL, NULL, cls.hInstance, &values[1]);
    CHECK(first && second && created == 2);
    CHECK((DWORD *)GetWindowLongW(first, GWL_USERDATA) == &values[0]);
    CHECK((DWORD *)GetWindowLongA(second, GWL_USERDATA) == &values[1]);
    CHECK((WNDPROC)GetWindowLongA(first, GWL_WNDPROC) == proc);
    CHECK(GetWindowLongW(second, GWL_EXSTYLE) & WS_EX_TOPMOST);
    CHECK(!(GetWindowLongA(first, GWL_STYLE) & WS_VISIBLE));
    ShowWindow(first, SW_SHOW);
    CHECK(GetWindowLongA(first, GWL_STYLE) & WS_VISIBLE);
    ShowWindow(first, SW_HIDE);
    CHECK(!(GetWindowLongW(first, GWL_STYLE) & WS_VISIBLE));
    SetLastError(0x11112222);
    CHECK(!SetWindowLongA(first, 8, 0xaabbccdd) && GetLastError() == 0x11112222);
    CHECK((DWORD)GetWindowLongW(first, 8) == 0xaabbccdd && !GetWindowLongA(second, 8));
    CHECK(!SetWindowLongA(first, 9, 0) && GetLastError() == ERROR_INVALID_INDEX);
    CHECK(!GetWindowLongW(first, -100) && GetLastError() == ERROR_INVALID_INDEX);
    HWND child = CreateWindowExW(0, L"STATIC", L"Child", WS_CHILD, 0, 0, 30, 20, first, (HMENU)5, cls.hInstance, NULL);
    CHECK(child && (HWND)GetWindowLongW(child, GWL_HWNDPARENT) == first);
    CHECK(SetWindowLongA(child, GWL_ID, 71) == 5 && GetDlgCtrlID(child) == 71);
    CHECK(GetDlgItem(first, 71) == child && !GetDlgItem(first, 5));
    CHECK(SetWindowLongW(child, GWL_HINSTANCE, 0xdeadbeef) == (LONG)cls.hInstance);
    CHECK((DWORD)GetWindowLongA(child, GWL_HINSTANCE) == 0xdeadbeef);
    CHECK(DestroyWindow(first) && DestroyWindow(second) && detached == 2);
    CHECK(!GetWindowLongA(first, GWL_USERDATA) && GetLastError() == ERROR_INVALID_WINDOW_HANDLE);
    ExitProcess(0);
}
