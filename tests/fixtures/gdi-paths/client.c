/* Original WineBrowser contributors, MIT. Native SDK path drawing GUI. */
#include <windows.h>
#define CHECK(x) do {if(!(x))ExitProcess(1000+__LINE__);}while(0)
static HWND root,captions;
static HDC memory;
static HBITMAP bitmap;
static HBRUSH ink;
static HPEN pen;
static HGDIOBJ oldbitmap,oldbrush,oldpen;
static unsigned mode=1,painted;
static const POINT star[]={{2,2},{16,29},{29,2},{2,20},{29,20}};
static const POINT rings[]={{2,2},{29,2},{29,29},{2,29},{8,8},{23,8},{23,23},{8,23}};
static const POINT reversed[]={{2,2},{29,2},{29,29},{2,29},{8,23},{23,23},{23,8},{8,8}};
static const POINT lines[]={{2,2},{16,16},{29,2},{2,29},{16,16},{29,29}};
static void objects(void){
 memory=CreateCompatibleDC(NULL);CHECK(memory);BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=32;bmi.bmiHeader.biHeight=-32;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;void *bits;bitmap=CreateDIBSection(memory,&bmi,0,&bits,NULL,0);CHECK(bitmap&&bits);oldbitmap=SelectObject(memory,bitmap);CHECK(oldbitmap);
 ink=CreateSolidBrush(RGB(240,145,30));CHECK(ink);oldbrush=SelectObject(memory,ink);CHECK(oldbrush);oldpen=SelectObject(memory,GetStockObject(NULL_PEN));CHECK(oldpen);
 LOGPEN descriptor={PS_SOLID,{-1,99},RGB(255,255,255)},copy={0};pen=CreatePenIndirect(&descriptor);CHECK(pen&&GetObjectW(pen,sizeof(copy),&copy)==sizeof(copy)&&copy.lopnStyle==PS_SOLID&&copy.lopnWidth.x==1&&copy.lopnWidth.y==0&&copy.lopnColor==RGB(255,255,255));
 CHECK(GetPolyFillMode(memory)==ALTERNATE);int saved=SaveDC(memory);CHECK(saved&&SetPolyFillMode(memory,WINDING)==ALTERNATE&&GetPolyFillMode(memory)==WINDING&&RestoreDC(memory,saved)&&GetPolyFillMode(memory)==ALTERNATE);
}
static void tile(unsigned channel){
 RECT all={0,0,32,32};HBRUSH back=CreateSolidBrush(RGB(64,96,128));CHECK(back&&FillRect(memory,&all,back)&&DeleteObject(back));CHECK(SelectClipRgn(memory,NULL));
 int saved=SaveDC(memory);CHECK(saved);CHECK(SetPolyFillMode(memory,channel==0?ALTERNATE:WINDING));
 if(mode==3||(mode==4&&channel==1)){HRGN clip=CreateRectRgn(3,5,28,27),hole=CreateRectRgn(12,12,20,20);CHECK(clip&&hole&&CombineRgn(clip,clip,hole,RGN_DIFF)==COMPLEXREGION&&SelectClipRgn(memory,clip)==COMPLEXREGION&&DeleteObject(clip)&&DeleteObject(hole));}
 POINT previous;CHECK(MoveToEx(memory,7,9,&previous));
 if(mode==6){CHECK(PolyPolyline(memory,NULL,NULL,0)&&PolyPolygon(memory,NULL,NULL,0));}
 else if(mode==2){const INT counts[]={4,4};CHECK(PolyPolygon(memory,channel==2?reversed:rings,counts,2));}
 else if(mode==4||(channel==2&&(mode==1||mode==3))){const DWORD counts[]={3,3};CHECK(SelectObject(memory,pen)&&PolyPolyline(memory,lines,counts,2));}
 else {if(mode==3)CHECK(SetPolyFillMode(memory,WINDING));if(mode==5){CHECK(SetPolyFillMode(memory,ALTERNATE));int inner=SaveDC(memory);CHECK(inner&&SetPolyFillMode(memory,WINDING)==ALTERNATE);if(channel!=1)CHECK(RestoreDC(memory,inner)&&GetPolyFillMode(memory)==ALTERNATE);CHECK(Polygon(memory,star,5));if(channel==1)CHECK(RestoreDC(memory,inner)&&GetPolyFillMode(memory)==ALTERNATE);}else CHECK(Polygon(memory,star,5));}
 POINT current;CHECK(GetCurrentPositionEx(memory,&current)&&current.x==7&&current.y==9);CHECK(RestoreDC(memory,saved));
}
static void paint(HWND window){
 PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);RECT all={0,0,480,280},area={0,100,480,280};HBRUSH back=CreateSolidBrush(RGB(64,96,128));CHECK(back&&FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH))&&FillRect(dc,&area,back)&&DeleteObject(back));
 for(unsigned i=0;i<3;i++){tile(i);CHECK(StretchBlt(dc,16+(int)i*160,120,128,128,memory,0,0,32,32,SRCCOPY));}
 CHECK(EndPaint(window,&ps));painted++;
 const WCHAR *labels[]={L"",L"Alternate         Winding         Line groups",L"Alternate         Winding         Opposite",L"Clipped winding     Clipped winding     Clipped lines",L"Solid             Clipped             Solid",L"Before             Saved mode             Restored",L"Empty             Empty             Empty"};CHECK(SetWindowTextW(captions,labels[mode]));
 const WCHAR *titles[]={L"",L"Native paths - stars",L"Native paths - rings",L"Native paths - clipped",L"Native paths - lines",L"Native paths - saved",L"Native paths - empty"};CHECK(SetWindowTextW(window,titles[mode]));
}
static LRESULT CALLBACK procedure(HWND window,UINT msg,WPARAM wp,LPARAM lp){
 if(window==root&&msg==WM_PAINT){paint(window);return 0;}
 if(window==root&&msg==WM_COMMAND&&HIWORD(wp)==BN_CLICKED&&LOWORD(wp)>=101&&LOWORD(wp)<=106){mode=LOWORD(wp)-100;CHECK(InvalidateRect(root,NULL,TRUE));return 0;}
 if(window==root&&(msg==WM_CLOSE||(msg==WM_KEYDOWN&&wp==VK_ESCAPE))){PostQuitMessage(0);return 0;}
 return DefWindowProcW(window,msg,wp,lp);
}
void start(void){
 CHECK(!lstrcmpW(L"native",L"native"));objects();HINSTANCE module=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=module;cls.hbrBackground=(HBRUSH)GetStockObject(WHITE_BRUSH);cls.lpszClassName=L"NativePaths";CHECK(RegisterClassW(&cls));
 root=CreateWindowW(cls.lpszClassName,L"Native paths",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,482,310,NULL,NULL,module,NULL);CHECK(root);
 const WCHAR *labels[]={L"Stars",L"Rings",L"Clip",L"Lines",L"Save",L"Clear"};for(unsigned i=0;i<6;i++)CHECK(CreateWindowW(L"BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,8+(int)i*78,16,72,32,root,(HMENU)(101+i),module,NULL));
 captions=CreateWindowW(L"STATIC",L"",WS_CHILD|WS_VISIBLE|SS_CENTER,12,62,456,26,root,(HMENU)200,module,NULL);CHECK(captions);SetFocus(root);
 MSG message;while(GetMessageW(&message,NULL,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}
 CHECK(painted&&DestroyWindow(root));CHECK(SelectObject(memory,oldbitmap)&&SelectObject(memory,oldbrush)&&SelectObject(memory,oldpen)&&DeleteObject(bitmap)&&DeleteObject(ink)&&DeleteObject(pen)&&DeleteDC(memory));
 const CHAR pass[]="NATIVE PATH GUI PASS\n";DWORD written=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),pass,sizeof(pass)-1,&written,NULL)&&written==sizeof(pass)-1);ExitProcess((UINT)message.wParam);
}
