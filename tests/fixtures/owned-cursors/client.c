/* Original WineBrowser contributors, MIT. Native owned cursor GUI. */
#include "shapes.h"
#define CHECK(x) do{if(!(x))ExitProcess(1000+__LINE__);}while(0)
void *memset(void *target,int value,size_t count){BYTE *p=target;while(count--)*p++=(BYTE)value;return target;}
static HWND root;
static HCURSOR alpha,mono,copied,grown,offset,selected;
static BOOL hidden,retired;
static unsigned stage,painted;
static void check_info(HCURSOR cursor,unsigned width,unsigned height,unsigned hx,unsigned hy,BOOL monochrome){
 ICONINFO info={0};SetLastError(777);CHECK(GetIconInfo(cursor,&info)&&GetLastError()==777&&!info.fIcon&&info.xHotspot==hx&&info.yHotspot==hy);BITMAP mask={0};CHECK(GetObjectW(info.hbmMask,sizeof(mask),&mask)==sizeof(mask)&&mask.bmWidth==(LONG)width&&mask.bmHeight==(LONG)(monochrome?height*2:height)&&mask.bmBitsPixel==1);CHECK((info.hbmColor==NULL)==monochrome);if(info.hbmColor){BITMAP color={0};CHECK(GetObjectW(info.hbmColor,sizeof(color),&color)==sizeof(color)&&color.bmWidth==(LONG)width&&color.bmHeight==(LONG)height&&DeleteObject(info.hbmColor));}CHECK(DeleteObject(info.hbmMask));
}
static void paint(HWND window){
 PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);RECT all={0,0,640,340},area={0,96,640,340};HBRUSH back=CreateSolidBrush(RGB(64,96,128));CHECK(back&&FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH))&&FillRect(dc,&area,back)&&DeleteObject(back));
 HCURSOR icons[]={alpha,mono,copied,grown};for(int i=0;i<4;i++)if(icons[i])CHECK(DrawIconEx(dc,16+i*144,112,icons[i],112,112,0,NULL,DI_NORMAL));
 CHECK(EndPaint(window,&ps));painted++;
 const WCHAR *titles[]={L"Native owned cursors - Alpha",L"Native owned cursors - Mono",L"Native owned cursors - Copy",L"Native owned cursors - Grow",L"Native owned cursors - Hidden",L"Native owned cursors - Shown",L"Native owned cursors - Retired",L"Native owned cursors - Alpha",L"Native owned cursors - Offset"};CHECK(SetWindowTextW(window,titles[stage]));
}
static LRESULT CALLBACK procedure(HWND window,UINT msg,WPARAM wp,LPARAM lp){
 if(window==root&&msg==WM_SETCURSOR){if(!retired)SetCursor(selected);return TRUE;}
 if(window==root&&msg==WM_PAINT){paint(window);return 0;}
 if(window==root&&msg==WM_COMMAND&&HIWORD(wp)==BN_CLICKED&&LOWORD(wp)>=101&&LOWORD(wp)<=109){
  stage=LOWORD(wp)-101;
  if(stage==0||stage==1||stage==2||stage==3||stage==8){CHECK(!retired);selected=stage==0?alpha:stage==1?mono:stage==2?copied:stage==3?grown:offset;SetCursor(selected);}
  else if(stage==4){CHECK(!hidden&&ShowCursor(FALSE)==-1);hidden=TRUE;}
  else if(stage==5){CHECK(hidden&&ShowCursor(TRUE)==0);hidden=FALSE;}
  else if(stage==6){CHECK(selected==grown&&!retired&&GetCursor()==grown);SetLastError(777);CHECK(!DestroyCursor(grown)&&GetLastError()==777&&GetCursor()==grown);ICONINFO info={0};CHECK(!GetIconInfo(grown,&info)&&GetLastError()==ERROR_INVALID_CURSOR_HANDLE);grown=NULL;retired=TRUE;}
  else {if(hidden){CHECK(ShowCursor(TRUE)==0);hidden=FALSE;}SetCursor(alpha);if(!grown){grown=(HCURSOR)CopyImage(alpha,IMAGE_CURSOR,32,32,0);CHECK(grown);check_info(grown,32,32,3,5,FALSE);}selected=alpha;retired=FALSE;}
  CHECK(InvalidateRect(root,NULL,TRUE));return 0;
 }
 if(window==root&&(msg==WM_CLOSE||(msg==WM_KEYDOWN&&wp==VK_ESCAPE))){PostQuitMessage(0);return 0;}
 return DefWindowProcW(window,msg,wp,lp);
}
void start(void){
 CHECK(!lstrcmpW(L"native",L"native"));alpha=make_cursor(FALSE,3,5);mono=make_cursor(TRUE,2,4);offset=make_cursor(FALSE,19,31);CHECK(alpha&&mono&&offset);copied=CopyIcon(alpha);grown=(HCURSOR)CopyImage(alpha,IMAGE_CURSOR,32,32,LR_COPYRETURNORG);CHECK(copied&&grown&&copied!=alpha);check_info(alpha,16,16,3,5,FALSE);check_info(mono,16,16,2,4,TRUE);check_info(copied,16,16,3,5,FALSE);check_info(grown,32,32,3,5,FALSE);check_info(offset,16,16,19,31,FALSE);
 HCURSOR stock=LoadCursorW(NULL,IDC_ARROW);CHECK(stock);SetLastError(777);CHECK(DestroyCursor(stock)&&GetLastError()==777&&LoadCursorW(NULL,IDC_ARROW)==stock);
 selected=alpha;CHECK(SetCursor(alpha)==stock);
 HINSTANCE module=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=module;cls.hbrBackground=(HBRUSH)GetStockObject(WHITE_BRUSH);cls.lpszClassName=L"NativeOwnedCursors";CHECK(RegisterClassW(&cls));root=CreateWindowW(cls.lpszClassName,L"Native owned cursors",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,642,370,NULL,NULL,module,NULL);CHECK(root);
 const WCHAR *labels[]={L"Alpha",L"Mono",L"Copy",L"Grow",L"Hide",L"Show",L"Retire",L"Reset",L"Offset"};for(unsigned i=0;i<9;i++)CHECK(CreateWindowW(L"BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,8+(int)i*70,16,64,32,root,(HMENU)(101+i),module,NULL));
 const WCHAR *captions[]={L"Alpha 16",L"Mono / XOR",L"Copied 16",L"Scaled 32"};for(unsigned i=0;i<4;i++)CHECK(CreateWindowW(L"STATIC",captions[i],WS_CHILD|WS_VISIBLE|SS_CENTER,12+(int)i*144,68,120,24,root,(HMENU)(201+i),module,NULL));
 SetFocus(root);MSG message;while(GetMessageW(&message,NULL,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}
 if(hidden){ShowCursor(TRUE);}SetCursor(stock);CHECK(painted&&DestroyWindow(root)&&DestroyCursor(alpha)&&DestroyCursor(mono)&&DestroyIcon(copied)&&DestroyCursor(offset));if(grown)CHECK(DestroyCursor(grown));
 const CHAR pass[]="NATIVE OWNED CURSORS GUI PASS\n";DWORD written=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),pass,sizeof(pass)-1,&written,NULL)&&written==sizeof(pass)-1);ExitProcess((UINT)message.wParam);
}
