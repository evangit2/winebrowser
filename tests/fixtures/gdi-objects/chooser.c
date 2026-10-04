/* Original MIT native ChooseFont A/W interactive acceptance. */
#include <windows.h>
#include <commdlg.h>
#define CHECK(x) do{if(!(x))ExitProcess(__LINE__);}while(0)
static HFONT font;
static LRESULT CALLBACK proc(HWND window,UINT message,WPARAM wp,LPARAM lp) {
  if(message==WM_PAINT){PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);HGDIOBJ old=SelectObject(dc,font);CHECK(old);
    SetBkMode(dc,TRANSPARENT);SetTextColor(dc,RGB(20,80,160));CHECK(TextOutW(dc,20,20,L"Chosen font: \x03a9",14));
    SelectObject(dc,old);EndPaint(window,&ps);return 0;}
  if(message==WM_DESTROY){PostQuitMessage(0);return 0;}
  return DefWindowProcA(window,message,wp,lp);
}
void start(void) {
  LOGFONTA a={0};a.lfHeight=-16;a.lfWeight=400;a.lfCharSet=DEFAULT_CHARSET;
  const char face[]="Arial";for(unsigned i=0;i<sizeof(face);i++)a.lfFaceName[i]=face[i];
  CHOOSEFONTA cf={0};cf.lStructSize=sizeof(cf);cf.lpLogFont=&a;cf.Flags=CF_SCREENFONTS|CF_INITTOLOGFONTSTRUCT|CF_EFFECTS;
  LOGFONTA original=a;CHECK(!ChooseFontA(&cf));CHECK(CommDlgExtendedError()==0);
  const BYTE *before=(const BYTE*)&original,*after=(const BYTE*)&a;for(unsigned i=0;i<sizeof(a);i++)CHECK(before[i]==after[i]);
  CHECK(ChooseFontA(&cf));CHECK(cf.iPointSize==180&&a.lfHeight==-24&&a.lfWeight==700&&a.lfItalic==1&&a.lfUnderline==1&&cf.rgbColors==RGB(20,80,160));
  CHECK(a.lfFaceName[0]=='C'&&a.lfFaceName[1]=='o'&&cf.nFontType==(SCREEN_FONTTYPE|BOLD_FONTTYPE|ITALIC_FONTTYPE));
  LOGFONTW w={0};w.lfHeight=-16;w.lfWeight=400;w.lfCharSet=DEFAULT_CHARSET;
  const WCHAR wideface[]=L"Arial";for(unsigned i=0;i<sizeof(wideface)/sizeof(WCHAR);i++)w.lfFaceName[i]=wideface[i];
  CHOOSEFONTW cw={0};cw.lStructSize=sizeof(cw);cw.lpLogFont=&w;cw.Flags=CF_SCREENFONTS|CF_INITTOLOGFONTSTRUCT|CF_LIMITSIZE;cw.nSizeMin=8;cw.nSizeMax=30;
  CHECK(ChooseFontW(&cw));CHECK(cw.iPointSize==180&&w.lfHeight==-24&&w.lfWeight==400&&w.lfFaceName[6]==0x03a9);
  CHECK(cw.nFontType==(SCREEN_FONTTYPE|REGULAR_FONTTYPE));font=CreateFontIndirectW(&w);CHECK(font);
  WNDCLASSA klass={0};klass.hInstance=GetModuleHandleA(NULL);klass.lpfnWndProc=proc;klass.lpszClassName="ChosenFont";klass.hbrBackground=(HBRUSH)(COLOR_WINDOW+1);CHECK(RegisterClassA(&klass));
  RECT bounds={0,0,320,100};CHECK(AdjustWindowRect(&bounds,WS_OVERLAPPEDWINDOW,FALSE));
  HWND window=CreateWindowA(klass.lpszClassName,"Native chosen font",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,bounds.right-bounds.left,bounds.bottom-bounds.top,NULL,NULL,klass.hInstance,NULL);CHECK(window);CHECK(UpdateWindow(window));
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}CHECK(DeleteObject(font));ExitProcess((UINT)msg.wParam);
}
