/* Original WineBrowser contributors, MIT. Native bitmap icon GUI. */
#include <windows.h>
#define CHECK(x) do {if(!(x))ExitProcess(1000+__LINE__);}while(0)
static HWND root;
static HICON color,alpha,mono,copied,roundtrip;
static unsigned mode=1,painted;
static HICON make(int type){
 BYTE maskbits[]={0x80,0,0x40,0,0xc0,0,0x40,0};HBITMAP mask=CreateBitmap(2,type==3?4:2,1,1,maskbits);CHECK(mask);
 ICONINFO info={TRUE,20,30,mask,NULL};HBITMAP bitmap=NULL;
 if(type!=3){HDC display=GetDC(NULL);BITMAPINFO bmi={0};bmi.bmiHeader.biSize=40;bmi.bmiHeader.biWidth=2;bmi.bmiHeader.biHeight=-2;bmi.bmiHeader.biPlanes=1;bmi.bmiHeader.biBitCount=32;DWORD *bits;bitmap=CreateDIBSection(display,&bmi,0,(void **)&bits,NULL,0);CHECK(bitmap&&bits);DWORD values[]={0x00102030,0x00405060,0x00708090,0x00a0b0c0};for(unsigned i=0;i<4;i++)bits[i]=values[i]|(type==2?(i==3?0xff000000:0x80000000):0);info.hbmColor=bitmap;CHECK(ReleaseDC(NULL,display));}
 HICON icon=CreateIconIndirect(&info);CHECK(icon&&DeleteObject(mask));if(bitmap)CHECK(DeleteObject(bitmap));return icon;
}
static void objects(void){
 HICON original=make(1);color=CopyIcon(original);CHECK(color&&DestroyIcon(original));alpha=make(2);mono=make(3);
 original=CopyIcon(color);CHECK(original);copied=(HICON)CopyImage(original,IMAGE_ICON,4,4,LR_COPYDELETEORG);CHECK(copied);
 ICONINFO info={0};CHECK(GetIconInfo(alpha,&info)&&info.fIcon&&info.xHotspot==1&&info.yHotspot==1&&info.hbmMask&&info.hbmColor);
 BITMAP bitmap={0};CHECK(GetObjectW(info.hbmMask,sizeof(bitmap),&bitmap)==sizeof(bitmap)&&bitmap.bmWidth==2&&bitmap.bmHeight==2&&bitmap.bmBitsPixel==1&&bitmap.bmBits==NULL);
 CHECK(GetObjectW(info.hbmColor,sizeof(bitmap),&bitmap)==sizeof(bitmap)&&bitmap.bmBitsPixel==32);
 roundtrip=CreateIconIndirect(&info);CHECK(roundtrip&&DeleteObject(info.hbmMask)&&DeleteObject(info.hbmColor));
}
static void paint(HWND window){
 PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);RECT all={0,0,480,280},area={0,100,480,280};HBRUSH back=CreateSolidBrush(RGB(120,150,180));CHECK(back&&FillRect(dc,&all,(HBRUSH)GetStockObject(WHITE_BRUSH))&&FillRect(dc,&area,back)&&DeleteObject(back));
 int save=SaveDC(dc);CHECK(save);HICON icon=mode==2?alpha:mode==3?mono:mode==4?copied:mode==5?roundtrip:color;
 if(mode==6){HRGN clip=CreateRectRgn(80,140,400,220),hole=CreateRectRgn(100,160,120,180);CHECK(clip&&hole&&CombineRgn(clip,clip,hole,RGN_DIFF)==COMPLEXREGION&&SelectClipRgn(dc,clip)==COMPLEXREGION&&DeleteObject(clip)&&DeleteObject(hole));}
 for(unsigned i=0;i<3;i++)CHECK(DrawIconEx(dc,16+(int)i*160,120,icon,128,128,0,NULL,i==0?DI_NORMAL:i==1?DI_MASK:DI_IMAGE));
 CHECK(RestoreDC(dc,save));CHECK(GetPixel(dc,0,100)==RGB(120,150,180));
 if(mode==1||mode==4)CHECK(GetPixel(dc,16,120)==(RGB(120,150,180)^RGB(16,32,48)));
 if(mode==3)CHECK(GetPixel(dc,16,120)==(RGB(120,150,180)^RGB(255,255,255)));
 CHECK(EndPaint(window,&ps));painted++;
 const WCHAR *titles[]={L"",L"Native icons - color",L"Native icons - alpha",L"Native icons - mono",L"Native icons - copied",L"Native icons - roundtrip",L"Native icons - clipped"};CHECK(SetWindowTextW(window,titles[mode]));
}
static LRESULT CALLBACK procedure(HWND window,UINT msg,WPARAM wp,LPARAM lp){
 if(window==root&&msg==WM_PAINT){paint(window);return 0;}
 if(window==root&&msg==WM_COMMAND&&HIWORD(wp)==BN_CLICKED&&LOWORD(wp)>=101&&LOWORD(wp)<=106){mode=LOWORD(wp)-100;CHECK(InvalidateRect(root,NULL,TRUE));return 0;}
 if(window==root&&(msg==WM_CLOSE||(msg==WM_KEYDOWN&&wp==VK_ESCAPE))){PostQuitMessage(0);return 0;}
 return DefWindowProcW(window,msg,wp,lp);
}
void start(void){
 CHECK(!lstrcmpW(L"native",L"native"));objects();HINSTANCE module=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=module;cls.hIcon=alpha;cls.hbrBackground=(HBRUSH)GetStockObject(WHITE_BRUSH);cls.lpszClassName=L"NativeBitmapIcons";CHECK(RegisterClassW(&cls));
 root=CreateWindowW(cls.lpszClassName,L"Native icons",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,482,310,NULL,NULL,module,NULL);CHECK(root);
 const WCHAR *labels[]={L"Color",L"Alpha",L"Mono",L"Copy",L"Info",L"Clip"};for(unsigned i=0;i<6;i++)CHECK(CreateWindowW(L"BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,8+(int)i*78,16,72,32,root,(HMENU)(101+i),module,NULL));
 CHECK(CreateWindowW(L"STATIC",L"Normal          Mask          Image",WS_CHILD|WS_VISIBLE|SS_CENTER,12,62,456,26,root,(HMENU)200,module,NULL));SetFocus(root);
 MSG message;while(GetMessageW(&message,NULL,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}
 CHECK(painted&&DestroyWindow(root));CHECK(DestroyIcon(color)&&DestroyIcon(alpha)&&DestroyIcon(mono)&&DestroyIcon(copied)&&DestroyIcon(roundtrip));
 const CHAR pass[]="NATIVE BITMAP ICON GUI PASS\n";DWORD written=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),pass,sizeof(pass)-1,&written,NULL)&&written==sizeof(pass)-1);ExitProcess((UINT)message.wParam);
}
