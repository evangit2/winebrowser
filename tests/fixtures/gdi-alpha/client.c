/* Original WineBrowser contributors, MIT. Native SDK alpha blending GUI. */
#include <windows.h>
__declspec(dllimport) BOOL WINAPI GdiAlphaBlend(HDC,int,int,int,int,HDC,int,int,int,int,BLENDFUNCTION);
#define CHECK(x) do {if(!(x))ExitProcess(1000+__LINE__);}while(0)
static HWND root,captions;
static HDC source;
static HBITMAP bitmap;
static HGDIOBJ previous;
static unsigned mode=1,painted;
static const DWORD colors[]={0x80102030,0x40602010,0xff204080,0x00000000};
static void objects(void){
 HDC display=GetDC(NULL);CHECK(display);source=CreateCompatibleDC(display);CHECK(source);BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=2;bmi.bmiHeader.biHeight=-2;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;DWORD *bits;
 bitmap=CreateDIBSection(display,&bmi,0,(void **)&bits,NULL,0);CHECK(bitmap&&bits);previous=SelectObject(source,bitmap);CHECK(previous);for(unsigned i=0;i<4;i++)bits[i]=colors[i];CHECK(ReleaseDC(NULL,display));
 /* Native memory destination verifies AlphaBlend's actual reserved alpha bytes. */
 HDC target=CreateCompatibleDC(NULL);CHECK(target);DWORD *output;HBITMAP destination=CreateDIBSection(target,&bmi,0,(void **)&output,NULL,0);CHECK(destination&&output);HGDIOBJ old=SelectObject(target,destination);CHECK(old);for(unsigned i=0;i<4;i++)output[i]=0x70406080;
 BLENDFUNCTION blend={AC_SRC_OVER,0,128,AC_SRC_ALPHA};CHECK(GdiAlphaBlend(target,0,0,2,2,source,0,0,2,2,blend));CHECK(GetPixel(target,0,0)==RGB(56,88,120));CHECK(output[0]==0x94385878);
 CHECK(SelectObject(target,old)&&DeleteObject(destination)&&DeleteDC(target));
}
static void paint(HWND window){
 PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);RECT all={0,0,480,280},area={0,100,480,280};HBRUSH back=CreateSolidBrush(RGB(64,96,128));CHECK(back&&FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH))&&FillRect(dc,&area,back)&&DeleteObject(back));
 int saved=SaveDC(dc);CHECK(saved);
 if(mode==4){HRGN clip=CreateRectRgn(80,140,400,220),hole=CreateRectRgn(100,160,120,180);CHECK(clip&&hole&&CombineRgn(clip,clip,hole,RGN_DIFF)==COMPLEXREGION&&SelectClipRgn(dc,clip)==COMPLEXREGION&&DeleteObject(clip)&&DeleteObject(hole));}
 const BYTE normal[]={64,128,255},low[]={1,2,64};
 for(unsigned i=0;i<3;i++){
  BLENDFUNCTION blend={AC_SRC_OVER,0,mode==3?low[i]:mode==5?0:mode==6?255:normal[i],mode==1?0:AC_SRC_ALPHA};
  CHECK(i==1?GdiAlphaBlend(dc,16+(int)i*160,120,128,128,source,0,0,2,2,blend):AlphaBlend(dc,16+(int)i*160,120,128,128,source,0,0,2,2,blend));
 }
 CHECK(RestoreDC(dc,saved));CHECK(GetPixel(dc,0,100)==RGB(64,96,128));CHECK(EndPaint(window,&ps));painted++;
 CHECK(SetWindowTextW(captions,mode==3?L"1/255           2/255           64/255":mode==5?L"0%               0%               0%":mode==6?L"100%             100%             100%":L"25%             50%             100%"));
 const WCHAR *titles[]={L"",L"Native alpha - global",L"Native alpha - pixel",L"Native alpha - low",L"Native alpha - clipped",L"Native alpha - zero",L"Native alpha - full"};CHECK(SetWindowTextW(window,titles[mode]));
}
static LRESULT CALLBACK procedure(HWND window,UINT msg,WPARAM wp,LPARAM lp){
 if(window==root&&msg==WM_PAINT){paint(window);return 0;}
 if(window==root&&msg==WM_COMMAND&&HIWORD(wp)==BN_CLICKED&&LOWORD(wp)>=101&&LOWORD(wp)<=106){mode=LOWORD(wp)-100;CHECK(InvalidateRect(root,NULL,TRUE));return 0;}
 if(window==root&&(msg==WM_CLOSE||(msg==WM_KEYDOWN&&wp==VK_ESCAPE))){PostQuitMessage(0);return 0;}
 return DefWindowProcW(window,msg,wp,lp);
}
void start(void){
 CHECK(!lstrcmpW(L"native",L"native"));objects();HINSTANCE module=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=module;cls.hbrBackground=(HBRUSH)GetStockObject(WHITE_BRUSH);cls.lpszClassName=L"NativeAlphaBlend";CHECK(RegisterClassW(&cls));
 root=CreateWindowW(cls.lpszClassName,L"Native alpha",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,482,310,NULL,NULL,module,NULL);CHECK(root);
 const WCHAR *labels[]={L"Global",L"Pixel",L"Low",L"Clip",L"Zero",L"Full"};for(unsigned i=0;i<6;i++)CHECK(CreateWindowW(L"BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,8+(int)i*78,16,72,32,root,(HMENU)(101+i),module,NULL));
 captions=CreateWindowW(L"STATIC",L"",WS_CHILD|WS_VISIBLE|SS_CENTER,12,62,456,26,root,(HMENU)200,module,NULL);CHECK(captions);SetFocus(root);
 MSG message;while(GetMessageW(&message,NULL,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}
 CHECK(painted&&DestroyWindow(root));CHECK(SelectObject(source,previous)&&DeleteObject(bitmap)&&DeleteDC(source));
 const CHAR pass[]="NATIVE ALPHA GUI PASS\n";DWORD written=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),pass,sizeof(pass)-1,&written,NULL)&&written==sizeof(pass)-1);ExitProcess((UINT)message.wParam);
}
