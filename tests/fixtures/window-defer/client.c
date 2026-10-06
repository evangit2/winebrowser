/* Original WineBrowser contributors, MIT. Native deferred-layout GUI. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(1000 + __LINE__); } while (0)
static HWND root, panes[2], status;
static BOOL ready, stacked, large, measuring;
static unsigned changes, changed, order[2], layouts;

static void check_rect(HWND window, int x, int y, int width, int height) {
    RECT rect; POINT origin = {0, 0};
    CHECK(ClientToScreen(root, &origin) && GetWindowRect(window, &rect));
    CHECK(rect.left == origin.x + x && rect.top == origin.y + y);
    CHECK(rect.right - rect.left == width && rect.bottom - rect.top == height);
}
static void layout(void) {
    RECT bounds, before; CHECK(GetClientRect(root, &bounds) && GetWindowRect(panes[0], &before));
    const int width = bounds.right - 36, height = bounds.bottom - 112;
    const int pane_width = stacked ? width : (width - 12) / 2;
    const int pane_height = stacked ? (height - 12) / 2 : height;
    const int second_x = stacked ? 18 : 18 + pane_width + 12;
    const int second_y = stacked ? 68 + pane_height + 12 : 68;
    CHECK(width > 0 && height > 0);
    changes = changed = 0; measuring = TRUE;
    HDWP batch = BeginDeferWindowPos(1); CHECK(batch);
    /* Repeat one HWND to exercise real move/size merging and ignored inputs. */
    batch = DeferWindowPos(batch, panes[0], NULL, 18, 68, 0, 0,
        SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOREDRAW); CHECK(batch);
    batch = DeferWindowPos(batch, panes[1], NULL, second_x, second_y, pane_width, pane_height,
        SWP_NOZORDER | SWP_NOACTIVATE); CHECK(batch);
    batch = DeferWindowPos(batch, panes[0], NULL, -9999, -9999, pane_width, pane_height,
        SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE); CHECK(batch);
    batch = DeferWindowPos(batch, status, NULL, 18, bounds.bottom - 32, width, 22,
        SWP_NOZORDER | SWP_NOACTIVATE); CHECK(batch);
    RECT current; CHECK(GetWindowRect(panes[0], &current));
    CHECK(EqualRect(&before, &current) && changes == 0 && changed == 0);
    CHECK(EndDeferWindowPos(batch)); measuring = FALSE;
    CHECK(changes == 2 && order[0] == 201 && order[1] == 202);
    /* Unchanged geometry need not send WM_WINDOWPOSCHANGED. */
    CHECK(changed <= 2);
    check_rect(panes[0], 18, 68, pane_width, pane_height);
    check_rect(panes[1], second_x, second_y, pane_width, pane_height);
    CHECK(!EndDeferWindowPos(batch) && GetLastError() == ERROR_INVALID_HANDLE);
    CHECK(InvalidateRect(panes[0], NULL, TRUE) && InvalidateRect(panes[1], NULL, TRUE));
    CHECK(SetWindowTextW(status, stacked ? L"Stacked: native deferred layout verified" : L"Side by side: native deferred layout verified"));
    CHECK(SetWindowTextW(root, stacked ? L"Native layout - stacked" : L"Native layout - side by side"));
    layouts++;
}
static LRESULT CALLBACK procedure(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    const int id = GetDlgCtrlID(window);
    if (measuring && id >= 201 && id <= 202) {
        if (message == WM_WINDOWPOSCHANGING) { CHECK(changes < 2); order[changes++] = (unsigned)id; }
        if (message == WM_WINDOWPOSCHANGED) changed++;
    }
    if (message == WM_PAINT && id >= 201 && id <= 202) {
        PAINTSTRUCT paint; RECT bounds; HDC dc = BeginPaint(window, &paint); CHECK(dc);
        CHECK(GetClientRect(window, &bounds));
        HBRUSH brush = CreateSolidBrush(id == 201 ? RGB(28, 85, 138) : RGB(150, 66, 30)); CHECK(brush);
        CHECK(FillRect(dc, &bounds, brush) && DeleteObject(brush));
        CHECK(SetTextColor(dc, RGB(255, 255, 255)) != CLR_INVALID);
        CHECK(SetBkMode(dc, TRANSPARENT));
        const WCHAR *text = id == 201 ? L"Native pane A" : L"Native pane B";
        CHECK(TextOutW(dc, 16, 16, text, 13));
        CHECK(EndPaint(window, &paint)); return 0;
    }
    if (window == root && message == WM_COMMAND && HIWORD(wp) == BN_CLICKED) {
        if (LOWORD(wp) == 101 || LOWORD(wp) == 102) { stacked = LOWORD(wp) == 102; layout(); return 0; }
        if (LOWORD(wp) == 103) {
            large = !large;
            CHECK(SetWindowPos(root, NULL, 0, 0, large ? 660 : 560, large ? 440 : 360,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE)); return 0;
        }
    }
    if (window == root && message == WM_SIZE && ready) layout();
    if (window == root && message == WM_KEYDOWN && wp == VK_ESCAPE) { PostQuitMessage(0); return 0; }
    if (window == root && message == WM_CLOSE) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(window, message, wp, lp);
}
void start(void) {
    CHECK(!lstrcmpW(L"native", L"native"));
    HINSTANCE module = GetModuleHandleW(NULL);
    WNDCLASSW cls = {0}; cls.lpfnWndProc = procedure; cls.hInstance = module;
    cls.hbrBackground = (HBRUSH)(COLOR_BTNFACE + 1); cls.lpszClassName = L"NativeDeferredLayout";
    CHECK(RegisterClassW(&cls));
    root = CreateWindowW(cls.lpszClassName, L"Native layout", WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_VISIBLE,
        40, 60, 560, 360, NULL, NULL, module, NULL); CHECK(root);
    const WCHAR *labels[] = {L"Side by side", L"Stack panes", L"Resize window"};
    for (unsigned i = 0; i < 3; i++) CHECK(CreateWindowW(L"BUTTON", labels[i], WS_CHILD | WS_VISIBLE | WS_TABSTOP,
        18 + (int)i * 170, 16, 154, 32, root, (HMENU)(101 + i), module, NULL));
    for (unsigned i = 0; i < 2; i++) {
        panes[i] = CreateWindowW(cls.lpszClassName, L"", WS_CHILD | WS_VISIBLE | WS_BORDER,
            18 + (int)i * 200, 68, 180, 140, root, (HMENU)(201 + i), module, NULL); CHECK(panes[i]);
    }
    status = CreateWindowW(L"STATIC", L"", WS_CHILD | WS_VISIBLE, 18, 300, 480, 22, root, (HMENU)301, module, NULL); CHECK(status);
    ready = TRUE; layout(); SetFocus(root); CHECK(GetFocus() == root);
    MSG message;
    while (GetMessageW(&message, NULL, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    CHECK(layouts > 0 && DestroyWindow(root));
    const CHAR pass[] = "NATIVE DEFERRED GUI PASS\n"; DWORD written = 0;
    CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), pass, sizeof(pass) - 1, &written, NULL) && written == sizeof(pass) - 1);
    ExitProcess((UINT)message.wParam);
}
