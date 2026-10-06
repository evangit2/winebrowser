/* Authored MIT PE32 DLL: ordinary guest stores plus a real CRT import. */
#include <windows.h>
void *__cdecl memset(void *, int, unsigned);
static const DWORD colors[8]={0x00ff0000,0x0000ff00,0x000000ff,0x00ffffff,0x00ffff00,0x0000ffff,0x00ff00ff,0};
__declspec(dllexport) void WINAPI FillSharedBitmap(void *bits,unsigned width,unsigned height,unsigned stride,unsigned depth,BOOL topDown,unsigned phase) {
    memset(bits,0,stride*height);
    for(unsigned y=0;y<height;y++) {
        BYTE *row=(BYTE*)bits+(topDown?y:height-1-y)*stride;
        for(unsigned x=0;x<width;x++) {
            unsigned index=((phase?width-1-x:x)+y)%8;
            DWORD c=colors[index]; unsigned red=(c>>16)&255,green=(c>>8)&255,blue=c&255;
            if(depth==1) row[x/8]|=(BYTE)(((x+y+phase)&1)<<(7-x%8));
            else if(depth==4) row[x/2]|=(BYTE)(index<<((x&1)?0:4));
            else if(depth==8) row[x]=(BYTE)index;
            else if(depth==16) ((WORD*)row)[x]=(WORD)(((red>>3)<<10)|((green>>3)<<5)|(blue>>3));
            else { row[x*(depth/8)]=(BYTE)blue; row[x*(depth/8)+1]=(BYTE)green; row[x*(depth/8)+2]=(BYTE)red; if(depth==32) row[x*4+3]=0xa5; }
        }
    }
}
BOOL WINAPI DllMain(HINSTANCE instance,DWORD reason,LPVOID reserved) { (void)instance; (void)reason; (void)reserved; return TRUE; }
