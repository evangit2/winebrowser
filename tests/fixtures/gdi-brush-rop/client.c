/* Original WineBrowser contributors, MIT. Native SDK brush raster GUI. */
#include "layout.h"
#define CHECK(x) do{if(!(x))ExitProcess(1000+__LINE__);}while(0)
void *memset(void *target,int value,size_t count){BYTE *p=target;while(count--)*p++=(BYTE)value;return target;}
static HWND root;
static unsigned stage,painted;
static const WCHAR *titles[]={L"Native brush raster GUI - Solid",L"Native brush raster GUI - Mono",L"Native brush raster GUI - Color",L"Native brush raster GUI - Hatch",L"Native brush raster GUI - Transp",L"Native brush raster GUI - Holes",L"Native brush raster GUI - Reverse",L"Native brush raster GUI - Solid"};
static LRESULT CALLBACK procedure(HWND window,UINT msg,WPARAM wp,LPARAM lp) {
    if(window==root&&msg==WM_PAINT){PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);RECT all={0,0,640,340};CHECK(FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH)));CHECK(paint_brushes(dc,stage)&&EndPaint(window,&ps));painted++;CHECK(SetWindowTextW(window,titles[stage]));return 0;}
    if(window==root&&msg==WM_COMMAND&&HIWORD(wp)==BN_CLICKED&&LOWORD(wp)>=101&&LOWORD(wp)<=108){stage=LOWORD(wp)-101;CHECK(InvalidateRect(root,NULL,TRUE));return 0;}
    if(window==root&&(msg==WM_CLOSE||(msg==WM_KEYDOWN&&wp==VK_ESCAPE))){PostQuitMessage(0);return 0;}
    return DefWindowProcW(window,msg,wp,lp);
}
void start(void) {
    CHECK(!lstrcmpW(L"brushes",L"brushes"));WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=GetModuleHandleW(NULL);cls.hCursor=LoadCursorW(NULL,IDC_ARROW);cls.lpszClassName=L"NativeBrushRaster";CHECK(RegisterClassW(&cls));
    root=CreateWindowExW(0,cls.lpszClassName,L"Native brush raster GUI",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,642,370,NULL,NULL,cls.hInstance,NULL);CHECK(root);
    const WCHAR *buttons[]={L"Solid",L"Mono",L"Color",L"Hatch",L"Transp",L"Holes",L"Reverse",L"Reset"};
    for(int i=0;i<8;i++)CHECK(CreateWindowExW(0,L"BUTTON",buttons[i],WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,12+(i%4)*156,8+(i/4)*36,148,28,root,(HMENU)(INT_PTR)(101+i),cls.hInstance,NULL));
    CHECK(CreateWindowExW(0,L"STATIC",L"Try sixteen paint rules: copy, invert, XOR, mask and more.",WS_CHILD|WS_VISIBLE|SS_CENTER,8,74,624,22,root,NULL,cls.hInstance,NULL));
    ShowWindow(root,SW_SHOW);CHECK(UpdateWindow(root));MSG msg;while(GetMessageW(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}CHECK(painted&&DestroyWindow(root));
    const char out[]="NATIVE BRUSH RASTER GUI PASS\n";DWORD wrote=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),out,sizeof(out)-1,&wrote,NULL)&&wrote==sizeof(out)-1);ExitProcess(0);
}
