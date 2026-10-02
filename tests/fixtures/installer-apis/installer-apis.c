// WineBrowser installer-service regression. SPDX-License-Identifier: MIT
#define COBJMACROS
#include <windows.h>
#include <shlobj.h>
#include <commctrl.h>
#include <lzexpand.h>
static int initialized, commands, font_count, browse_init;
static WORD dialog_template[160];
static int at;
static void word(WORD v) { dialog_template[at++]=v; }
static void dword(DWORD v) {word((WORD)v);word((WORD)(v>>16));}
static void text(const char *s) {while(*s)word((WORD)*s++);word(0);}
static INT_PTR CALLBACK dialog_proc(HWND hwnd,UINT msg,WPARAM wp,LPARAM lp) {
  (void)hwnd;(void)wp;
  if(msg==WM_INITDIALOG){initialized+=(lp==123);if(lp==555)PostMessageA(hwnd,WM_COMMAND,99,0);return TRUE;}
  if(msg==WM_COMMAND){commands++;if(wp==99)EndDialog(hwnd,42);return TRUE;}
  return FALSE;
}
static int CALLBACK font_proc(const LOGFONTA *lf,const TEXTMETRICA *tm,DWORD type,LPARAM param) {
  if(lf->lfFaceName[0] && tm->tmHeight>0 && type==DEVICE_FONTTYPE && param==456)font_count++;
  return font_count<2;
}
static int CALLBACK browse_proc(HWND hwnd,UINT msg,LPARAM lp,LPARAM param) {
  (void)lp;
  if(msg==BFFM_INITIALIZED && param==789){browse_init++;SendMessageA(hwnd,BFFM_SETSELECTIONA,TRUE,(LPARAM)"C:\\winebrowser\\assets");}
  return 0;
}
static void report(const char *s) {DWORD n=0;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),s,(DWORD)lstrlenA(s),&n,0);}
#define CHECK(x,n) do{if(!(x)){report("INSTALLER API FAIL\n");ExitProcess(n);}}while(0)
void _start(void) {
  HMODULE common=LoadLibraryA("comctl32.dll");
  CHECK(common,1);
  FARPROC init=GetProcAddress(common,(LPCSTR)17);CHECK(init,2);((void (WINAPI *)(void))init)();
  const char *s="test";CHECK(CharNextA(s)==s+1&&CharNextA(s+4)==s+4,3);
  // In-memory extended template with real button class ordinals.
  word(1);word(0xffff);dword(0);dword(0);dword(WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE);
  word(2);word(0);word(0);word(180);word(100);word(0);word(0);text("Installer API regression");
  for(int i=0;i<2;i++){if(at&1)word(0);dword(0);dword(0);dword(WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_PUSHBUTTON);word((WORD)(10+i*50));word(10);word(40);word(15);dword((DWORD)(10+i));word(0xffff);word(0x80);text(i?"Cancel":"Next");word(0);}
  HINSTANCE instance=GetModuleHandleA(0);
  HWND dialog=CreateDialogIndirectParamA(instance,(LPCDLGTEMPLATE)dialog_template,0,dialog_proc,123);
  CHECK(dialog&&initialized==1,4);
  HWND first=GetDlgItem(dialog,10),second=GetDlgItem(dialog,11);CHECK(first&&second,5);
  CHECK(GetWindow(dialog,GW_CHILD)==first&&GetWindow(first,GW_HWNDNEXT)==second,6);
  CHECK(GetNextDlgTabItem(dialog,second,FALSE)==first,7);
  SendMessageA(dialog,WM_COMMAND,10,(LPARAM)first);CHECK(commands==1,8);
  HWND owned=CreateDialogIndirectParamA(instance,(LPCDLGTEMPLATE)dialog_template,dialog,dialog_proc,123);CHECK(owned&&GetWindow(owned,GW_OWNER)==dialog,9);
  CHECK(SetParent(first,owned)==dialog&&GetParent(first)==owned,10);
  DestroyWindow(owned);
  CHECK(DialogBoxIndirectParamA(instance,(LPCDLGTEMPLATE)dialog_template,dialog,dialog_proc,555)==42&&IsWindowEnabled(dialog),22);
  DestroyWindow(dialog);
  HDC dc=CreateCompatibleDC(0);CHECK(dc,11);
  struct {BITMAPINFOHEADER header;RGBQUAD colors[2];} info={0};
  info.header.biSize=40;info.header.biWidth=2;info.header.biHeight=2;info.header.biPlanes=1;info.header.biBitCount=8;info.header.biClrUsed=2;
  info.colors[0].rgbRed=255;info.colors[1].rgbGreen=255;
  const BYTE bits[8]={1,0,0,0,0,1,0,0};
  HBITMAP bitmap=CreateDIBitmap(dc,&info.header,CBM_INIT,bits,(BITMAPINFO*)&info,DIB_RGB_COLORS);CHECK(bitmap,12);
  HGDIOBJ old=SelectObject(dc,bitmap);CHECK(GetPixel(dc,0,0)==RGB(255,0,0)&&GetPixel(dc,0,1)==RGB(0,255,0),13);
  SelectObject(dc,old);DeleteObject(bitmap);
  LOGFONTA font={0};font.lfCharSet=DEFAULT_CHARSET;
  EnumFontFamiliesExA(dc,&font,font_proc,456,0);CHECK(font_count==2,14);DeleteDC(dc);
  OFSTRUCT ofs={0};char input[]="payload.dat",output[]="expanded.dat",compressed[]="payload.da_",expanded_name[MAX_PATH];
  HFILE src=LZOpenFileA(input,&ofs,OF_READ),dest=LZOpenFileA(output,&ofs,OF_CREATE|OF_WRITE);CHECK(src>=0&&dest>=0,15);
  CHECK(LZCopy(src,dest)==9,16);LZClose(src);LZClose(dest);
  CHECK(GetExpandedNameA(compressed,expanded_name)==1&&lstrcmpA(expanded_name,"payload.dat")==0,17);
  IMalloc *allocator=0;CHECK(SHGetMalloc(&allocator)==S_OK&&allocator,18);
  void *allocation=IMalloc_Alloc(allocator,64);CHECK(allocation&&IMalloc_DidAlloc(allocator,allocation)==1,19);IMalloc_Free(allocator,allocation);
  BROWSEINFOA browse={0};char display[MAX_PATH],path[MAX_PATH];browse.pszDisplayName=display;browse.lpszTitle="Choose installation folder";browse.ulFlags=BIF_RETURNONLYFSDIRS;browse.lpfn=browse_proc;browse.lParam=789;
  LPITEMIDLIST item=SHBrowseForFolderA(&browse);CHECK(item&&browse_init==1,20);
  CHECK(SHGetPathFromIDListA(item,path)&&lstrcmpA(path,"C:\\winebrowser\\assets")==0,21);
  IMalloc_Free(allocator,item);IMalloc_Release(allocator);
  report("INSTALLER APIS PASS\n");ExitProcess(0);
}
