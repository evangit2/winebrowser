#include <windows.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
static LRESULT CALLBACK proc(HWND window, UINT message, WPARAM wp, LPARAM lp)
{
    if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcA(window, message, wp, lp);
}
void start(void)
{
    WNDCLASSA cls = {0};
    cls.hInstance = GetModuleHandleA(NULL);
    cls.hIcon = LoadIconA(cls.hInstance, MAKEINTRESOURCEA(101));
    CHECK(cls.hIcon && cls.hIcon == LoadIconW(cls.hInstance, MAKEINTRESOURCEW(101)));
    cls.lpfnWndProc = proc;
    cls.lpszClassName = "NativeIcon24";
    CHECK(RegisterClassA(&cls));
    HWND window = CreateWindowExA(0, cls.lpszClassName, "24-bit native icon", WS_OVERLAPPEDWINDOW,
        20, 20, 240, 160, NULL, NULL, cls.hInstance, NULL);
    CHECK(window);
    ShowWindow(window, SW_SHOW);
    MSG message;
    while (GetMessageA(&message, NULL, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageA(&message); }
    ExitProcess((UINT)message.wParam);
}
