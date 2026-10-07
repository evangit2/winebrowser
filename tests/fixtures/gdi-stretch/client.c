/* Original WineBrowser contributors, MIT. Native SDK bitmap scaling GUI. */
#include <windows.h>
#define CHECK(x) do {if(!(x))ExitProcess(1000+__LINE__);}while(0)
static HWND root,captions;
static HDC memory;
static HBITMAP bitmap;
static HGDIOBJ oldbitmap;
static DWORD *destination;
static unsigned view=1,painted;
static const DWORD source[]={0x80102030,0x40405060,0xff708090,0x00a0b0c0,0x20d0e0f0,0x60332211,0x90446688,0xc0557799,0x006688aa};
static const int geometry[][8]={{2,2,12,12,0,0,3,3},{14,2,-12,12,0,0,3,3},{2,2,12,12,0,0,3,3},{2,2,10,10,1,1,2,1}};
static void tile(unsigned channel){
 CHECK(SelectClipRgn(memory,NULL));for(int i=0;i<256;i++)destination[i]=0x70406080;
 CHECK(SetStretchBltMode(memory,(int)channel+1));int saved=SaveDC(memory);CHECK(saved);
 if(view==3){HRGN clip=CreateRectRgn(3,3,13,14),hole=CreateRectRgn(6,6,10,10);CHECK(clip&&hole&&CombineRgn(clip,clip,hole,RGN_DIFF)==COMPLEXREGION&&SelectClipRgn(memory,clip)==COMPLEXREGION&&DeleteObject(clip)&&DeleteObject(hole));}
 if(view!=7){BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=3;bmi.bmiHeader.biHeight=-3;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;
 const int shrink[]={2,2,2,2,0,0,3,3};const int *a=view==8?shrink:geometry[view<=4?view-1:0];DWORD rop=view==5?SRCINVERT:SRCCOPY;
 if(view==6){CHECK(SetStretchBltMode(memory,HALFTONE)&&RestoreDC(memory,saved)&&GetStretchBltMode(memory)==(int)channel+1);saved=SaveDC(memory);CHECK(saved);}
 CHECK(StretchDIBits(memory,a[0],a[1],a[2],a[3],a[4],a[5],a[6],a[7],source,&bmi,DIB_RGB_COLORS,rop)==(view==5?-3:3));
 if(view==1||view==6)CHECK(destination[2*16+2]==(channel==3?0x00102030:source[0]));
 }
 CHECK(RestoreDC(memory,saved)&&GetStretchBltMode(memory)==(int)channel+1);
}
static void paint(HWND window){
 PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);RECT all={0,0,640,304},area={0,108,640,304};HBRUSH back=CreateSolidBrush(RGB(64,96,128));CHECK(back&&FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH))&&FillRect(dc,&area,back)&&DeleteObject(back));
 for(unsigned i=0;i<4;i++){tile(i);CHECK(StretchBlt(dc,16+(int)i*160,136,128,128,memory,view==8?2:0,view==8?2:0,view==8?2:16,view==8?2:16,SRCCOPY));}
 CHECK(EndPaint(window,&ps));painted++;
 const WCHAR *titles[]={L"",L"Native bitmap scaling - zoom",L"Native bitmap scaling - mirror",L"Native bitmap scaling - clipped",L"Native bitmap scaling - crop",L"Native bitmap scaling - ink",L"Native bitmap scaling - saved",L"Native bitmap scaling - empty",L"Native bitmap scaling - shrink"};CHECK(SetWindowTextW(window,titles[view]));
 CHECK(SetWindowTextW(captions,L"AND shrink          OR shrink           Nearest             Smooth"));
}
static LRESULT CALLBACK procedure(HWND window,UINT msg,WPARAM wp,LPARAM lp){
 if(window==root&&msg==WM_PAINT){paint(window);return 0;}
 if(window==root&&msg==WM_COMMAND&&HIWORD(wp)==BN_CLICKED&&LOWORD(wp)>=101&&LOWORD(wp)<=108){view=LOWORD(wp)-100;CHECK(InvalidateRect(root,NULL,TRUE));return 0;}
 if(window==root&&(msg==WM_CLOSE||(msg==WM_KEYDOWN&&wp==VK_ESCAPE))){PostQuitMessage(0);return 0;}
 return DefWindowProcW(window,msg,wp,lp);
}
void start(void){
 CHECK(!lstrcmpW(L"native",L"native"));memory=CreateCompatibleDC(NULL);CHECK(memory);BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=16;bmi.bmiHeader.biHeight=-16;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;bitmap=CreateDIBSection(memory,&bmi,0,(void **)&destination,NULL,0);CHECK(bitmap&&destination);oldbitmap=SelectObject(memory,bitmap);CHECK(oldbitmap&&GetStretchBltMode(memory)==BLACKONWHITE);
 HINSTANCE module=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=module;cls.hbrBackground=(HBRUSH)GetStockObject(WHITE_BRUSH);cls.lpszClassName=L"NativeBitmapScaling";CHECK(RegisterClassW(&cls));
 root=CreateWindowW(cls.lpszClassName,L"Native bitmap scaling",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,642,334,NULL,NULL,module,NULL);CHECK(root);
 const WCHAR *labels[]={L"Zoom",L"Mirror",L"Clip",L"Crop",L"Ink",L"Save",L"Clear",L"Shrink"};for(unsigned i=0;i<8;i++)CHECK(CreateWindowW(L"BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,8+(int)i*78,16,72,32,root,(HMENU)(101+i),module,NULL));
 captions=CreateWindowW(L"STATIC",L"",WS_CHILD|WS_VISIBLE|SS_CENTER,12,68,616,26,root,(HMENU)200,module,NULL);CHECK(captions);SetFocus(root);
 MSG message;while(GetMessageW(&message,NULL,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}
 CHECK(painted&&DestroyWindow(root)&&SelectObject(memory,oldbitmap)&&DeleteObject(bitmap)&&DeleteDC(memory));
 const CHAR pass[]="NATIVE BITMAP SCALING GUI PASS\n";DWORD written=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),pass,sizeof(pass)-1,&written,NULL)&&written==sizeof(pass)-1);ExitProcess((UINT)message.wParam);
}
