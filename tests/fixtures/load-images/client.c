/* Authored MIT Windows SDK acceptance for ordinary LoadImage A/W clients. */
#include <windows.h>
#define CHECK(x) do { if(!(x)) ExitProcess(1000+__LINE__); } while(0)
static HBITMAP shown[3]; static HDC screen; static HWND root; static unsigned stage;
static const COLORREF colors[4]={0,RGB(128,128,128),RGB(192,192,192),RGB(255,255,255)};
static HBITMAP load(HINSTANCE module, const WCHAR *name, unsigned width,unsigned height,unsigned flags) {
    HBITMAP bitmap=(HBITMAP)LoadImageW(module,name,IMAGE_BITMAP,(int)width,(int)height,flags); CHECK(bitmap);return bitmap;
}
static void pixels(HBITMAP bitmap,unsigned width,unsigned height,BOOL mapped) {
    HDC dc=CreateCompatibleDC(screen);CHECK(dc);HBITMAP old=SelectObject(dc,bitmap);CHECK(old);
    for(unsigned y=0;y<height;y++)for(unsigned x=0;x<width;x++) {
        unsigned sx=x*8/width,sy=y*2/height,index=sy?3-sx%4:sx%4;
        COLORREF expected=colors[index];
        if(mapped) expected=index==1?GetSysColor(COLOR_3DSHADOW):GetSysColor(COLOR_3DFACE);
        if(mapped&&index==0)expected=0;
        CHECK(GetPixel(dc,x,y)==expected);
    }
    CHECK(SelectObject(dc,old)==bitmap&&DeleteDC(dc));
}
static void verify(void) {
    HINSTANCE module=GetModuleHandleW(NULL); DIBSECTION desc;
    HBITMAP bitmap=(HBITMAP)LoadImageA(module,MAKEINTRESOURCEA(101),IMAGE_BITMAP,0,0,0);CHECK(bitmap);pixels(bitmap,8,2,FALSE);
    CHECK(GetObjectW(bitmap,sizeof(desc),&desc)==sizeof(BITMAP)&&!desc.dsBm.bmBits&&desc.dsBm.bmBitsPixel==32&&DeleteObject(bitmap));
    for(unsigned id=101;id<=107;id++) {
        bitmap=load(module,MAKEINTRESOURCEW(id),0,0,LR_CREATEDIBSECTION);
        CHECK(GetObjectW(bitmap,sizeof(desc),&desc)==sizeof(desc)&&desc.dsBm.bmBits);
        CHECK(desc.dsBm.bmBitsPixel==(id==101||id==103?4:id==102?8:id==104?1:id==105?24:id==106?16:32));
        MEMORY_BASIC_INFORMATION memory;CHECK(VirtualQuery(desc.dsBm.bmBits,&memory,sizeof(memory))==sizeof(memory)&&memory.State==MEM_COMMIT&&memory.Protect==PAGE_READWRITE);
        HDC dc=CreateCompatibleDC(screen);CHECK(dc);HBITMAP old=SelectObject(dc,bitmap);CHECK(old);
        CHECK(GetPixel(dc,0,0)==(id<=103?0:id==104?RGB(255,255,255):id==106?RGB(255,0,0):RGB(10,20,30)));
        CHECK(SelectObject(dc,old)==bitmap&&DeleteDC(dc)&&DeleteObject(bitmap));
    }
    const WCHAR *files[]={L"indexed4.bmp",L"indexed8.bmp",L"core4.bmp",L"mono.bmp",L"rgb24.bmp",L"rgb565.bmp",L"rgb32.bmp"};
    for(unsigned i=0;i<7;i++) { bitmap=load(NULL,files[i],0,0,LR_LOADFROMFILE|LR_CREATEDIBSECTION);CHECK(GetObjectW(bitmap,sizeof(desc),&desc)==sizeof(desc)&&desc.dsBm.bmBits);CHECK(DeleteObject(bitmap)); }
    HMODULE library=LoadLibraryA("bitmap-resources.dll");CHECK(library);
    bitmap=load(library,L"NamedBitmap",8,2,LR_CREATEDIBSECTION);CHECK(FreeLibrary(library));pixels(bitmap,8,2,FALSE);CHECK(DeleteObject(bitmap));
    bitmap=load(module,L"NamedBitmap",16,4,LR_CREATEDIBSECTION|LR_SHARED|LR_DEFAULTSIZE);pixels(bitmap,16,4,FALSE);CHECK(DeleteObject(bitmap));
    bitmap=load(module,MAKEINTRESOURCEW(101),8,2,LR_CREATEDIBSECTION|LR_LOADMAP3DCOLORS|LR_LOADTRANSPARENT);pixels(bitmap,8,2,TRUE);CHECK(DeleteObject(bitmap));
    bitmap=load(NULL,L"indexed4.bmp",16,4,LR_LOADFROMFILE|LR_CREATEDIBSECTION|LR_SHARED);pixels(bitmap,16,4,FALSE);CHECK(DeleteObject(bitmap));
    bitmap=load(NULL,L"gap.bmp",8,2,LR_LOADFROMFILE);pixels(bitmap,8,2,FALSE);CHECK(DeleteObject(bitmap));
    bitmap=(HBITMAP)LoadImageA(NULL,"rgb24.bmp",IMAGE_BITMAP,0,0,LR_LOADFROMFILE);CHECK(bitmap&&DeleteObject(bitmap));
    CHECK(!LoadImageW(NULL,L"missing.bmp",IMAGE_BITMAP,0,0,LR_LOADFROMFILE)&&GetLastError()==ERROR_FILE_NOT_FOUND);
    CHECK(!LoadImageW(NULL,L"truncated.bmp",IMAGE_BITMAP,0,0,LR_LOADFROMFILE)&&GetLastError()==ERROR_INVALID_DATA);
    CHECK(!LoadImageW(module,MAKEINTRESOURCEW(101),IMAGE_BITMAP,-1,2,0)&&GetLastError()==ERROR_INVALID_PARAMETER);
    HCURSOR cursor=(HCURSOR)LoadImageW(module,MAKEINTRESOURCEW(201),IMAGE_CURSOR,0,0,LR_SHARED);CHECK(cursor&&SetCursor(cursor));
    HICON icon=(HICON)LoadImageA(module,MAKEINTRESOURCEA(202),IMAGE_ICON,0,0,LR_SHARED);CHECK(icon);
    shown[0]=load(module,L"NamedBitmap",8,2,LR_CREATEDIBSECTION);
    shown[1]=load(module,MAKEINTRESOURCEW(101),8,2,LR_LOADMAP3DCOLORS|LR_LOADTRANSPARENT);
    shown[2]=load(NULL,L"rgb24.bmp",3,2,LR_LOADFROMFILE|LR_CREATEDIBSECTION);
    CHECK(GetObjectW(shown[2],sizeof(desc),&desc)==sizeof(desc));
}
static LRESULT CALLBACK procedure(HWND window,UINT message,WPARAM wp,LPARAM lp) {
    if(message==WM_PAINT) {
        PAINTSTRUCT paint;HDC dc=BeginPaint(window,&paint);CHECK(dc);RECT bounds;CHECK(GetClientRect(window,&bounds));
        HBRUSH brush=CreateSolidBrush(RGB(24,32,48));CHECK(brush&&FillRect(dc,&bounds,brush)&&DeleteObject(brush));
        HDC memory=CreateCompatibleDC(dc);CHECK(memory);
        for(unsigned i=0;i<3;i++) {HBITMAP old=SelectObject(memory,shown[i]);CHECK(old);CHECK(StretchBlt(dc,16,16+i*80,256,64,memory,0,0,i==2?3:8,2,SRCCOPY));CHECK(SelectObject(memory,old)==shown[i]);}
        CHECK(DeleteDC(memory)&&EndPaint(window,&paint));return 0;
    }
    if(message==WM_KEYDOWN&&wp==VK_F6) {
        stage^=1;DIBSECTION desc;CHECK(GetObjectW(shown[2],sizeof(desc),&desc)==sizeof(desc));BYTE *bits=desc.dsBm.bmBits;
        bits[0]=(BYTE)(stage?255:30);bits[1]=(BYTE)(stage?0:20);bits[2]=(BYTE)(stage?255:10);
        SetWindowTextW(root,stage?L"LoadImage bitmap updated through native pointer":L"LoadImage resources and BMP files — F6 changes pixels");CHECK(InvalidateRect(root,NULL,FALSE));return 0;
    }
    if(message==WM_DESTROY) {for(unsigned i=0;i<3;i++)CHECK(DeleteObject(shown[i]));CHECK(ReleaseDC(NULL,screen));PostQuitMessage(0);return 0;}
    return DefWindowProcW(window,message,wp,lp);
}
void start(void) {
    screen=GetDC(NULL);CHECK(screen);verify();HINSTANCE module=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.hInstance=module;cls.lpfnWndProc=procedure;cls.lpszClassName=L"NativeLoadImages";CHECK(RegisterClassW(&cls));
    root=CreateWindowW(cls.lpszClassName,L"LoadImage resources and BMP files — F6 changes pixels",WS_OVERLAPPEDWINDOW|WS_VISIBLE,30,40,304,296,NULL,NULL,module,NULL);CHECK(root);CHECK(InvalidateRect(root,NULL,FALSE));
    MSG msg;while(GetMessageW(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}ExitProcess((UINT)msg.wParam);
}
