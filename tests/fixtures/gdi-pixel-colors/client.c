/* Original WineBrowser contributors, MIT. Native bitmap color GUI and ABI checks. */
#include <windows.h>
#include "native-cases.h"
#define CHECK(x) do {if(!(x))ExitProcess(1000+__LINE__);}while(0)
void *memset(void *target,int value,size_t count){BYTE *p=target;while(count--)*p++=(BYTE)value;return target;}
static HWND root;
static HDC memory[7];
static HBITMAP bitmap[7];
static HGDIOBJ oldbitmap[7];
static DWORD *bits[7];
static unsigned view,clipped,painted;
static void output(const CHAR *text,DWORD length){DWORD written=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),text,length,&written,NULL)&&written==length);}
static const COLORREF pages[4][7]={
 {0xffffff,RGB(5,6,7),RGB(7,8,9),RGB(127,128,129),RGB(250,249,248),RGB(19,47,181),RGB(64,96,128)},
 {0x01000001,0x01000013,0x020000a5,0xffabcdef,RGB(255,0,255),RGB(0,255,255),RGB(255,255,0)},
 {0x10ff0000,0x10ff0001,0x10ff0002,0x10ff0003,0x10ff0004,0x10ff000f,0x10ff00ff},
 {0x10ff0010,0x10ff0011,0x10ff0100,0x10ff0101,0x10ff01ff,0x10ffffff,0x10ff0000}
};
static const struct NativeCase *expected(unsigned type,COLORREF color){
 for(unsigned i=0;i<sizeof(cases)/sizeof(cases[0]);i++)if(cases[i].type==type&&cases[i].color==color)return &cases[i];
 ExitProcess(900);return NULL;
}
static void pixel(const struct NativeCase *c){
 *bits[c->type]=0x70406080;SetLastError(777);
 CHECK(SetPixel(memory[c->type],0,0,c->color)==c->result&&GetLastError()==c->error);
 CHECK(GetPixel(memory[c->type],0,0)==c->pixel&&*bits[c->type]==c->raw);
}
static void paint(HWND window){
 PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);
 RECT all={0,0,640,340},area={0,96,640,340};HBRUSH back=CreateSolidBrush(RGB(64,96,128));
 CHECK(back&&FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH))&&FillRect(dc,&area,back)&&DeleteObject(back));
 if(clipped){HRGN region=CreateRectRgn(96,120,560,312);CHECK(region&&SelectClipRgn(dc,region)&&DeleteObject(region));}
 for(unsigned type=0;type<7;type++)for(unsigned row=0;row<7;row++){
  pixel(expected(type,pages[view][row]));
  CHECK(StretchBlt(dc,16+(int)type*88,112+(int)row*32,72,24,memory[type],0,0,1,1,SRCCOPY));
 }
 CHECK(SelectClipRgn(dc,NULL)&&EndPaint(window,&ps));painted++;
 const WCHAR *titles[]={L"Native bitmap colors - RGB",L"Native bitmap colors - Palette",L"Native bitmap colors - Indices",L"Native bitmap colors - Edges"};
 CHECK(SetWindowTextW(window,clipped?L"Native bitmap colors - Clipped":titles[view]));
}
static LRESULT CALLBACK procedure(HWND window,UINT msg,WPARAM wp,LPARAM lp){
 if(window==root&&msg==WM_PAINT){paint(window);return 0;}
 if(window==root&&msg==WM_COMMAND&&HIWORD(wp)==BN_CLICKED&&LOWORD(wp)>=101&&LOWORD(wp)<=106){
  unsigned command=LOWORD(wp)-101;
  if(command<4){view=command;clipped=0;}else if(command==4)clipped=!clipped;else view=clipped=0;
  CHECK(InvalidateRect(root,NULL,TRUE));return 0;
 }
 if(window==root&&(msg==WM_CLOSE||(msg==WM_KEYDOWN&&wp==VK_ESCAPE))){PostQuitMessage(0);return 0;}
 return DefWindowProcW(window,msg,wp,lp);
}
void start(void){
 CHECK(!lstrcmpW(L"native",L"native"));
 for(unsigned type=0;type<7;type++){
  BYTE header[1064]={0};BITMAPINFO *bmi=(BITMAPINFO *)header;bmi->bmiHeader.biSize=40;bmi->bmiHeader.biWidth=1;bmi->bmiHeader.biHeight=-1;bmi->bmiHeader.biPlanes=1;int depths[]={16,16,24,32,8,1,4};bmi->bmiHeader.biBitCount=depths[type];
  if(type==1){bmi->bmiHeader.biCompression=BI_BITFIELDS;DWORD *m=(DWORD *)(header+40);m[0]=0xf800;m[1]=0x07e0;m[2]=0x001f;}
  if(type==4||type==6){bmi->bmiHeader.biClrUsed=4;DWORD table[]={0,0xff0000,0x00ff00,0xffffff};for(int i=0;i<4;i++)((DWORD *)(header+40))[i]=table[i];}
  if(type==5)((DWORD *)(header+40))[1]=0xffffff;
  memory[type]=CreateCompatibleDC(NULL);CHECK(memory[type]);bitmap[type]=CreateDIBSection(memory[type],bmi,0,(void **)&bits[type],NULL,0);CHECK(bitmap[type]&&bits[type]);oldbitmap[type]=SelectObject(memory[type],bitmap[type]);CHECK(oldbitmap[type]);
 }
 for(unsigned i=0;i<sizeof(cases)/sizeof(cases[0]);i++)pixel(&cases[i]);
 WCHAR checkOnly[2];if(GetEnvironmentVariableW(L"WINEBROWSER_COLORS_CHECK",checkOnly,2)==1&&checkOnly[0]==L'1'){
  for(unsigned i=0;i<7;i++)CHECK(SelectObject(memory[i],oldbitmap[i])&&DeleteObject(bitmap[i])&&DeleteDC(memory[i]));
  const CHAR pass[]="NATIVE BITMAP COLORS ABI PASS\n";output(pass,sizeof(pass)-1);ExitProcess(0);
 }
 HINSTANCE module=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=module;cls.hbrBackground=(HBRUSH)GetStockObject(WHITE_BRUSH);cls.lpszClassName=L"NativeBitmapColors";CHECK(RegisterClassW(&cls));
 root=CreateWindowW(cls.lpszClassName,L"Native bitmap colors",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,642,370,NULL,NULL,module,NULL);CHECK(root);
 const WCHAR *labels[]={L"RGB",L"Palette",L"Indices",L"Edges",L"Clip",L"Reset"};
 for(unsigned i=0;i<6;i++)CHECK(CreateWindowW(L"BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,8+(int)i*104,16,96,32,root,(HMENU)(101+i),module,NULL));
 const WCHAR *formats[]={L"RGB 555",L"RGB 565",L"RGB 24",L"RGB 32",L"Index 8",L"Mono 1",L"Index 4"};
 for(unsigned i=0;i<7;i++)CHECK(CreateWindowW(L"STATIC",formats[i],WS_CHILD|WS_VISIBLE|SS_CENTER,12+(int)i*88,68,80,24,root,(HMENU)(201+i),module,NULL));
 SetFocus(root);MSG message;while(GetMessageW(&message,NULL,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}
 CHECK(painted&&DestroyWindow(root));
 for(unsigned i=0;i<7;i++)CHECK(SelectObject(memory[i],oldbitmap[i])&&DeleteObject(bitmap[i])&&DeleteDC(memory[i]));
 const CHAR pass[]="NATIVE BITMAP COLORS GUI PASS\n";output(pass,sizeof(pass)-1);ExitProcess((UINT)message.wParam);
}
