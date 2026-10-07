/* Original WineBrowser contributors, MIT. Native SDK classic control GUI. */
#include "layout.h"
#define CHECK(x) do{if(!(x))ExitProcess(1000+__LINE__);}while(0)
void *memset(void *target,int value,size_t count){BYTE *p=target;while(count--)*p++=(BYTE)value;return target;}
static HWND root;
static unsigned stage,painted;
static const WCHAR *titles[]={L"Native frame controls - Normal",L"Native frame controls - Pushed",L"Native frame controls - Checked",L"Native frame controls - Disabled",L"Native frame controls - Flat",L"Native frame controls - Mono",L"Native frame controls - Transp",L"Native frame controls - Holes",L"Native frame controls - Adjust",L"Native frame controls - Normal",L"Native frame controls - Tiny"};
static LRESULT CALLBACK procedure(HWND window,UINT msg,WPARAM wp,LPARAM lp){
    if(window==root&&msg==WM_PAINT){PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);RECT all={0,0,640,340};CHECK(FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH)));CHECK(paint_controls(dc,stage)&&EndPaint(window,&ps));painted++;CHECK(SetWindowTextW(window,titles[stage]));return 0;}
    if(window==root&&msg==WM_COMMAND&&HIWORD(wp)==BN_CLICKED&&LOWORD(wp)>=101&&LOWORD(wp)<=111){stage=LOWORD(wp)-101;CHECK(InvalidateRect(root,NULL,TRUE));return 0;}
    if(window==root&&(msg==WM_CLOSE||(msg==WM_KEYDOWN&&wp==VK_ESCAPE))){PostQuitMessage(0);return 0;}
    return DefWindowProcW(window,msg,wp,lp);
}
void start(void){
    CHECK(!lstrcmpW(L"controls",L"controls"));WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=GetModuleHandleW(NULL);cls.hCursor=LoadCursorW(NULL,IDC_ARROW);cls.lpszClassName=L"NativeFrameControls";CHECK(RegisterClassW(&cls));
    root=CreateWindowExW(0,cls.lpszClassName,L"Native frame controls",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,642,370,NULL,NULL,cls.hInstance,NULL);CHECK(root);
    const WCHAR *buttons[]={L"Normal",L"Pushed",L"Checked",L"Disabled",L"Flat",L"Mono",L"Transp",L"Holes",L"Adjust",L"Reset",L"Tiny"};
    for(int i=0;i<11;i++)CHECK(CreateWindowExW(0,L"BUTTON",buttons[i],WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,12+(i%6)*104,8+(i/6)*36,96,28,root,(HMENU)(INT_PTR)(101+i),cls.hInstance,NULL));
    const WCHAR *labels[]={L"Push",L"Check",L"Tri",L"Up",L"Down",L"Left",L"Right",L"Menu",L"Tick",L"Combo",L"Grip"};
    for(int i=0;i<11;i++)CHECK(CreateWindowExW(0,L"STATIC",labels[i],WS_CHILD|WS_VISIBLE|SS_CENTER,6+i*57,74,52,22,root,(HMENU)(INT_PTR)(201+i),cls.hInstance,NULL));
    ShowWindow(root,SW_SHOW);CHECK(UpdateWindow(root));MSG msg;while(GetMessageW(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}CHECK(painted&&DestroyWindow(root));
    const char out[]="NATIVE FRAME CONTROLS GUI PASS\n";DWORD wrote=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),out,sizeof(out)-1,&wrote,NULL)&&wrote==sizeof(out)-1);ExitProcess(0);
}
