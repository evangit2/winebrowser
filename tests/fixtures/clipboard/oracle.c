/* MIT. Native desktop Wine clipboard behavior, isolated by EmptyClipboard. */
#include <windows.h>
#include <stdio.h>
static HWND owner;
static int rendered,destroyed;
static HGLOBAL text(const char *s) {
  SIZE_T n=lstrlenA(s)+1; HGLOBAL h=GlobalAlloc(GMEM_MOVEABLE,n);
  memcpy(GlobalLock(h),s,n); GlobalUnlock(h); return h;
}
static LRESULT CALLBACK proc(HWND h,UINT m,WPARAM w,LPARAM l) {
  if(m==WM_RENDERFORMAT) { rendered++; SetClipboardData((UINT)w,text("delayed")); return 0; }
  if(m==WM_DESTROYCLIPBOARD) { destroyed++; return 0; }
  return DefWindowProcA(h,m,w,l);
}
#define RESULT(label, expr) do { SetLastError(0x1234); ULONG_PTR v=(ULONG_PTR)(expr); printf("%s %lu %lu\n",label,(unsigned long)v,(unsigned long)GetLastError()); } while(0)
int main(void) {
  WNDCLASSA c={0};c.lpfnWndProc=proc;c.lpszClassName="ClipboardOracle";RegisterClassA(&c);
  owner=CreateWindowA(c.lpszClassName,"",0,0,0,100,100,NULL,NULL,NULL,NULL);
  RESULT("open-owner",OpenClipboard(owner));
  RESULT("open-again",OpenClipboard(owner));
  RESULT("empty",EmptyClipboard());
  RESULT("owner",GetClipboardOwner()==owner);
  RESULT("set-text",SetClipboardData(CF_TEXT,text("caf\xe9\r\n"))!=NULL);
  RESULT("count-before-close",CountClipboardFormats());
  RESULT("close",CloseClipboard());
  RESULT("text-available",IsClipboardFormatAvailable(CF_TEXT));
  RESULT("unicode-available",IsClipboardFormatAvailable(CF_UNICODETEXT));
  RESULT("count",CountClipboardFormats());
  RESULT("get-closed",GetClipboardData(CF_TEXT));
  RESULT("empty-closed",EmptyClipboard());
  RESULT("close-closed",CloseClipboard());
  RESULT("open-null",OpenClipboard(NULL));
  RESULT("open-window",GetOpenClipboardWindow());
  RESULT("retained",GetClipboardOwner()==owner);
  UINT f=0; while((f=EnumClipboardFormats(f))) printf("format %u\n",f);
  for(int i=0;i<3;i++) { UINT fmt=i==0?CF_TEXT:i==1?CF_UNICODETEXT:CF_OEMTEXT;
    HGLOBAL h=GetClipboardData(fmt); unsigned char *p=GlobalLock(h); printf("bytes-%u",fmt);
    if(p) { for(unsigned j=0;j<(fmt==CF_UNICODETEXT?12u:6u);j++) printf(" %02x",p[j]); GlobalUnlock(h); }
    puts(""); }
  RESULT("empty-null",EmptyClipboard());
  RESULT("owner-null",GetClipboardOwner());
  RESULT("set-null-owner",SetClipboardData(CF_TEXT,text("null owner"))!=NULL);
  RESULT("close-null",CloseClipboard());
  RESULT("enum-closed",EnumClipboardFormats(0));
  RESULT("open-delayed",OpenClipboard(owner));
  RESULT("empty-delayed",EmptyClipboard());
  RESULT("set-delayed",SetClipboardData(CF_TEXT,NULL));
  RESULT("close-delayed",CloseClipboard());
  RESULT("open-reader",OpenClipboard(NULL));
  RESULT("get-delayed",GetClipboardData(CF_TEXT)!=NULL);
  printf("rendered %d\n",rendered);
  RESULT("empty-reader",EmptyClipboard());
  printf("destroyed %d\n",destroyed);
  CloseClipboard();
  for(int kind=0;kind<2;kind++) {
    OpenClipboard(owner);EmptyClipboard();
    HGLOBAL h;
    if(kind==0) { const WCHAR s[]={0x63,0x61,0x66,0xe9,0xd,0xa,0};h=GlobalAlloc(GMEM_MOVEABLE,sizeof(s));memcpy(GlobalLock(h),s,sizeof(s));GlobalUnlock(h); }
    else h=text("caf\x82\r\n");
    UINT original=kind==0?CF_UNICODETEXT:CF_OEMTEXT;SetClipboardData(original,h);CloseClipboard();OpenClipboard(NULL);
    printf("source %u\n",original);f=0;while((f=EnumClipboardFormats(f)))printf("format %u\n",f);
    CloseClipboard();
  }
  OpenClipboard(owner);EmptyClipboard();CloseClipboard();DestroyWindow(owner);return 0;
}
