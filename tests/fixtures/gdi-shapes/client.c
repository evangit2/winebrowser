/* Original WineBrowser contributors, MIT. Native Windows shape GUI. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(1000 + __LINE__); } while (0)
static HWND root;
static unsigned mode=1, painted;
static const POINT star[]={{80,110},{220,250},{360,110},{80,200},{360,200}};
static HRGN shape(unsigned choice) {
    if(choice==1 || choice==2 || choice==6) return CreatePolygonRgn(star,5,choice==1?ALTERNATE:WINDING);
    if(choice==3) {
        const POINT rings[]={{60,105},{420,105},{420,265},{60,265},{145,140},{335,140},{335,230},{145,230}};
        const INT counts[]={4,4}; return CreatePolyPolygonRgn(rings,counts,2,ALTERNATE);
    }
    if(choice==4) return CreateRoundRectRgn(60,105,420,265,80,80);
    RECT box={100,105,380,265};return CreateEllipticRgnIndirect(&box);
}
static void sdk_checks(void) {
    const POINT points[]={{0,0},{10,3},{0,6}};
    HRGN triangle=CreatePolygonRgn(points,3,ALTERNATE);RECT box;
    CHECK(triangle && GetRgnBox(triangle,&box)==COMPLEXREGION);
    CHECK(box.left==0 && box.top==1 && box.right==10 && box.bottom==6);
    CHECK(PtInRegion(triangle,3,1) && !PtInRegion(triangle,4,1));CHECK(DeleteObject(triangle));
    const POINT pentagram[]={{0,0},{4,6},{8,0},{0,4},{8,4}};
    HRGN a=CreatePolygonRgn(pentagram,5,ALTERNATE),w=CreatePolygonRgn(pentagram,5,WINDING);
    CHECK(a && w && !PtInRegion(a,3,3) && PtInRegion(w,3,3)); CHECK(DeleteObject(a) && DeleteObject(w));
    HRGN ellipse=CreateEllipticRgn(0,0,10,10),round=CreateRoundRectRgn(20,16,0,0,-8,-6);
    CHECK(ellipse && round && !PtInRegion(ellipse,0,0) && PtInRegion(ellipse,4,4));
    CHECK(GetRgnBox(round,&box)==COMPLEXREGION && box.left==0 && box.top==0 && box.right==19 && box.bottom==15);
    CHECK(DeleteObject(ellipse) && DeleteObject(round));
    HRGN hole=shape(3); CHECK(hole && PtInRegion(hole,60,105) && !PtInRegion(hole,150,150));CHECK(DeleteObject(hole));
}
static void paint(HWND window) {
    PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);
    RECT all={0,0,480,280}; CHECK(FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH)));
    HRGN region=shape(mode); CHECK(region);
    HBRUSH ink=CreateSolidBrush(mode==6?RGB(25,130,90):RGB(28,85,138)),orange=CreateSolidBrush(RGB(240,145,30));CHECK(ink && orange);
    int saved=SaveDC(dc);CHECK(saved);
    if(mode==6) {
        CHECK(SelectClipRgn(dc,region)==COMPLEXREGION && DeleteObject(region));
        region=CreateRectRgn(0,0,0,0);CHECK(region && GetClipRgn(dc,region)==1);
        CHECK(FillRect(dc,&all,ink));
    } else CHECK(FillRgn(dc,region,ink));
    CHECK(FrameRgn(dc,region,orange,3,3));
    CHECK(RestoreDC(dc,saved));
    const POINT samples[]={{0,80},{220,120},{150,150},{220,180},{80,110},{300,210},{100,250},{419,264},{400,120},{220,264}};
    for(unsigned i=0;i<sizeof(samples)/sizeof(samples[0]);i++) {
        int x=samples[i].x,y=samples[i].y;
        BOOL inside=PtInRegion(region,x,y),edge=inside && !(PtInRegion(region,x-3,y)&&PtInRegion(region,x+3,y)&&PtInRegion(region,x,y-3)&&PtInRegion(region,x,y+3));
        COLORREF expected=!inside?RGB(255,255,255):edge?RGB(240,145,30):mode==6?RGB(25,130,90):RGB(28,85,138);
        CHECK(GetPixel(dc,x,y)==expected);
    }
    CHECK(DeleteObject(region) && DeleteObject(ink) && DeleteObject(orange));CHECK(EndPaint(window,&ps)); painted++;
    const WCHAR *titles[]={L"",L"Native shapes - alternate",L"Native shapes - winding",L"Native shapes - hole",L"Native shapes - rounded",L"Native shapes - ellipse",L"Native shapes - copied clip"};
    CHECK(SetWindowTextW(window,titles[mode]));
}
static LRESULT CALLBACK procedure(HWND window,UINT msg,WPARAM wp,LPARAM lp) {
    if(window==root && msg==WM_PAINT) {paint(window);return 0;}
    if(window==root && msg==WM_COMMAND && HIWORD(wp)==BN_CLICKED && LOWORD(wp)>=101 && LOWORD(wp)<=106) {mode=LOWORD(wp)-100;CHECK(InvalidateRect(root,NULL,TRUE));return 0;}
    if(window==root && (msg==WM_CLOSE || (msg==WM_KEYDOWN && wp==VK_ESCAPE))) {PostQuitMessage(0);return 0;}
    return DefWindowProcW(window,msg,wp,lp);
}
void start(void) {
    CHECK(!lstrcmpW(L"native",L"native"));sdk_checks();
    HINSTANCE module=GetModuleHandleW(NULL); WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=module;cls.hbrBackground=(HBRUSH)GetStockObject(WHITE_BRUSH);cls.lpszClassName=L"NativeShapes";CHECK(RegisterClassW(&cls));
    root=CreateWindowW(cls.lpszClassName,L"Native shapes",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,482,310,NULL,NULL,module,NULL);CHECK(root);
    const WCHAR *labels[]={L"Alternate",L"Winding",L"Hole",L"Rounded",L"Ellipse",L"Clip"};
    for(unsigned i=0;i<6;i++)CHECK(CreateWindowW(L"BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,5+(int)i*79,16,75,32,root,(HMENU)(101+i),module,NULL));
    SetFocus(root);CHECK(GetFocus()==root);
    MSG message;while(GetMessageW(&message,NULL,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}
    CHECK(painted && DestroyWindow(root));const CHAR pass[]="NATIVE SHAPES GUI PASS\n";DWORD written=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),pass,sizeof(pass)-1,&written,NULL)&&written==sizeof(pass)-1);ExitProcess((UINT)message.wParam);
}
