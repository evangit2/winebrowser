#define UNICODE
#include <windows.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
static unsigned int gettext_calls;
static LRESULT CALLBACK proc(HWND window, UINT message, WPARAM wp, LPARAM lp)
{
    if (message == WM_GETTEXT || message == WM_GETTEXTLENGTH) gettext_calls++;
    return DefWindowProcW(window, message, wp, lp);
}
void start(void)
{
    WNDCLASSW cls = {0};
    cls.lpfnWndProc = proc;
    cls.hInstance = GetModuleHandleA(NULL);
    cls.lpszClassName = L"WindowFindFixture";
    ATOM atom = RegisterClassW(&cls);
    CHECK(atom);
    HWND first = CreateWindowExW(0, MAKEINTATOM(atom), L"Caf\x00e9", WS_OVERLAPPEDWINDOW,
        20, 20, 200, 140, NULL, NULL, cls.hInstance, NULL);
    HWND second = CreateWindowExW(0, cls.lpszClassName, L"", WS_OVERLAPPEDWINDOW,
        40, 40, 200, 140, NULL, NULL, cls.hInstance, NULL);
    CHECK(first && second);
    SetLastError(0x12345678);
    CHECK(FindWindowW(NULL, NULL) == second);
    CHECK(FindWindowA("WINDOWFINDFIXTURE", "CAF\xc9") == first);
    CHECK(FindWindowW(MAKEINTATOM(atom), L"caf\x00c9") == first);
    CHECK(FindWindowW(NULL, L"") == second);
    CHECK(FindWindowA("", NULL) == NULL && FindWindowW(L"absent", NULL) == NULL);
    CHECK(GetLastError() == 0x12345678);
    CHECK(FindWindowExA(NULL, second, NULL, NULL) == first);
    CHECK(FindWindowExW(NULL, first, NULL, NULL) == NULL);
    HWND one = CreateWindowExW(0, L"STATIC", L"Child", WS_CHILD, 0, 0, 40, 20,
        first, (HMENU)1, cls.hInstance, NULL);
    HWND two = CreateWindowExA(0, "STATIC", "Child", WS_CHILD, 0, 20, 40, 20,
        first, (HMENU)2, cls.hInstance, NULL);
    HWND nested = CreateWindowExW(0, L"STATIC", L"Nested", WS_CHILD, 0, 0, 30, 15,
        one, (HMENU)3, cls.hInstance, NULL);
    CHECK(one && two && nested);
    CHECK(FindWindowW(NULL, L"Child") == NULL);
    CHECK(FindWindowExW(first, NULL, L"static", L"CHILD") == one);
    CHECK(FindWindowExA(first, one, "STATIC", "child") == two);
    CHECK(FindWindowExW(first, two, NULL, NULL) == NULL);
    CHECK(FindWindowExW(first, NULL, NULL, L"Nested") == NULL);
    CHECK(FindWindowExW(one, NULL, NULL, NULL) == nested);
    CHECK(FindWindowExW(first, nested, NULL, NULL) == NULL);
    CHECK(FindWindowExW(second, one, NULL, NULL) == NULL);
    CHECK(FindWindowExW(HWND_MESSAGE, NULL, NULL, NULL) == NULL);
    CHECK(gettext_calls == 0);
    ShowWindow(first, SW_SHOW);
    CHECK(FindWindowW(NULL, NULL) == first);
    ShowWindow(second, SW_SHOWNA);
    CHECK(FindWindowW(NULL, NULL) == first);
    SetFocus(second);
    CHECK(FindWindowW(NULL, NULL) == second);
    CHECK(SetWindowTextW(second, L"Changed"));
    CHECK(FindWindowA(NULL, "CHANGED") == second);
    CHECK(DestroyWindow(one));
    CHECK(FindWindowExW(first, NULL, NULL, NULL) == two);
    CHECK(!IsWindow(nested));
    CHECK(DestroyWindow(second));
    CHECK(FindWindowW(NULL, NULL) == first);
    CHECK(DestroyWindow(first));
    CHECK(FindWindowA(NULL, NULL) == NULL);
    ExitProcess(0);
}
