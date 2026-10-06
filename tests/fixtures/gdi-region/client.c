/* Original WineBrowser contributors, MIT. Native region geometry and drawing. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(1000 + __LINE__); } while (0)
static HWND root;
static unsigned mode = RGN_DIFF, painted;
static BOOL in_a(int x, int y) { return x >= 20 && x < 300 && y >= 70 && y < 230; }
static BOOL in_b(int x, int y) { return x >= 140 && x < 460 && y >= 100 && y < 250; }
static BOOL inside(int x, int y) {
    BOOL a = in_a(x,y), b = in_b(x,y);
    return mode == RGN_AND ? a && b : mode == RGN_OR ? a || b : mode == RGN_XOR ? a != b : a && !b;
}
static void sdk_checks(void) {
    RECT rect = {20,20,0,0}, box;
    HRGN outer = CreateRectRgnIndirect(&rect), hole = CreateRectRgn(4,4,16,16);
    CHECK(outer && hole && GetObjectType(outer) == OBJ_REGION);
    CHECK(GetRgnBox(outer,&box) == SIMPLEREGION && box.left == 0 && box.top == 0 && box.right == 20 && box.bottom == 20);
    CHECK(CombineRgn(outer,outer,hole,RGN_DIFF) == COMPLEXREGION);
    CHECK(PtInRegion(outer,0,0) && !PtInRegion(outer,4,4) && !PtInRegion(outer,20,0));
    rect.left=16; rect.top=16; rect.right=4; rect.bottom=4; CHECK(!RectInRegion(outer,&rect));
    rect.left=3; CHECK(RectInRegion(outer,&rect));
    DWORD bytes=GetRegionData(outer,0,NULL); CHECK(bytes==96);
    struct { DWORD data[24]; DWORD guard; } output; output.guard=0x12345678;
    CHECK(GetRegionData(outer,bytes,(RGNDATA *)output.data)==bytes && output.guard==0x12345678);
    CHECK(output.data[0]==32 && output.data[1]==RDH_RECTANGLES && output.data[2]==4 && output.data[3]==64);
    HRGN copy=ExtCreateRegion(NULL,bytes,(RGNDATA *)output.data); CHECK(copy && EqualRgn(copy,outer));
    CHECK(OffsetRgn(copy,-3,7)==COMPLEXREGION && OffsetRgn(copy,3,-7)==COMPLEXREGION && EqualRgn(copy,outer));
    CHECK(CombineRgn(copy,outer,(HRGN)0xdead,RGN_COPY)==COMPLEXREGION);
    CHECK(SetRectRgn(copy,2,2,2,8) && GetRgnBox(copy,&box)==NULLREGION && !box.left && !box.top && !box.right && !box.bottom);
    CHECK(DeleteObject(copy) && DeleteObject(hole) && DeleteObject(outer));
}
static void paint(HWND window) {
    PAINTSTRUCT ps; HDC dc=BeginPaint(window,&ps); CHECK(dc && GetObjectType(dc)==OBJ_DC);
    RECT all={0,0,500,260}, hole_rect={4,4,16,16};
    CHECK(FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH)));
    int saved=SaveDC(dc); CHECK(saved);
    HRGN clip=CreateRectRgn(0,0,20,20), cut=CreateRectRgn(4,4,16,16), copied=CreateRectRgn(0,0,0,0);
    CHECK(clip && cut && copied && CombineRgn(clip,clip,cut,RGN_DIFF)==COMPLEXREGION);
    CHECK((INT_PTR)SelectObject(dc,clip)==COMPLEXREGION && DeleteObject(clip) && DeleteObject(cut));
    CHECK(GetClipRgn(dc,copied)==1 && !PtInRegion(copied,5,5));
    CHECK(!RectVisible(dc,&hole_rect));
    CHECK(ExtSelectClipRgn(dc,copied,RGN_XOR)==NULLREGION);
    CHECK(SelectClipRgn(dc,copied)==COMPLEXREGION && DeleteObject(copied));
    CHECK(SetPixel(dc,5,5,RGB(255,0,0))==CLR_INVALID);
    CHECK(RestoreDC(dc,saved) && GetPixel(dc,5,5)==RGB(255,255,255));
    HRGN a=CreateRectRgn(20,70,300,230), b=CreateRectRgn(140,100,460,250);
    CHECK(a && b && CombineRgn(a,a,b,(int)mode)==(mode==RGN_AND ? SIMPLEREGION : COMPLEXREGION));
    HBRUSH blue=CreateSolidBrush(RGB(28,85,138)), orange=CreateSolidBrush(RGB(240,145,30)); CHECK(blue && orange);
    CHECK(FillRgn(dc,a,blue) && FrameRgn(dc,a,orange,3,3));
    static const POINT samples[]={{0,50},{20,70},{30,80},{145,105},{150,110},{290,220},{298,220},{305,220},{450,245},{460,245}};
    for(unsigned i=0;i<sizeof(samples)/sizeof(samples[0]);i++) {
        int x=samples[i].x,y=samples[i].y;
        BOOL frame=inside(x,y) && !(inside(x-3,y)&&inside(x+3,y)&&inside(x,y-3)&&inside(x,y+3));
        COLORREF expected=!inside(x,y) ? RGB(255,255,255) : frame ? RGB(240,145,30) : RGB(28,85,138);
        CHECK(GetPixel(dc,x,y)==expected);
    }
    CHECK(DeleteObject(a) && DeleteObject(b) && DeleteObject(blue) && DeleteObject(orange));
    CHECK(EndPaint(window,&ps)); painted++;
    CHECK(SetWindowTextW(window, mode==RGN_AND ? L"Native regions - intersection" : mode==RGN_OR ? L"Native regions - union" : mode==RGN_XOR ? L"Native regions - xor" : L"Native regions - difference"));
}
static LRESULT CALLBACK procedure(HWND window, UINT message, WPARAM wp, LPARAM lp) {
    if(window==root && message==WM_PAINT) { paint(window); return 0; }
    if(window==root && message==WM_COMMAND && HIWORD(wp)==BN_CLICKED && LOWORD(wp)>=101 && LOWORD(wp)<=104) {
        mode=LOWORD(wp)==101 ? RGN_DIFF : LOWORD(wp)==102 ? RGN_OR : LOWORD(wp)==103 ? RGN_XOR : RGN_AND;
        CHECK(InvalidateRect(root,NULL,TRUE)); return 0;
    }
    if(window==root && (message==WM_CLOSE || (message==WM_KEYDOWN && wp==VK_ESCAPE))) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(window,message,wp,lp);
}
void start(void) {
    CHECK(!lstrcmpW(L"native",L"native")); sdk_checks();
    HINSTANCE module=GetModuleHandleW(NULL); WNDCLASSW cls={0};
    cls.lpfnWndProc=procedure; cls.hInstance=module; cls.hbrBackground=(HBRUSH)GetStockObject(WHITE_BRUSH); cls.lpszClassName=L"NativeRegions";
    CHECK(RegisterClassW(&cls));
    root=CreateWindowW(cls.lpszClassName,L"Native regions",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,502,290,NULL,NULL,module,NULL); CHECK(root);
    const WCHAR *labels[]={L"Difference",L"Union",L"Xor",L"Intersection"};
    for(unsigned i=0;i<4;i++) CHECK(CreateWindowW(L"BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,18+(int)i*118,16,110,32,root,(HMENU)(101+i),module,NULL));
    SetFocus(root); CHECK(GetFocus()==root);
    MSG message; while(GetMessageW(&message,NULL,0,0)>0) {TranslateMessage(&message); DispatchMessageW(&message);}
    CHECK(painted && DestroyWindow(root));
    const CHAR pass[]="NATIVE REGION GUI PASS\n"; DWORD written=0;
    CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),pass,sizeof(pass)-1,&written,NULL) && written==sizeof(pass)-1);
    ExitProcess((UINT)message.wParam);
}
