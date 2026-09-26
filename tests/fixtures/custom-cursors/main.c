#include <windows.h>
#define CHECK(x) do{if(!(x))ExitProcess(__LINE__);}while(0)
static HCURSOR cursors[8],dll_cursor,selected;
static BOOL override;
static LRESULT CALLBACK proc(HWND w,UINT m,WPARAM p,LPARAM l){
    if(m==WM_SETCURSOR&&override){SetCursor(selected);return TRUE;}
    if(m==WM_KEYDOWN){
        if(p>='1'&&p<='8'){selected=cursors[p-'1'];override=TRUE;SetCursor(selected);}
        if(p=='D'){selected=dll_cursor;override=TRUE;SetCursor(selected);}
        if(p=='H')ShowCursor(FALSE);
        if(p=='S')ShowCursor(TRUE);
        if(p=='N'){selected=0;override=TRUE;SetCursor(0);}
        if(p=='R'){override=FALSE;SetCursor(cursors[0]);}
        if(p==VK_ESCAPE)DestroyWindow(w);
        return 0;
    }
    if(m==WM_DESTROY){PostQuitMessage(0);return 0;}
    return DefWindowProcA(w,m,p,l);
}
void start(void){
    HINSTANCE instance=GetModuleHandleA(0);
    const char*names[]={MAKEINTRESOURCEA(101),"FOUR","EIGHT","TRUECOLOR","ALPHA","MULTI","BLANK","SMALL"};
    const WCHAR*wide[]={MAKEINTRESOURCEW(101),L"four",L"eight",L"truecolor",L"alpha",L"multi",L"blank",L"small"};
    CHECK(GetSystemMetrics(SM_CXCURSOR)==32&&GetSystemMetrics(SM_CYCURSOR)==32);
    for(unsigned i=0;i<8;i++){cursors[i]=LoadCursorA(instance,names[i]);CHECK(cursors[i]&&LoadCursorW(instance,wide[i])==cursors[i]);}
    HMODULE library=LoadLibraryA("cursors.dll");CHECK(library);
    dll_cursor=LoadCursorA(library,"EIGHT");CHECK(dll_cursor&&dll_cursor!=cursors[2]);
    CHECK(dll_cursor==LoadCursorW(library,L"eight"));
    CHECK(!LoadCursorA(instance,"MISSING")&&GetLastError()==ERROR_RESOURCE_NAME_NOT_FOUND);
    CHECK(SetCursor(cursors[0])==LoadCursorA(0,IDC_ARROW));
    CHECK(SetCursor(cursors[4])==cursors[0]&&GetCursor()==cursors[4]);
    CHECK(!SetCursor((HCURSOR)0xdeadbeef)&&GetLastError()==ERROR_INVALID_CURSOR_HANDLE&&GetCursor()==cursors[4]);
    CHECK(ShowCursor(FALSE)==-1&&GetCursor()==cursors[4]&&ShowCursor(TRUE)==0);
    WNDCLASSA cls={0};cls.hInstance=instance;cls.lpfnWndProc=proc;cls.hCursor=cursors[0];cls.lpszClassName="CustomCursorFixture";
    CHECK(RegisterClassA(&cls));
    HWND w=CreateWindowExA(0,cls.lpszClassName,"Native resource cursors",WS_OVERLAPPEDWINDOW,20,20,360,240,0,0,instance,0);
    CHECK(w);ShowWindow(w,SW_SHOW);
    MSG msg;while(GetMessageA(&msg,0,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}
    SetCursor(LoadCursorA(0,IDC_ARROW));CHECK(FreeLibrary(library));ExitProcess((UINT)msg.wParam);
}
