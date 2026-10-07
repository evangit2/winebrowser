/* Original WineBrowser contributors, MIT. Native frame/focus GUI. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(1000+__LINE__); } while(0)
static HWND root;
static HBRUSH back,solid,hatch,pattern;
static unsigned mode=1,painted;
static void brushes(void) {
    back=CreateSolidBrush(RGB(220,235,244));solid=CreateSolidBrush(RGB(40,70,120));hatch=CreateHatchBrush(HS_DIAGCROSS,RGB(40,70,120));CHECK(back&&solid&&hatch);
    HDC display=GetDC(NULL);CHECK(display);BITMAPINFO info={0};info.bmiHeader.biSize=40;info.bmiHeader.biWidth=2;info.bmiHeader.biHeight=-2;info.bmiHeader.biPlanes=1;info.bmiHeader.biBitCount=32;DWORD *bits=NULL;
    HBITMAP tile=CreateDIBSection(display,&info,DIB_RGB_COLORS,(void **)&bits,NULL,0);CHECK(tile&&bits);bits[0]=0xe87818;bits[1]=0x188858;bits[2]=0x9850b8;bits[3]=0xe87818;pattern=CreatePatternBrush(tile);CHECK(pattern&&DeleteObject(tile)&&ReleaseDC(NULL,display));
}
static void paint(HWND window) {
    PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);
    RECT all={0,0,480,280},area={0,100,480,280},frame={30,110,450,260},focus={36,116,444,254};CHECK(FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH))&&FillRect(dc,&area,back));
    int saved=SaveDC(dc);CHECK(saved);HBRUSH brush=mode==4?hatch:mode==5?pattern:solid;
    CHECK(SelectObject(dc,back));CHECK(SetTextColor(dc,RGB(200,30,40))!=CLR_INVALID);CHECK(SetBkColor(dc,RGB(30,200,40))!=CLR_INVALID);CHECK(SetBkMode(dc,TRANSPARENT));
    CHECK(SetBrushOrgEx(dc,(mode==4||mode==5)?3:0,(mode==4||mode==5)?-5:0,NULL));
    if(mode==6){HRGN a=CreateRectRgn(0,100,400,260),b=CreateRectRgn(200,110,250,120);CHECK(a&&b&&CombineRgn(a,a,b,RGN_DIFF)==COMPLEXREGION&&SelectClipRgn(dc,a)==COMPLEXREGION&&DeleteObject(a)&&DeleteObject(b));}
    CHECK(FrameRect(dc,&frame,brush));CHECK(SelectObject(dc,back)==back);
    if(mode==2||mode==3||mode==6){CHECK(DrawFocusRect(dc,&focus));CHECK(GetPixel(dc,443,116)==(RGB(220,235,244)^0xffffff)||mode==6);}
    if(mode==3){CHECK(DrawFocusRect(dc,&focus));CHECK(GetPixel(dc,443,116)==RGB(220,235,244));}
    CHECK(GetTextColor(dc)==RGB(200,30,40)&&GetBkColor(dc)==RGB(30,200,40)&&GetBkMode(dc)==TRANSPARENT);
    CHECK(RestoreDC(dc,saved));POINT origin;CHECK(GetBrushOrgEx(dc,&origin)&&origin.x==0&&origin.y==0);
    CHECK(GetPixel(dc,0,100)==RGB(220,235,244)&&GetPixel(dc,100,140)==RGB(220,235,244));
    if(mode<=3||mode==6)CHECK(GetPixel(dc,30,110)==RGB(40,70,120));
    CHECK(EndPaint(window,&ps));painted++;
    const WCHAR *titles[]={L"",L"Native frames - solid",L"Native frames - focus",L"Native frames - erased",L"Native frames - hatch",L"Native frames - pattern",L"Native frames - clipped"};CHECK(SetWindowTextW(window,titles[mode]));
}
static LRESULT CALLBACK procedure(HWND window,UINT msg,WPARAM wp,LPARAM lp) {
    if(window==root&&msg==WM_PAINT){paint(window);return 0;}
    if(window==root&&msg==WM_COMMAND&&HIWORD(wp)==BN_CLICKED&&LOWORD(wp)>=101&&LOWORD(wp)<=106){mode=LOWORD(wp)-100;CHECK(InvalidateRect(root,NULL,TRUE));return 0;}
    if(window==root&&(msg==WM_CLOSE||(msg==WM_KEYDOWN&&wp==VK_ESCAPE))){PostQuitMessage(0);return 0;}
    return DefWindowProcW(window,msg,wp,lp);
}
void start(void) {
    CHECK(!lstrcmpW(L"native",L"native"));brushes();HINSTANCE module=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=module;cls.hbrBackground=(HBRUSH)GetStockObject(WHITE_BRUSH);cls.lpszClassName=L"NativeFrames";CHECK(RegisterClassW(&cls));
    root=CreateWindowW(cls.lpszClassName,L"Native frames",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,482,310,NULL,NULL,module,NULL);CHECK(root);
    const WCHAR *labels[]={L"Frame",L"Focus",L"Erase",L"Hatch",L"Pattern",L"Clip"};for(unsigned i=0;i<6;i++)CHECK(CreateWindowW(L"BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,8+(int)i*78,16,72,32,root,(HMENU)(101+i),module,NULL));
    CHECK(CreateWindowW(L"STATIC",L"Draw focus twice to erase it.",WS_CHILD|WS_VISIBLE|SS_CENTER,12,62,456,26,root,(HMENU)200,module,NULL));SetFocus(root);
    MSG message;while(GetMessageW(&message,NULL,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}
    CHECK(painted&&DestroyWindow(root));CHECK(DeleteObject(back)&&DeleteObject(solid)&&DeleteObject(hatch)&&DeleteObject(pattern));
    const CHAR pass[]="NATIVE FRAME GUI PASS\n";DWORD written=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),pass,sizeof(pass)-1,&written,NULL)&&written==sizeof(pass)-1);ExitProcess((UINT)message.wParam);
}
