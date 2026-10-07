/* Original WineBrowser contributors, MIT. Native SDK control drawing oracle. */
#include <windows.h>
#include <stdio.h>
static int first = 1;
static void emit(HDC dc, UINT type, UINT flags, RECT rect, int clip) {
    RECT initial = rect, all = {0, 0, 32, 32};
    SelectClipRgn(dc, NULL);
    HBRUSH back = CreateSolidBrush(0x9e6a35);
    FillRect(dc, &all, back);
    DeleteObject(back);
    if (clip) {
        HRGN a = CreateRectRgn(0, 0, 24, 27), b = CreateRectRgn(9, 8, 15, 14);
        CombineRgn(a, a, b, RGN_DIFF);
        SelectClipRgn(dc, a);
        DeleteObject(a); DeleteObject(b);
    }
    SetLastError(777);
    BOOL result = DrawFrameControl(dc, &rect, type, flags);
    DWORD error = GetLastError();
    POINT point; GetCurrentPositionEx(dc, &point);
    printf("%s{\"type\":%u,\"flags\":%u,\"rect\":[%ld,%ld,%ld,%ld],\"clip\":%d,\"result\":%u,\"error\":%lu,\"outRect\":[%ld,%ld,%ld,%ld],\"position\":[%ld,%ld],\"textColor\":%lu,\"bkColor\":%lu,\"bkMode\":%d,\"fillMode\":%d,\"runs\":[",
        first ? "" : ",\n", type, flags, initial.left, initial.top, initial.right, initial.bottom,
        clip, result, error, rect.left, rect.top, rect.right, rect.bottom, point.x, point.y,
        GetTextColor(dc), GetBkColor(dc), GetBkMode(dc), GetPolyFillMode(dc));
    first = 0; int runFirst = 1;
    SelectClipRgn(dc, NULL);
    for (int y = 0; y < 32; y++) for (int x = 0; x < 32;) {
        COLORREF color = GetPixel(dc, x, y); int end = x + 1;
        while (end < 32 && GetPixel(dc, end, y) == color) end++;
        if (color != 0x9e6a35) {
            printf("%s[%d,%d,%d,%lu]", runFirst ? "" : ",", x, y, end - x, color);
            runFirst = 0;
        }
        x = end;
    }
    puts("]}");
}
int main(void) {
    /* Normalize the classic palette, then restore the user's Wine colors. */
    int indices[] = {COLOR_WINDOW, COLOR_WINDOWFRAME, COLOR_WINDOWTEXT,
        COLOR_BTNFACE, COLOR_BTNSHADOW, COLOR_BTNTEXT, COLOR_BTNHIGHLIGHT,
        COLOR_3DDKSHADOW, COLOR_3DLIGHT};
    COLORREF colors[] = {0xffffff,0,0,0xc0c0c0,0x808080,0,0xffffff,0x404040,0xe3e3e3};
    COLORREF original[9];
    for (int i=0; i<9; i++) original[i] = GetSysColor(indices[i]);
    if (!SetSysColors(9, indices, colors)) return 2;
    HDC screen = GetDC(NULL), dc = CreateCompatibleDC(screen);
    HBITMAP bitmap = CreateCompatibleBitmap(screen, 32, 32);
    HGDIOBJ old = SelectObject(dc, bitmap);
    SetTextColor(dc, 0x123456); SetBkColor(dc, 0x654321); SetBkMode(dc, TRANSPARENT);
    SetPolyFillMode(dc, WINDING); SetBrushOrgEx(dc, 3, -5, NULL); MoveToEx(dc, 29, 30, NULL);
    RECT rects[] = {{3,4,27,28},{1,3,30,18},{5,6,6,7},{5,6,10,11},{5,6,13,14},{5,6,6,15},{17,18,4,5},{-3,-2,16,15}};
    UINT flags[] = {0, DFCS_INACTIVE, DFCS_PUSHED, DFCS_CHECKED,
        DFCS_CHECKED|DFCS_INACTIVE, DFCS_FLAT, DFCS_FLAT|DFCS_CHECKED,
        DFCS_MONO, DFCS_MONO|DFCS_CHECKED, DFCS_TRANSPARENT,
        DFCS_TRANSPARENT|DFCS_CHECKED, DFCS_ADJUSTRECT, DFCS_HOT};
    UINT types[] = {DFCS_SCROLLUP,DFCS_SCROLLDOWN,DFCS_SCROLLLEFT,DFCS_SCROLLRIGHT,DFCS_SCROLLCOMBOBOX,DFCS_SCROLLSIZEGRIP};
    puts("[");
    for(unsigned type=0;type<6;type++)for(unsigned f=0;f<13;f++)for(unsigned rect=0;rect<8;rect++)
        emit(dc,DFC_SCROLL,types[type]|flags[f],rects[rect],rect==1);
    puts("]");
    SelectObject(dc, old); DeleteObject(bitmap); DeleteDC(dc); ReleaseDC(NULL, screen);
    SetSysColors(9, indices, original);
    return 0;
}
