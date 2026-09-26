#include <windows.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
static LRESULT CALLBACK proc(HWND window, UINT message, WPARAM wp, LPARAM lp)
{
    if (message == WM_KEYDOWN && wp == 'V') {
        CHECK(FindWindowA(NULL, NULL) == window);
        CHECK(SetWindowTextA(window, "Verified native order"));
        return 0;
    }
    if (message == WM_KEYDOWN && wp == VK_ESCAPE) { PostQuitMessage(0); return 0; }
    return DefWindowProcA(window, message, wp, lp);
}
void start(void)
{
    WNDCLASSA cls = {0};
    cls.lpfnWndProc = proc; cls.hInstance = GetModuleHandleA(NULL); cls.lpszClassName = "NativePopup";
    CHECK(RegisterClassA(&cls));
    RECT r = {0, 0, 180, 100};
    CHECK(AdjustWindowRectEx(&r, WS_POPUP, FALSE, WS_EX_TOPMOST));
    CHECK(!r.left && !r.top && r.right == 180 && r.bottom == 100);
    HWND first = CreateWindowExA(WS_EX_TOPMOST, cls.lpszClassName, "First popup", WS_POPUP | WS_VISIBLE,
        70, 60, 180, 100, NULL, NULL, cls.hInstance, NULL);
    HWND second = CreateWindowExA(WS_EX_TOPMOST, cls.lpszClassName, "Second popup", WS_POPUP | WS_VISIBLE,
        90, 80, 180, 100, NULL, NULL, cls.hInstance, NULL);
    HWND normal = CreateWindowExA(0, cls.lpszClassName, "Ordinary window", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
        10, 10, 360, 280, NULL, NULL, cls.hInstance, NULL);
    CHECK(first && second && normal);
    CHECK(GetClientRect(first, &r) && !r.left && !r.top && r.right == 180 && r.bottom == 100);
    CHECK(GetWindowRect(first, &r) && r.left == 70 && r.top == 60 && r.right == 250 && r.bottom == 160);
    POINT p = {3, 4};
    CHECK(ClientToScreen(first, &p) && p.x == 73 && p.y == 64);
    CHECK(FindWindowA(NULL, NULL) == second);
    SetFocus(normal);
    CHECK(FindWindowA(NULL, NULL) == second);
    MSG message;
    while (GetMessageA(&message, NULL, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageA(&message); }
    CHECK(DestroyWindow(first) && DestroyWindow(second) && DestroyWindow(normal));
    ExitProcess((UINT)message.wParam);
}
