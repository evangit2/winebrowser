/* Authored MIT PE32 monitor enumeration callback acceptance. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(1000 + __LINE__); } while (0)
static HMONITOR monitor;
static HDC expectedDC;
static RECT expected;
static unsigned calls, nestedCalls;
static BOOL stop, recurse;
static LRESULT CALLBACK procedure(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    return DefWindowProcW(window, message, wp, lp);
}
static BOOL equalRect(const RECT *a, const RECT *b) {
    return a->left == b->left && a->top == b->top && a->right == b->right && a->bottom == b->bottom;
}
static BOOL CALLBACK nested(HMONITOR handle, HDC dc, LPRECT area, LPARAM data) {
    CHECK(handle == monitor && !dc && data == 0x12345678);
    CHECK(area->left == 0 && area->top == 0 && area->right == GetSystemMetrics(SM_CXSCREEN) && area->bottom == GetSystemMetrics(SM_CYSCREEN));
    nestedCalls++;
    return TRUE;
}
static BOOL CALLBACK callback(HMONITOR handle, HDC dc, LPRECT area, LPARAM data) {
    CHECK(handle == monitor && dc == expectedDC && data == (LPARAM)&calls && equalRect(area, &expected));
    MONITORINFO info = {0}; info.cbSize = sizeof(info);
    CHECK(GetMonitorInfoW(handle, &info));
    calls++;
    if (recurse) {
        RECT saved = *area;
        CHECK(EnumDisplayMonitors(NULL, NULL, nested, 0x12345678));
        CHECK(equalRect(area, &saved));
    }
    area->left = 9999; /* Callback storage must not alias the caller's input. */
    return !stop;
}
static void enumerate(HDC dc, const RECT *clip, RECT wanted, BOOL cancel, BOOL reentrant) {
    expectedDC = dc; expected = wanted; calls = 0; stop = cancel; recurse = reentrant;
    RECT input = {0}; if (clip) input = *clip;
    CHECK(EnumDisplayMonitors(dc, clip, callback, (LPARAM)&calls) == !cancel);
    CHECK(calls == 1 && (!clip || equalRect(clip, &input)));
}
void start(void) {
    POINT point = {0, 0}; monitor = MonitorFromPoint(point, 0); CHECK(monitor);
    RECT full = {0, 0, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)};
    enumerate(NULL, NULL, full, FALSE, TRUE); CHECK(nestedCalls == 1);
    enumerate(NULL, NULL, full, TRUE, FALSE);
    RECT clip = {-50, 20, 120, 90}, clipped = {0, 20, 120, 90};
    enumerate(NULL, &clip, clipped, FALSE, FALSE);
    RECT empty = {full.right, 0, full.right + 20, 30}; calls = 0;
    CHECK(EnumDisplayMonitors(NULL, &empty, callback, (LPARAM)&calls) && calls == 0);
    empty.left = 100; empty.right = 90;
    CHECK(EnumDisplayMonitors(NULL, &empty, callback, (LPARAM)&calls) && calls == 0);
    CHECK(!EnumDisplayMonitors((HDC)0xdeadbeef, NULL, callback, (LPARAM)&calls) && calls == 0);
    HINSTANCE instance = GetModuleHandleW(NULL);
    WNDCLASSW cls = {0}; cls.hInstance = instance; cls.lpfnWndProc = procedure; cls.lpszClassName = L"MonitorEnumeration"; CHECK(RegisterClassW(&cls));
    HWND root = CreateWindowW(cls.lpszClassName, L"Monitor enumeration", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 30, 40, 300, 180, NULL, NULL, instance, NULL); CHECK(root);
    HWND child = CreateWindowW(L"BUTTON", L"Native monitor query", WS_CHILD | WS_VISIBLE, 25, 20, 100, 50, root, NULL, instance, NULL); CHECK(child);
    HDC dc = GetDC(child); CHECK(dc);
    RECT client; CHECK(GetClientRect(child, &client));
    enumerate(dc, NULL, client, FALSE, FALSE);
    CHECK(IntersectClipRect(dc, 10, 12, 80, 40) == SIMPLEREGION);
    RECT dcClip = {10, 12, 80, 40}; enumerate(dc, NULL, dcClip, FALSE, FALSE);
    RECT extra = {20, 0, 60, 50}, intersection = {20, 12, 60, 40};
    enumerate(dc, &extra, intersection, FALSE, TRUE); CHECK(nestedCalls == 2);
    CHECK(ReleaseDC(child, dc) == 1);
    CHECK(!EnumDisplayMonitors(dc, NULL, callback, (LPARAM)&calls));
    CHECK(SetWindowPos(root, NULL, -80, 40, 300, 180, SWP_NOZORDER | SWP_NOACTIVATE));
    dc = GetDC(child); CHECK(dc);
    POINT origin = {0, 0}; CHECK(ClientToScreen(child, &origin));
    CHECK(origin.x < 0); client.left = -origin.x;
    enumerate(dc, NULL, client, FALSE, FALSE);
    CHECK(ReleaseDC(child, dc) == 1);
    HDC memory = CreateCompatibleDC(NULL); CHECK(memory);
    RECT pixel = {0, 0, 1, 1}; enumerate(memory, NULL, pixel, FALSE, FALSE); CHECK(DeleteDC(memory));
    CHECK(DestroyWindow(root)); ExitProcess(0);
}
