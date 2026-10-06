/* Authored MIT SDK acceptance: shared DIB pointer writes across a native DLL. */
#include <windows.h>
#define CHECK(x) do { if(!(x)) ExitProcess(1000+__LINE__); } while(0)
void *__cdecl memset(void *,int,unsigned);
typedef void (WINAPI *Producer)(void *,unsigned,unsigned,unsigned,unsigned,BOOL,unsigned);
static const COLORREF colors[8]={RGB(255,0,0),RGB(0,255,0),RGB(0,0,255),RGB(255,255,255),RGB(255,255,0),RGB(0,255,255),RGB(255,0,255),0};
static HMODULE plugin; static Producer produce; static HWND root;
static HDC screen,source,target; static HBITMAP sourceBitmap,targetBitmap,sourceOld,targetOld;
static BYTE *sourceBits,*targetBits; static unsigned stage;
static struct { BITMAPINFOHEADER header; RGBQUAD table[256]; } info;
static void clear(void *p,unsigned size) { BYTE *b=p; for(unsigned i=0;i<size;i++) b[i]=0; }
static void header(unsigned depth,LONG height,unsigned width) {
    clear(&info,sizeof(info)); info.header.biSize=40; info.header.biWidth=(LONG)width; info.header.biHeight=height;
    info.header.biPlanes=1; info.header.biBitCount=(WORD)depth;
    if(depth<=8) for(unsigned i=0;i<1u<<depth;i++) {
        COLORREF c=depth==1?(i?RGB(255,255,255):0):colors[i%8];
        info.table[i]=(RGBQUAD){GetBValue(c),GetGValue(c),GetRValue(c),0};
    }
}
static void acceptance(void) {
    const unsigned depths[]={1,4,8,16,24,32}; HDC dc=CreateCompatibleDC(screen); CHECK(dc);
    for(unsigned i=0;i<6;i++) for(unsigned top=0;top<2;top++) {
        unsigned depth=depths[i],stride=(3*depth+31)/32*4; BYTE *bits=NULL;
        header(depth,top?-2:2,3); HBITMAP bitmap=CreateDIBSection(NULL,(BITMAPINFO*)&info,DIB_RGB_COLORS,(void**)&bits,NULL,0);
        CHECK(bitmap&&bits); MEMORY_BASIC_INFORMATION memory;
        CHECK(VirtualQuery(bits,&memory,sizeof(memory))==sizeof(memory));
        CHECK(memory.BaseAddress==bits&&memory.AllocationBase==bits&&memory.State==MEM_COMMIT&&memory.Protect==PAGE_READWRITE&&memory.Type==MEM_PRIVATE);
        DIBSECTION descriptor; CHECK(GetObjectW(bitmap,sizeof(descriptor),&descriptor)==sizeof(descriptor));
        CHECK(descriptor.dsBm.bmBits==bits&&descriptor.dsBm.bmWidth==3&&descriptor.dsBm.bmHeight==2&&descriptor.dsBm.bmWidthBytes==(LONG)stride&&descriptor.dsBm.bmBitsPixel==depth);
        CHECK(descriptor.dsBmih.biHeight==2&&descriptor.dsBmih.biBitCount==depth&&!descriptor.dshSection&&!descriptor.dsOffset);
        produce(bits,3,2,stride,depth,top,0);
        HBITMAP old=SelectObject(dc,bitmap); CHECK(old);
        for(unsigned y=0;y<2;y++) for(unsigned x=0;x<3;x++) CHECK(GetPixel(dc,x,y)==(depth==1?((x+y)&1?RGB(255,255,255):0):colors[(x+y)%8]));
        unsigned row=top?0:1;
        CHECK(SetPixel(dc,0,0,RGB(255,255,255))==RGB(255,255,255)&&GdiFlush());
        BYTE *p=bits+row*stride;
        if(depth==1) CHECK((p[0]&0x80)!=0);
        else if(depth==4) CHECK((p[0]>>4)==3);
        else if(depth==8) CHECK(p[0]==3);
        else if(depth==16) CHECK(((WORD*)p)[0]==0x7fff);
        else CHECK(p[0]==255&&p[1]==255&&p[2]==255);
        if(depth==32) CHECK(p[7]==0xa5&&p[11]==0xa5); // untouched reserved bytes
        HBITMAP compatible=CreateCompatibleBitmap(dc,5,2); CHECK(compatible);
        CHECK(GetObjectA(compatible,sizeof(descriptor),&descriptor)==sizeof(descriptor));
        CHECK(descriptor.dsBm.bmBits&&descriptor.dsBm.bmBitsPixel==depth&&descriptor.dsBm.bmWidth==5);
        CHECK(DeleteObject(compatible));
        if(depth<=8) {
            RGBQUAD color={17,34,51,0x77},read;
            CHECK(SetDIBColorTable(dc,0,1,&color)==1&&GetDIBColorTable(dc,0,1,&read)==1);
            CHECK(read.rgbBlue==17&&read.rgbGreen==34&&read.rgbRed==51&&!read.rgbReserved);
        }
        CHECK(SelectObject(dc,old)==bitmap&&DeleteObject(bitmap));
        CHECK(VirtualQuery(bits,&memory,sizeof(memory))==sizeof(memory)&&memory.State==MEM_FREE);
    }
    CHECK(DeleteDC(dc));
}
static COLORREF expected(unsigned x,unsigned y) {
    if(stage==2||stage==3) { if(y==2) return RGB(255,255,255); if(stage==3&&y==4) return 0; }
    return colors[((stage>=1&&stage<=3?7-x:x)+y)%8];
}
static void inspect(void) {
    for(unsigned y=0;y<6;y++) for(unsigned x=0;x<8;x++) {
        COLORREF color=expected(x,y); CHECK(GetPixel(source,x,y)==color);
        BYTE *p=sourceBits+(y*8+x)*4; CHECK(p[0]==GetBValue(color)&&p[1]==GetGValue(color)&&p[2]==GetRValue(color));
    }
    CHECK(BitBlt(target,0,0,8,6,source,0,0,SRCCOPY)&&GdiFlush());
    for(unsigned y=0;y<6;y++) for(unsigned x=0;x<8;x++) {
        COLORREF color=expected(x,y); CHECK(GetPixel(target,x,y)==color);
        BYTE *p=targetBits+((5-y)*8+x)*4; CHECK(p[0]==GetBValue(color)&&p[1]==GetGValue(color)&&p[2]==GetRValue(color));
    }
}
static void advance(void) {
    stage=(stage+1)%5;
    if(stage==0||stage==1||stage==4) produce(sourceBits,8,6,32,32,TRUE,stage==1);
    if(stage==2) { RECT row={0,2,8,3}; HBRUSH brush=CreateSolidBrush(RGB(255,255,255)); CHECK(brush&&FillRect(source,&row,brush)&&DeleteObject(brush)); }
    if(stage==3) memset(sourceBits+4*32,0,32);
    inspect(); const WCHAR *titles[]={L"Shared DIB ready — F6 changes pixels",L"Shared DIB updated by native DLL",L"Shared DIB painted by GDI",L"Shared DIB cleared by CRT",L"Shared DIB restored"};
    SetWindowTextW(root,titles[stage]); CHECK(InvalidateRect(root,NULL,FALSE));
}
static LRESULT CALLBACK procedure(HWND window,UINT message,WPARAM wp,LPARAM lp) {
    if(message==WM_PAINT&&targetBitmap) {
        PAINTSTRUCT paint; HDC dc=BeginPaint(window,&paint); CHECK(dc); RECT area; CHECK(GetClientRect(window,&area));
        HBRUSH brush=CreateSolidBrush(RGB(24,32,48)); CHECK(brush&&FillRect(dc,&area,brush)&&DeleteObject(brush));
        CHECK(StretchBlt(dc,16,16,256,192,target,0,0,8,6,SRCCOPY)&&EndPaint(window,&paint)); return 0;
    }
    if(message==WM_KEYDOWN&&wp==VK_F6) { advance(); return 0; }
    if(message==WM_CLOSE) {
        CHECK(SelectObject(source,sourceOld)==sourceBitmap&&SelectObject(target,targetOld)==targetBitmap);
        CHECK(DeleteObject(sourceBitmap)&&DeleteObject(targetBitmap)&&DeleteDC(source)&&DeleteDC(target)&&ReleaseDC(NULL,screen));
        targetBitmap=NULL; CHECK(FreeLibrary(plugin));
    }
    if(message==WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(window,message,wp,lp);
}
void start(void) {
    plugin=LoadLibraryA("bitmap-producer.dll"); CHECK(plugin); produce=(Producer)(void*)GetProcAddress(plugin,"FillSharedBitmap"); CHECK(produce);
    screen=GetDC(NULL); CHECK(screen); acceptance();
    source=CreateCompatibleDC(screen); target=CreateCompatibleDC(screen); CHECK(source&&target);
    header(32,-6,8); sourceBitmap=CreateDIBSection(NULL,(BITMAPINFO*)&info,0,(void**)&sourceBits,NULL,0);
    header(32,6,8); targetBitmap=CreateDIBSection(NULL,(BITMAPINFO*)&info,0,(void**)&targetBits,NULL,0); CHECK(sourceBitmap&&targetBitmap);
    sourceOld=SelectObject(source,sourceBitmap); targetOld=SelectObject(target,targetBitmap); CHECK(sourceOld&&targetOld);
    produce(sourceBits,8,6,32,32,TRUE,0); inspect();
    HINSTANCE instance=GetModuleHandleW(NULL); WNDCLASSW cls={0}; cls.hInstance=instance; cls.lpfnWndProc=procedure; cls.lpszClassName=L"SharedDib"; CHECK(RegisterClassW(&cls));
    root=CreateWindowW(cls.lpszClassName,L"Shared DIB ready — F6 changes pixels",WS_OVERLAPPEDWINDOW|WS_VISIBLE,30,40,304,256,NULL,NULL,instance,NULL); CHECK(root);
    CHECK(InvalidateRect(root,NULL,FALSE)); MSG message;
    while(GetMessageW(&message,NULL,0,0)>0) { TranslateMessage(&message); DispatchMessageW(&message); }
    ExitProcess((UINT)message.wParam);
}
