#include <windows.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
static HWND main_window, front, back, peer;
static unsigned int stage, count, messages[16], rewrite, swallow;
static LRESULT CALLBACK proc(HWND window, UINT message, WPARAM wp, LPARAM lp)
{
    if (stage == 1 && (message == WM_WINDOWPOSCHANGING || message == WM_NCCALCSIZE ||
        message == WM_WINDOWPOSCHANGED || message == WM_MOVE || message == WM_SIZE)) {
        CHECK(count < 16); messages[count++] = message;
    }
    if (message == WM_WINDOWPOSCHANGING && rewrite) {
        WINDOWPOS *position = (WINDOWPOS *)lp;
        CHECK(position->hwnd == window);
        position->x = 40; position->y = 50; position->cx = 320; position->cy = 240;
    }
    if (message == WM_WINDOWPOSCHANGED && swallow) return 0;
    if (message == WM_KEYDOWN && wp == 'M') {
        RECT r;
        CHECK(SetWindowPos(main_window, HWND_TOP, 60, 70, 360, 260, SWP_NOACTIVATE));
        CHECK(GetWindowRect(main_window, &r) && r.left == 60 && r.top == 70 && r.right == 420 && r.bottom == 330);
        CHECK(SetWindowPos(back, HWND_TOP, 35, 35, 140, 50, SWP_NOACTIVATE));
        CHECK(FindWindowExA(main_window, NULL, "STATIC", NULL) == back);
        CHECK(SetWindowTextA(main_window, "Position moved"));
        return 0;
    }
    if (message == WM_KEYDOWN && wp == 'H') {
        CHECK(SetWindowPos(back, NULL, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW));
        CHECK(!IsWindowVisible(back));
        CHECK(SetWindowTextA(main_window, "Position hidden"));
        return 0;
    }
    if (message == WM_KEYDOWN && wp == 'Z') {
        peer = CreateWindowExA(0, "NativeWindowPosition", "Activation peer", WS_POPUP | WS_VISIBLE,
            80, 160, 80, 60, NULL, NULL, GetModuleHandleA(NULL), NULL);
        CHECK(peer);
        SetFocus(peer);
        CHECK(SetWindowPos(main_window, peer, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE));
        CHECK(GetActiveWindow() == main_window && FindWindowA(NULL, NULL) == peer);
        CHECK(SetWindowTextA(main_window, "Position activated behind"));
        return 0;
    }
    if (message == WM_KEYDOWN && wp == VK_ESCAPE) { PostQuitMessage(0); return 0; }
    return DefWindowProcA(window, message, wp, lp);
}
void start(void)
{
    WNDCLASSA cls = {0};
    cls.lpfnWndProc = proc; cls.hInstance = GetModuleHandleA(NULL); cls.lpszClassName = "NativeWindowPosition";
    CHECK(RegisterClassA(&cls));
    main_window = CreateWindowExA(0, cls.lpszClassName, "Position ready", WS_POPUP | WS_VISIBLE,
        10, 20, 160, 120, NULL, NULL, cls.hInstance, NULL);
    CHECK(main_window);
    stage = 1; rewrite = 1;
    CHECK(SetWindowPos(main_window, HWND_TOP, 1, 2, 180, 130, SWP_NOACTIVATE));
    CHECK(count == 5 && messages[0] == WM_WINDOWPOSCHANGING && messages[1] == WM_NCCALCSIZE &&
        messages[2] == WM_WINDOWPOSCHANGED && messages[3] == WM_MOVE && messages[4] == WM_SIZE);
    RECT r;
    CHECK(GetWindowRect(main_window, &r) && r.left == 40 && r.top == 50 && r.right == 360 && r.bottom == 290);
    rewrite = 0; count = 0;
    CHECK(SetWindowPos(main_window, (HWND)0xdead, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING));
    CHECK(count == 0);
    CHECK(SetWindowPos(main_window, NULL, 0, 0, 0, 0,
        SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOSENDCHANGING | SWP_FRAMECHANGED));
    CHECK(count == 2 && messages[0] == WM_NCCALCSIZE && messages[1] == WM_WINDOWPOSCHANGED);
    count = 0; swallow = 1;
    CHECK(SetWindowPos(main_window, HWND_TOP, 41, 51, 321, 241, SWP_NOACTIVATE));
    CHECK(count == 3 && messages[2] == WM_WINDOWPOSCHANGED);
    stage = 0; swallow = 0;
    CHECK(SetWindowPos(main_window, HWND_TOPMOST, 40, 50, 320, 240, SWP_NOACTIVATE));
    CHECK(GetWindowLongA(main_window, GWL_EXSTYLE) & WS_EX_TOPMOST);
    CHECK(SetWindowPos(main_window, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE));
    CHECK(!(GetWindowLongA(main_window, GWL_EXSTYLE) & WS_EX_TOPMOST));
    front = CreateWindowExA(0, "STATIC", "Front child", WS_CHILD | WS_VISIBLE | WS_BORDER,
        20, 20, 140, 50, main_window, (HMENU)1, cls.hInstance, NULL);
    back = CreateWindowExA(0, "STATIC", "Back child", WS_CHILD | WS_VISIBLE | WS_BORDER,
        35, 35, 110, 40, main_window, (HMENU)2, cls.hInstance, NULL);
    CHECK(front && back && FindWindowExA(main_window, NULL, "STATIC", NULL) == front);
    SetFocus(main_window);
    MSG message;
    while (GetMessageA(&message, NULL, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageA(&message); }
    CHECK(DestroyWindow(main_window));
    if (peer) CHECK(DestroyWindow(peer));
    ExitProcess((UINT)message.wParam);
}
