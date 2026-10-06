/* Authored MIT PE32 acceptance: SDK GDI caps, screen DCs and mode changes. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(1000 + __LINE__); } while (0)
static HWND root;
static HDC screen, memory;
static unsigned stage, enumerated;
static RECT expectedArea;
static BOOL sameRect(const RECT *a, const RECT *b) {
    return a->left == b->left && a->top == b->top && a->right == b->right && a->bottom == b->bottom;
}
static BOOL CALLBACK callback(HMONITOR monitor, HDC dc, LPRECT area, LPARAM data) {
    CHECK(monitor && dc == screen && data == (LPARAM)&enumerated && sameRect(area, &expectedArea));
    enumerated++; return TRUE;
}
static void caps(HDC dc, int width, int height) {
    CHECK(GetDeviceCaps(dc, TECHNOLOGY) == DT_RASDISPLAY);
    CHECK(GetDeviceCaps(dc, HORZRES) == width && GetDeviceCaps(dc, VERTRES) == height);
    CHECK(GetDeviceCaps(dc, DESKTOPHORZRES) == width && GetDeviceCaps(dc, DESKTOPVERTRES) == height);
    CHECK(GetDeviceCaps(dc, BITSPIXEL) == 32 && GetDeviceCaps(dc, PLANES) == 1 && GetDeviceCaps(dc, COLORRES) == 24);
    CHECK(GetDeviceCaps(dc, NUMCOLORS) == -1 && GetDeviceCaps(dc, SIZEPALETTE) == 0 && GetDeviceCaps(dc, NUMRESERVED) == 0);
    CHECK(GetDeviceCaps(dc, LOGPIXELSX) == 96 && GetDeviceCaps(dc, LOGPIXELSY) == 96 && GetDeviceCaps(dc, VREFRESH) == 60);
    CHECK(GetDeviceCaps(dc, HORZSIZE) > 0 && GetDeviceCaps(dc, VERTSIZE) > 0);
    CHECK((GetDeviceCaps(dc, CLIPCAPS) & CP_RECTANGLE) && (GetDeviceCaps(dc, RASTERCAPS) & RC_BITBLT));
    CHECK(GetDeviceCaps(dc, PHYSICALWIDTH) == 0 && GetDeviceCaps(dc, PHYSICALHEIGHT) == 0 && GetDeviceCaps(dc, PHYSICALOFFSETX) == 0 && GetDeviceCaps(dc, PHYSICALOFFSETY) == 0);
}
static void paint(unsigned width, unsigned height) {
    CHECK((unsigned)GetSystemMetrics(SM_CXSCREEN) == width && (unsigned)GetSystemMetrics(SM_CYSCREEN) == height);
    caps(screen, width, height); caps(memory, width, height);
    expectedArea = (RECT){0, 0, (LONG)width, (LONG)height}; RECT clip;
    CHECK(GetClipBox(screen, &clip) == SIMPLEREGION && sameRect(&clip, &expectedArea));
    enumerated = 0; CHECK(EnumDisplayMonitors(screen, NULL, callback, (LPARAM)&enumerated) && enumerated == 1);
    CHECK(PatBlt(screen, 0, 0, width, height, BLACKNESS));
    const COLORREF colors[] = {RGB(255, 0, 0), RGB(0, 255, 0), RGB(0, 0, 255), RGB(255, 255, 255)};
    for (unsigned i = 0; i < 4; i++) {
        RECT corner = {(i & 1) ? (LONG)width - 8 : 0, (i & 2) ? (LONG)height - 8 : 0, (i & 1) ? (LONG)width : 8, (i & 2) ? (LONG)height : 8};
        HBRUSH brush = CreateSolidBrush(colors[i]); CHECK(brush && FillRect(screen, &corner, brush) && DeleteObject(brush));
        CHECK(GetPixel(screen, corner.left, corner.top) == colors[i]);
    }
    CHECK(GetPixel(screen, width, height - 1) == CLR_INVALID);
    HDC child = GetDC(root); CHECK(child); caps(child, width, height); CHECK(ReleaseDC(root, child));
    const WCHAR *titles[] = {L"GDI screen 1024x768 ready", L"GDI screen 800x600 ready", L"GDI screen 640x480 ready", L"GDI screen restored"};
    CHECK(stage < 4); SetWindowTextW(root, titles[stage]);
}
static void mode(unsigned width, unsigned height) {
    DEVMODEA value; BOOL found = FALSE;
    for (unsigned i = 0; i < 16 && EnumDisplaySettingsA(NULL, i, &value); i++)
        if (value.dmPelsWidth == width && value.dmPelsHeight == height && value.dmBitsPerPel == 32) { found = TRUE; break; }
    CHECK(found && ChangeDisplaySettingsA(&value, CDS_TEST) == DISP_CHANGE_SUCCESSFUL);
    CHECK(ChangeDisplaySettingsA(&value, 0) == DISP_CHANGE_SUCCESSFUL); paint(width, height);
}
static LRESULT CALLBACK procedure(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    if (message == WM_KEYDOWN && wp == VK_F6) {
        stage++;
        if (stage == 1) mode(800, 600);
        else if (stage == 2) mode(640, 480);
        else if (stage == 3) { CHECK(ChangeDisplaySettingsA(NULL, 0) == DISP_CHANGE_SUCCESSFUL); paint(1024, 768); }
        else CHECK(0);
        return 0;
    }
    if (message == WM_CLOSE) {
        CHECK(stage == 3 && ReleaseDC(NULL, screen) == 1 && DeleteDC(memory));
        CHECK(!GetDeviceCaps(screen, HORZRES) && !GetDeviceCaps((HDC)0xdeadbeef, BITSPIXEL));
    }
    if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(window, message, wp, lp);
}
void start(void) {
    HINSTANCE instance = GetModuleHandleW(NULL); WNDCLASSW cls = {0}; cls.hInstance = instance; cls.lpfnWndProc = procedure; cls.lpszClassName = L"GdiScreen";
    CHECK(RegisterClassW(&cls));
    root = CreateWindowW(cls.lpszClassName, L"GDI screen starting", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 30, 40, 300, 140, NULL, NULL, instance, NULL); CHECK(root);
    screen = GetDC(NULL); memory = CreateCompatibleDC(screen); CHECK(screen && memory);
    paint(1024, 768); MSG message;
    while (GetMessageW(&message, NULL, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    ExitProcess((UINT)message.wParam);
}
