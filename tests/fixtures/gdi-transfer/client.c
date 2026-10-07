/* Original WineBrowser contributors, MIT. Native SDK scanline bitmap transfer GUI. */
#include "drawing.h"
#define CHECK(x) do {if(!(x))ExitProcess(1000+__LINE__);}while(0)
static HWND root,captions;
static HDC memory;
static HBITMAP bitmap;
static HGDIOBJ oldbitmap;
static DWORD *destination;
static unsigned view=1,painted;
static void tile(unsigned channel){
 int result=sample(memory,destination,(int)channel,(int)view);
 int expected=view==7?0:view==2?1:view==3?2:view==6?(channel==0?3:5):view==8?(channel==0?1:3):3;
 CHECK(result==expected&&GetLastError()==777);
 if(view==1)CHECK(destination[2*16+2]==(channel==0?0x90446688:channel==1?0x80102030:channel==2?0x00332211:0x00183c08));
 CHECK(SelectClipRgn(memory,NULL));
}
static void paint(HWND window){
 PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);RECT all={0,0,640,304},area={0,108,640,304};HBRUSH back=CreateSolidBrush(RGB(64,96,128));CHECK(back&&FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH))&&FillRect(dc,&area,back)&&DeleteObject(back));
 for(unsigned i=0;i<4;i++){tile(i);CHECK(StretchBlt(dc,16+(int)i*160,136,128,128,memory,2,2,3,3,SRCCOPY));}
 CHECK(EndPaint(window,&ps));painted++;
 const WCHAR *titles[]={L"",L"Native bitmap transfer - full",L"Native bitmap transfer - partial",L"Native bitmap transfer - start",L"Native bitmap transfer - crop",L"Native bitmap transfer - clipped",L"Native bitmap transfer - extra",L"Native bitmap transfer - empty",L"Native bitmap transfer - pixel"};CHECK(SetWindowTextW(window,titles[view]));
 CHECK(SetWindowTextW(captions,L"32-bit bottom       32-bit top          24-bit RGB         16-bit 565"));
}
static LRESULT CALLBACK procedure(HWND window,UINT msg,WPARAM wp,LPARAM lp){
 if(window==root&&msg==WM_PAINT){paint(window);return 0;}
 if(window==root&&msg==WM_COMMAND&&HIWORD(wp)==BN_CLICKED&&LOWORD(wp)>=101&&LOWORD(wp)<=108){view=LOWORD(wp)-100;CHECK(InvalidateRect(root,NULL,TRUE));return 0;}
 if(window==root&&(msg==WM_CLOSE||(msg==WM_KEYDOWN&&wp==VK_ESCAPE))){PostQuitMessage(0);return 0;}
 return DefWindowProcW(window,msg,wp,lp);
}
void start(void){
 CHECK(!lstrcmpW(L"native",L"native"));memory=CreateCompatibleDC(NULL);CHECK(memory);BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=16;bmi.bmiHeader.biHeight=-16;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;bitmap=CreateDIBSection(memory,&bmi,0,(void **)&destination,NULL,0);CHECK(bitmap&&destination);oldbitmap=SelectObject(memory,bitmap);CHECK(oldbitmap);
 HINSTANCE module=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=module;cls.hbrBackground=(HBRUSH)GetStockObject(WHITE_BRUSH);cls.lpszClassName=L"NativeBitmapTransfer";CHECK(RegisterClassW(&cls));
 root=CreateWindowW(cls.lpszClassName,L"Native bitmap transfer",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,642,334,NULL,NULL,module,NULL);CHECK(root);
 const WCHAR *labels[]={L"Full",L"Partial",L"Start",L"Crop",L"Clip",L"Extra",L"Clear",L"Pixel"};for(unsigned i=0;i<8;i++)CHECK(CreateWindowW(L"BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,8+(int)i*78,16,72,32,root,(HMENU)(101+i),module,NULL));
 captions=CreateWindowW(L"STATIC",L"",WS_CHILD|WS_VISIBLE|SS_CENTER,12,68,616,26,root,(HMENU)200,module,NULL);CHECK(captions);SetFocus(root);
 MSG message;while(GetMessageW(&message,NULL,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}
 CHECK(painted&&DestroyWindow(root)&&SelectObject(memory,oldbitmap)&&DeleteObject(bitmap)&&DeleteDC(memory));
 const CHAR pass[]="NATIVE BITMAP TRANSFER GUI PASS\n";DWORD written=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),pass,sizeof(pass)-1,&written,NULL)&&written==sizeof(pass)-1);ExitProcess((UINT)message.wParam);
}
