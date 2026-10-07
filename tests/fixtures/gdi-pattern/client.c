/* Original WineBrowser contributors, MIT. Native pattern brush GUI. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(1000+__LINE__); } while(0)
static HWND root,label;
static HBRUSH color_brush,indirect_brush,mono_brush,hatch_brush;
static unsigned mode=1,painted,color_callbacks;
static const COLORREF colors[]={RGB(220,235,244),RGB(245,223,187),RGB(220,239,227),RGB(236,218,240)};
static DWORD bgr(COLORREF color) {return ((color&255)<<16)|(color&0xff00)|((color>>16)&255);}
static int mod(int value,int divisor) {int r=value%divisor;return r<0?r+divisor:r;}
static void brushes(void) {
    BITMAPINFO info={0};info.bmiHeader.biSize=40;info.bmiHeader.biWidth=16;info.bmiHeader.biHeight=-16;info.bmiHeader.biPlanes=1;info.bmiHeader.biBitCount=32;
    HDC display=GetDC(NULL);CHECK(display);DWORD *pixels=NULL;
    HBITMAP bitmap=CreateDIBSection(display,&info,DIB_RGB_COLORS,(void **)&pixels,NULL,0);CHECK(bitmap&&pixels);
    for(int y=0;y<16;y++)for(int x=0;x<16;x++)pixels[y*16+x]=bgr(colors[(y>=8?2:0)+(x>=8?1:0)]);
    color_brush=CreatePatternBrush(bitmap);LOGBRUSH description={BS_PATTERN,0,(ULONG_PTR)bitmap};indirect_brush=CreateBrushIndirect(&description);CHECK(color_brush&&indirect_brush);
    LOGBRUSH result={0};CHECK(GetObjectW(color_brush,sizeof(result),&result)==sizeof(result)&&result.lbStyle==BS_PATTERN&&result.lbColor==0&&result.lbHatch==(ULONG_PTR)bitmap);
    pixels[0]=0xff0000;CHECK(DeleteObject(bitmap));
    BYTE bits[16];for(int y=0;y<8;y++){bits[y*2]=y<4?0xf0:0x0f;bits[y*2+1]=0;}
    HBITMAP mono=CreateBitmap(8,8,1,1,bits);CHECK(mono);BITMAP query={0};CHECK(GetObjectW(mono,sizeof(query),&query)==sizeof(query)&&query.bmBitsPixel==1&&query.bmWidthBytes==2);
    mono_brush=CreatePatternBrush(mono);CHECK(mono_brush&&DeleteObject(mono));
    hatch_brush=CreateHatchBrush(HS_DIAGCROSS,RGB(40,70,120));CHECK(hatch_brush&&ReleaseDC(NULL,display));
}
static COLORREF expected(int x,int y) {
    int ox=(mode==3||mode==4||mode==5)?3:0,oy=(mode==3||mode==4||mode==5)?-5:0;
    if(mode==2)return (mod(x,8)<4)==(mod(y,8)<4)?RGB(25,130,90):RGB(240,145,30);
    if(mode==4){int a=mod(x-ox,8),b=mod(y-oy,8);return a==b||a+b==7?RGB(40,70,120):colors[0];}
    return colors[(mod(y-oy,16)>=8?2:0)+(mod(x-ox,16)>=8?1:0)];
}
static void paint(HWND window) {
    PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);RECT all={0,0,480,280},area={0,100,480,280};CHECK(FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH)));
    int saved=SaveDC(dc);CHECK(saved);POINT old,origin;int ox=(mode==3||mode==4||mode==5)?3:0,oy=(mode==3||mode==4||mode==5)?-5:0;
    CHECK(SetBrushOrgEx(dc,ox,oy,&old)&&old.x==0&&old.y==0);CHECK(GetBrushOrgEx(dc,&origin)&&origin.x==ox&&origin.y==oy);
    SetTextColor(dc,RGB(240,145,30));SetBkColor(dc,mode==4?colors[0]:RGB(25,130,90));CHECK(SetBkMode(dc,mode==2?TRANSPARENT:OPAQUE));
    HRGN clip=NULL;
    if(mode==5){RECT bounds={100,105,380,265};clip=CreateEllipticRgnIndirect(&bounds);CHECK(clip&&SelectClipRgn(dc,clip)==COMPLEXREGION&&DeleteObject(clip));clip=CreateRectRgn(0,0,0,0);CHECK(clip&&GetClipRgn(dc,clip)==1);}
    HBRUSH brush=mode==2?mono_brush:mode==3?indirect_brush:mode==4?hatch_brush:color_brush;
    if(mode==3){CHECK(SelectObject(dc,brush));CHECK(PatBlt(dc,area.left,area.top,area.right-area.left,area.bottom-area.top,PATCOPY));}
    else CHECK(FillRect(dc,&area,brush));
    CHECK(RestoreDC(dc,saved));CHECK(GetBrushOrgEx(dc,&origin)&&origin.x==0&&origin.y==0);
    static const POINT samples[]={{0,100},{1,101},{8,108},{15,115},{16,116},{170,140},{220,180},{300,240},{379,264},{479,279}};
    for(unsigned i=0;i<sizeof(samples)/sizeof(samples[0]);i++){int x=samples[i].x,y=samples[i].y;COLORREF want=mode==5&&!PtInRegion(clip,x,y)?RGB(255,255,255):expected(x,y);CHECK(GetPixel(dc,x,y)==want);}
    if(clip){CHECK(DeleteObject(clip));}CHECK(EndPaint(window,&ps));painted++;
    if(label)CHECK(InvalidateRect(label,NULL,TRUE));
    const WCHAR *titles[]={L"",L"Native tiles - color",L"Native tiles - mono",L"Native tiles - shifted",L"Native tiles - hatch",L"Native tiles - clipped"};CHECK(SetWindowTextW(window,titles[mode]));
}
static LRESULT CALLBACK procedure(HWND window,UINT msg,WPARAM wp,LPARAM lp) {
    if(window==root&&msg==WM_PAINT){paint(window);return 0;}
    if(window==root&&msg==WM_CTLCOLORSTATIC){HDC dc=(HDC)wp;SetTextColor(dc,RGB(20,40,60));SetBkColor(dc,RGB(25,130,90));CHECK(SetBkMode(dc,TRANSPARENT));CHECK(SetBrushOrgEx(dc,(mode==3||mode==5)?3:0,(mode==3||mode==5)?-5:0,NULL));color_callbacks++;return(LRESULT)color_brush;}
    if(window==root&&msg==WM_COMMAND&&HIWORD(wp)==BN_CLICKED&&LOWORD(wp)>=101&&LOWORD(wp)<=105){mode=LOWORD(wp)-100;CHECK(InvalidateRect(root,NULL,TRUE));return 0;}
    if(window==root&&(msg==WM_CLOSE||(msg==WM_KEYDOWN&&wp==VK_ESCAPE))){PostQuitMessage(0);return 0;}
    return DefWindowProcW(window,msg,wp,lp);
}
void start(void) {
    CHECK(!lstrcmpW(L"native",L"native"));brushes();HINSTANCE module=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=module;cls.hbrBackground=(HBRUSH)GetStockObject(WHITE_BRUSH);cls.lpszClassName=L"NativeTiles";CHECK(RegisterClassW(&cls));
    root=CreateWindowW(cls.lpszClassName,L"Native tiles",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,482,310,NULL,NULL,module,NULL);CHECK(root);
    const WCHAR *labels[]={L"Color",L"Mono",L"Shift",L"Hatch",L"Clip"};for(unsigned i=0;i<5;i++)CHECK(CreateWindowW(L"BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,12+(int)i*94,16,86,32,root,(HMENU)(101+i),module,NULL));
    label=CreateWindowW(L"STATIC",L"Native control color callback",WS_CHILD|WS_VISIBLE|SS_CENTER,20,62,440,26,root,(HMENU)200,module,NULL);CHECK(label);SetFocus(root);
    MSG message;while(GetMessageW(&message,NULL,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}
    CHECK(painted&&color_callbacks&&DestroyWindow(root));CHECK(DeleteObject(color_brush)&&DeleteObject(indirect_brush)&&DeleteObject(mono_brush)&&DeleteObject(hatch_brush));
    const CHAR pass[]="NATIVE PATTERN GUI PASS\n";DWORD written=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),pass,sizeof(pass)-1,&written,NULL)&&written==sizeof(pass)-1);ExitProcess((UINT)message.wParam);
}
