/* Original WineBrowser contributors, MIT. Windows SDK ABI and geometry checks. */
#include <windows.h>
#define CHECK(x) do { if(!(x)) ExitProcess(1000+__LINE__); } while(0)
static BOOL rect_is(const RECT *r,LONG left,LONG top,LONG right,LONG bottom) {return r->left==left&&r->top==top&&r->right==right&&r->bottom==bottom;}
static unsigned painted_count,paint_order[3];
static LRESULT CALLBACK procedure(HWND window,UINT message,WPARAM wp,LPARAM lp) {
    const int id=GetDlgCtrlID(window);
    if(message==WM_PAINT && id>=201 && id<=203) {
        CHECK(painted_count<3);paint_order[painted_count++]=(unsigned)id;
        PAINTSTRUCT paint;HDC dc=BeginPaint(window,&paint);CHECK(dc);RECT bounds;CHECK(GetClientRect(window,&bounds));
        CHECK(FillRect(dc,&bounds,GetSysColorBrush(COLOR_WINDOW))&&EndPaint(window,&paint));return 0;
    }
    return DefWindowProcW(window,message,wp,lp);
}
void start(void) {
    CHECK(!lstrcmpW(L"native",L"native"));
    struct {RECT rect;DWORD guard;} output;RECT first={0,0,10,10},second={-2,-2,5,12};output.guard=0x12345678;
    CHECK(CopyRect(&output.rect,&first)&&rect_is(&output.rect,0,0,10,10));
    CHECK(IntersectRect(&output.rect,&first,&second)&&rect_is(&output.rect,0,0,5,10));
    CHECK(UnionRect(&output.rect,&first,&second)&&rect_is(&output.rect,-2,-2,10,12));
    CHECK(SubtractRect(&output.rect,&first,&second)&&rect_is(&output.rect,5,0,10,10));
    CHECK(SubtractRect(&first,&first,&second)&&rect_is(&first,5,0,10,10));
    CHECK(SetRectEmpty(&output.rect)&&IsRectEmpty(&output.rect)&&rect_is(&output.rect,0,0,0,0)&&output.guard==0x12345678);
    CHECK(!IntersectRect(&output.rect,&first,&second)&&IsRectEmpty(&output.rect));
    HINSTANCE module=GetModuleHandleW(NULL);
    WNDCLASSW cls={0};cls.hInstance=module;cls.lpfnWndProc=procedure;cls.lpszClassName=L"NativeWindowQuery";CHECK(RegisterClassW(&cls));
    HWND root=CreateWindowW(cls.lpszClassName,L"Native window queries",WS_POPUP|WS_VISIBLE,500,300,120,90,NULL,NULL,module,NULL);CHECK(root);
    HWND back=CreateWindowW(L"STATIC",L"Back",WS_CHILD|WS_VISIBLE,10,12,30,20,root,(HMENU)101,module,NULL);CHECK(back);
    HWND hidden=CreateWindowW(L"STATIC",L"Hidden",WS_CHILD,10,12,30,20,root,(HMENU)102,module,NULL);CHECK(hidden);
    HWND disabled=CreateWindowW(L"STATIC",L"Disabled",WS_CHILD|WS_VISIBLE|WS_DISABLED,10,12,30,20,root,(HMENU)103,module,NULL);CHECK(disabled);
    HWND transparent=CreateWindowExW(WS_EX_TRANSPARENT,L"STATIC",L"Transparent",WS_CHILD|WS_VISIBLE,10,12,30,20,root,(HMENU)104,module,NULL);CHECK(transparent);
    HWND nested=CreateWindowW(L"STATIC",L"Nested",WS_CHILD|WS_VISIBLE,0,0,20,10,back,(HMENU)105,module,NULL);CHECK(nested);
    const UINT flags=SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE;
    CHECK(SetWindowPos(hidden,HWND_TOP,0,0,0,0,flags)&&SetWindowPos(disabled,HWND_TOP,0,0,0,0,flags)&&SetWindowPos(transparent,HWND_TOP,0,0,0,0,flags));
    POINT point={10,12};
    CHECK(ChildWindowFromPoint(root,point)==transparent);
    CHECK(ChildWindowFromPointEx(root,point,CWP_SKIPTRANSPARENT)==disabled);
    CHECK(ChildWindowFromPointEx(root,point,CWP_SKIPTRANSPARENT|CWP_SKIPDISABLED)==hidden);
    CHECK(ChildWindowFromPointEx(root,point,CWP_SKIPTRANSPARENT|CWP_SKIPDISABLED|CWP_SKIPINVISIBLE)==back);
    point.x=40;point.y=32;CHECK(ChildWindowFromPoint(root,point)==root);
    point.x=120;CHECK(!ChildWindowFromPoint(root,point));point.x=-1;CHECK(!ChildWindowFromPointEx(root,point,0));
    CHECK(GetTopWindow(root)==transparent&&GetTopWindow(back)==nested&&GetTopWindow(NULL)==root);
    CHECK(IsChild(root,nested)&&IsChild(back,nested)&&!IsChild(root,root)&&!IsChild(disabled,nested));
    HWND paint_front=CreateWindowExW(WS_EX_TRANSPARENT,cls.lpszClassName,L"Paint front",WS_CHILD|WS_VISIBLE,60,50,20,20,root,(HMENU)201,module,NULL);CHECK(paint_front);
    HWND paint_middle=CreateWindowExW(WS_EX_TRANSPARENT,cls.lpszClassName,L"Paint middle",WS_CHILD|WS_VISIBLE,60,50,20,20,root,(HMENU)202,module,NULL);CHECK(paint_middle);
    HWND paint_back=CreateWindowW(cls.lpszClassName,L"Paint back",WS_CHILD|WS_VISIBLE,60,50,20,20,root,(HMENU)203,module,NULL);CHECK(paint_back);
    CHECK(InvalidateRect(paint_front,NULL,TRUE)&&InvalidateRect(paint_middle,NULL,TRUE)&&InvalidateRect(paint_back,NULL,TRUE));
    MSG message;unsigned iterations=0;
    while(painted_count<3){CHECK(PeekMessageW(&message,NULL,WM_PAINT,WM_PAINT,PM_REMOVE));DispatchMessageW(&message);CHECK(++iterations<16);}
    CHECK(paint_order[0]==203&&paint_order[1]==202&&paint_order[2]==201);
    HWND owner=CreateWindowW(cls.lpszClassName,L"Owned popup",WS_POPUP,0,0,10,10,root,NULL,module,NULL);CHECK(owner&&!IsChild(root,owner));
    CHECK(DestroyWindow(owner)&&DestroyWindow(root));
    const CHAR pass[]="NATIVE WINDOW QUERY SDK PASS\n";DWORD written=0;
    CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),pass,sizeof(pass)-1,&written,NULL)&&written==sizeof(pass)-1);
    ExitProcess(0);
}
