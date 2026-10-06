/* Authored MIT native SDK acceptance for bitmap transfers and GUI repaint. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(1000 + __LINE__); } while (0)
static HWND root;
static HDC screen, memory;
static HBITMAP bitmap, original;
static unsigned stage;
static const COLORREF colors[8] = {RGB(255,0,0),RGB(0,255,0),RGB(0,0,255),RGB(255,255,255),RGB(255,255,0),RGB(0,255,255),RGB(255,0,255),RGB(0,0,0)};
static struct { BITMAPINFOHEADER header; RGBQUAD table[256]; } info;
static BYTE bits[1024], output[1024];
static void clear(void *pointer, unsigned size) { BYTE *p = pointer; for (unsigned i=0; i<size; i++) p[i]=0; }
static void header(unsigned depth, LONG height) {
    clear(&info, sizeof(info)); info.header.biSize=sizeof(BITMAPINFOHEADER);
    info.header.biWidth=8; info.header.biHeight=height; info.header.biPlanes=1; info.header.biBitCount=(WORD)depth;
}
static void fill(unsigned depth) {
    unsigned stride=(8*depth+31)/32*4; clear(bits,sizeof(bits));
    for (unsigned y=0;y<6;y++) for (unsigned x=0;x<8;x++) {
        COLORREF c=colors[x]; BYTE *p=bits+y*stride;
        if (depth==1) p[0] |= (BYTE)((x&1) << (7-x));
        else if (depth==4) p[x/2] |= (BYTE)(x << ((x&1)?0:4));
        else if (depth==8) p[x]=(BYTE)x;
        else if (depth==16) ((WORD*)p)[x]=(WORD)(((GetRValue(c)>>3)<<10)|((GetGValue(c)>>3)<<5)|(GetBValue(c)>>3));
        else { p[x*(depth/8)]=GetBValue(c); p[x*(depth/8)+1]=GetGValue(c); p[x*(depth/8)+2]=GetRValue(c); }
    }
    if (depth<=8) for (unsigned i=0;i<(1u<<depth);i++) {
        COLORREF c=depth==1 ? (i?RGB(255,255,255):0) : colors[i&7];
        info.table[i]=(RGBQUAD){GetBValue(c),GetGValue(c),GetRValue(c),0};
    }
}
static void inspect(unsigned depth) {
    CHECK(SelectObject(memory,bitmap)==original);
    for (unsigned y=0;y<6;y++) for (unsigned x=0;x<8;x++)
        CHECK(GetPixel(memory,x,y)==(depth==1 ? (x&1?RGB(255,255,255):0) : colors[x]));
    CHECK(SelectObject(memory,original)==bitmap);
}
static void acceptance(void) {
    const unsigned depths[]={1,4,8,16,24,32};
    for (unsigned i=0;i<6;i++) for (unsigned top=0;top<2;top++) {
        unsigned depth=depths[i]; header(depth,top?-6:6); fill(depth);
        CHECK(SetDIBits(screen,bitmap,0,6,bits,(BITMAPINFO*)&info,DIB_RGB_COLORS)==6); inspect(depth);
        header(32,top?-6:6); for(unsigned n=0;n<sizeof(output);n++) output[n]=0xcc;
        CHECK(GetDIBits(screen,bitmap,0,6,output,(BITMAPINFO*)&info,DIB_RGB_COLORS)==6);
        CHECK(info.header.biSizeImage==192 && output[192]==0xcc);
        for(unsigned y=0;y<6;y++) for(unsigned x=0;x<8;x++) {
            COLORREF c=depth==1 ? (x&1?RGB(255,255,255):0) : colors[x]; BYTE *p=output+(y*8+x)*4;
            CHECK(p[0]==GetBValue(c)&&p[1]==GetGValue(c)&&p[2]==GetRValue(c)&&p[3]==0);
        }
    }
    header(0,0); CHECK(GetDIBits(screen,bitmap,0,0,NULL,(BITMAPINFO*)&info,DIB_RGB_COLORS)==1);
    CHECK(info.header.biWidth==8&&info.header.biHeight==6&&info.header.biPlanes==1&&info.header.biBitCount==32&&info.header.biSizeImage==192);
    header(16,6); info.header.biCompression=BI_BITFIELDS;
    ((DWORD*)info.table)[0]=0xf800; ((DWORD*)info.table)[1]=0x7e0; ((DWORD*)info.table)[2]=0x1f;
    for(unsigned y=0;y<6;y++) for(unsigned x=0;x<8;x++) {
        COLORREF c=colors[x]; ((WORD*)bits)[y*8+x]=(WORD)(((GetRValue(c)>>3)<<11)|((GetGValue(c)>>2)<<5)|(GetBValue(c)>>3));
    }
    CHECK(SetDIBits(screen,bitmap,0,6,bits,(BITMAPINFO*)&info,DIB_RGB_COLORS)==6); inspect(16);
    ((DWORD*)info.table)[1]=0xf800;
    CHECK(SetDIBits(screen,bitmap,0,6,bits,(BITMAPINFO*)&info,DIB_RGB_COLORS)==0); inspect(16);
    CHECK(!SetDIBits((HDC)0xdead,bitmap,0,1,bits,(BITMAPINFO*)&info,0));
    CHECK(!GetDIBits(screen,(HBITMAP)0xdead,0,1,output,(BITMAPINFO*)&info,0));
    CHECK(!GetDIBits(screen,bitmap,0,1,output,(BITMAPINFO*)&info,2));
    struct { WORD version,count; PALETTEENTRY entries[8]; } logical={0x300,8,{{0,0,0,0}}};
    for(unsigned x=0;x<8;x++) logical.entries[x]=(PALETTEENTRY){GetRValue(colors[x]),GetGValue(colors[x]),GetBValue(colors[x]),0};
    HPALETTE palette=CreatePalette((LOGPALETTE*)&logical),stock=(HPALETTE)GetStockObject(DEFAULT_PALETTE);
    CHECK(palette&&stock&&SelectPalette(screen,palette,FALSE)==stock);
    header(4,6); info.header.biClrUsed=8;
    for(unsigned x=0;x<8;x++) ((WORD*)info.table)[x]=(WORD)x;
    clear(bits,sizeof(bits));
    for(unsigned y=0;y<6;y++) for(unsigned x=0;x<8;x++) bits[y*4+x/2]|=(BYTE)(x<<((x&1)?0:4));
    CHECK(SetDIBits(screen,bitmap,0,6,bits,(BITMAPINFO*)&info,DIB_PAL_COLORS)==6); inspect(4);
    CHECK(GetDIBits(screen,bitmap,0,6,output,(BITMAPINFO*)&info,DIB_PAL_COLORS)==6);
    for(unsigned x=0;x<16;x++) CHECK(((WORD*)info.table)[x]==x);
    for(unsigned n=0;n<24;n++) CHECK(output[n]==bits[n]);
    CHECK(SelectPalette(screen,stock,FALSE)==palette&&DeleteObject(palette));
    CHECK(GetPaletteEntries(stock,0,0,NULL)==20);
}
static void update(void) {
    CHECK(SelectObject(memory,original)==bitmap);
    header(32,-6); clear(bits,sizeof(bits));
    for(unsigned y=0;y<2;y++) for(unsigned x=0;x<8;x++) {
        COLORREF c=colors[stage?x:7-x]; BYTE *p=bits+(y*8+x)*4;
        p[0]=GetBValue(c); p[1]=GetGValue(c); p[2]=GetRValue(c);
    }
    CHECK(SetDIBits(screen,bitmap,1,2,bits,(BITMAPINFO*)&info,0)==2);
    CHECK(SelectObject(memory,bitmap)==original);
    stage^=1;
    for(unsigned y=0;y<6;y++) for(unsigned x=0;x<8;x++) CHECK(GetPixel(memory,x,y)==colors[(stage&&(y==3||y==4))?7-x:x]);
    SetWindowTextW(root,stage?L"DIB transfers updated":L"DIB transfers ready — F6 updates rows"); CHECK(InvalidateRect(root,NULL,FALSE));
}
static LRESULT CALLBACK procedure(HWND window,UINT message,WPARAM wp,LPARAM lp) {
    if(message==WM_PAINT && bitmap) {
        PAINTSTRUCT paint; HDC dc=BeginPaint(window,&paint); CHECK(dc);
        RECT area; CHECK(GetClientRect(window,&area)); HBRUSH brush=CreateSolidBrush(RGB(24,32,48));
        CHECK(brush && FillRect(dc,&area,brush) && DeleteObject(brush));
        CHECK(StretchBlt(dc,16,16,256,192,memory,0,0,8,6,SRCCOPY)); CHECK(EndPaint(window,&paint)); return 0;
    }
    if(message==WM_KEYDOWN && wp==VK_F6) { update(); return 0; }
    if(message==WM_CLOSE) {
        CHECK(SelectObject(memory,original)==bitmap && DeleteObject(bitmap) && DeleteDC(memory) && ReleaseDC(NULL,screen)); bitmap=NULL;
    }
    if(message==WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(window,message,wp,lp);
}
void start(void) {
    screen=GetDC(NULL); memory=CreateCompatibleDC(screen); CHECK(screen&&memory);
    bitmap=CreateCompatibleBitmap(screen,8,6); CHECK(bitmap); original=GetCurrentObject(memory,OBJ_BITMAP); CHECK(original);
    acceptance(); CHECK(SelectObject(memory,bitmap)==original);
    HINSTANCE instance=GetModuleHandleW(NULL); WNDCLASSW cls={0}; cls.hInstance=instance; cls.lpfnWndProc=procedure; cls.lpszClassName=L"DibTransfers"; CHECK(RegisterClassW(&cls));
    root=CreateWindowW(cls.lpszClassName,L"DIB transfers ready — F6 updates rows",WS_OVERLAPPEDWINDOW|WS_VISIBLE,30,40,304,256,NULL,NULL,instance,NULL); CHECK(root);
    CHECK(InvalidateRect(root,NULL,FALSE)); MSG message;
    while(GetMessageW(&message,NULL,0,0)>0) { TranslateMessage(&message); DispatchMessageW(&message); }
    ExitProcess((UINT)message.wParam);
}
