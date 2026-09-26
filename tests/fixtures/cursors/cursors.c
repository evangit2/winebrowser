#include <windows.h>
#define CHECK(condition) do { if (!(condition)) ExitProcess(__LINE__); } while (0)
static HCURSOR hand, wait_cursor;
static HCURSOR override_cursor;
static BOOL override;
static LRESULT CALLBACK proc(HWND window, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == WM_SETCURSOR && override) { SetCursor(override_cursor); return TRUE; }
    if (msg == WM_KEYDOWN) {
        if (wp == 'W') { override = TRUE; override_cursor = wait_cursor; SetCursor(wait_cursor); }
        if (wp == 'R') { override = FALSE; SetCursor(hand); }
        if (wp == 'H') ShowCursor(FALSE);
        if (wp == 'S') ShowCursor(TRUE);
        if (wp == 'N') { override = TRUE; override_cursor = 0; SetCursor(0); }
        return 0;
    }
    if (msg == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcA(window, msg, wp, lp);
}
void start(void) {
    const WORD ids[] = {32512,32513,32514,32515,32516,32642,32643,32644,32645,32646,32648,32649,32650,32651};
    for (unsigned int i=0;i<sizeof(ids)/sizeof(*ids);i++) {
        HCURSOR a=LoadCursorA(0,MAKEINTRESOURCEA(ids[i]));
        CHECK(a && a == LoadCursorW(0,MAKEINTRESOURCEW(ids[i])));
    }
    hand = LoadCursorA(0, IDC_HAND); wait_cursor = LoadCursorA(0, IDC_WAIT);
    SetCursor(hand); CHECK(GetCursor() == hand);
    CHECK(SetCursor(wait_cursor) == hand && GetCursor() == wait_cursor);
    CHECK(!SetCursor((HCURSOR)0xdeadbeef));
    CHECK(GetLastError() == ERROR_INVALID_CURSOR_HANDLE && GetCursor() == wait_cursor);
    CHECK(ShowCursor(FALSE) == -1 && ShowCursor(FALSE) == -2);
    CHECK(GetCursor() == wait_cursor);
    CHECK(ShowCursor(TRUE) == -1 && ShowCursor(TRUE) == 0);
    CHECK(SetCursor(0) == wait_cursor && !GetCursor());
    CHECK(!SetCursor(LoadCursorA(0, IDC_ARROW)));
    WNDCLASSA cls = {0};
    cls.lpfnWndProc=proc; cls.hInstance=GetModuleHandleA(0);
    cls.hCursor=hand; cls.lpszClassName="NativeCursorFixture";
    CHECK(RegisterClassA(&cls));
    HWND window=CreateWindowExA(0,cls.lpszClassName,"Cursor check",WS_OVERLAPPEDWINDOW,
        20,20,360,240,0,0,cls.hInstance,0);
    CHECK(window); ShowWindow(window, SW_SHOW);
    MSG msg;
    while (GetMessageA(&msg,0,0,0) > 0) { TranslateMessage(&msg); DispatchMessageA(&msg); }
    ExitProcess((UINT)msg.wParam);
}
