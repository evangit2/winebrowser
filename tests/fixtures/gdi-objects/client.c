/* Original MIT EXE: native structure queries plus a real GDI font window. */
#include <windows.h>
#define CHECK(x) do{if(!(x))ExitProcess(__LINE__);}while(0)
static HFONT fonts[2];
static void same(const void *a,const void *b,unsigned count) {
  const unsigned char *x=a,*y=b;
  for(unsigned i=0;i<count;i++)CHECK(x[i]==y[i]);
}
static void queries(HGDIOBJ object,const void *expected,int size,BOOL wide,BOOL partial) {
  BYTE output[104];
  CHECK((wide?GetObjectW(object,0,NULL):GetObjectA(object,0,NULL))==size);
  for(int count=0;count<=size+8;count++) {
    for(unsigned i=0;i<sizeof(output);i++)output[i]=0xcc;
    int copied=partial?(count<size?count:size):(count<size?0:size);
    CHECK((wide?GetObjectW(object,count,output):GetObjectA(object,count,output))==copied);
    same(output,expected,copied);
    for(unsigned i=copied;i<sizeof(output);i++)CHECK(output[i]==0xcc);
  }
}
static LRESULT CALLBACK proc(HWND window,UINT message,WPARAM wp,LPARAM lp) {
  if(message==WM_PAINT) {
    PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);
    CHECK(SetBkMode(dc,TRANSPARENT));
    HGDIOBJ old=SelectObject(dc,fonts[0]);CHECK(old);
    static const char text[]="Native bold italic font";
    SetTextColor(dc,RGB(20,60,160));CHECK(TextOutA(dc,20,20,text,sizeof(text)-1));
    CHECK(SelectObject(dc,fonts[1])==fonts[0]);
    SetTextColor(dc,RGB(150,20,50));CHECK(TextOutW(dc,20,65,L"Unicode: \x03a9 \x20ac",12));
    CHECK(SelectObject(dc,old)==fonts[1]);CHECK(EndPaint(window,&ps));return 0;
  }
  if(message==WM_DESTROY){PostQuitMessage(0);return 0;}
  return DefWindowProcA(window,message,wp,lp);
}
void start(void) {
  HMODULE library=LoadLibraryA("native-fonts.dll");CHECK(library);
  union{FARPROC raw;HFONT(WINAPI *fn)(const LOGFONTA*);} createA;
  union{FARPROC raw;HFONT(WINAPI *fn)(const LOGFONTW*);} createW;
  createA.raw=GetProcAddress(library,"FontA");createW.raw=GetProcAddress(library,"FontW");CHECK(createA.fn&&createW.fn);
  LOGFONTA a={0};a.lfHeight=-24;a.lfWeight=700;a.lfItalic=1;a.lfUnderline=1;
  a.lfCharSet=ANSI_CHARSET;a.lfOutPrecision=OUT_TT_PRECIS;a.lfClipPrecision=CLIP_CHARACTER_PRECIS;a.lfQuality=ANTIALIASED_QUALITY;a.lfPitchAndFamily=VARIABLE_PITCH|FF_SWISS;
  const char face[]="Arial \x80";for(unsigned i=0;i<sizeof(face);i++)a.lfFaceName[i]=face[i];
  LOGFONTW w={0};w.lfHeight=-24;w.lfWeight=400;w.lfStrikeOut=1;w.lfCharSet=DEFAULT_CHARSET;
  const WCHAR wideface[]=L"Arial \x03a9 \x20ac";for(unsigned i=0;i<sizeof(wideface)/sizeof(WCHAR);i++)w.lfFaceName[i]=wideface[i];
  for(int i=0;i<4;i++) {
    fonts[0]=createA.fn(&a);fonts[1]=createW.fn(&w);CHECK(fonts[0]&&fonts[1]);
    queries(fonts[0],&a,sizeof(a),FALSE,TRUE);queries(fonts[1],&w,sizeof(w),TRUE,TRUE);
    if(i<3){CHECK(DeleteObject(fonts[0]));CHECK(DeleteObject(fonts[1]));}
  }
  CHECK(!createA.fn(NULL));CHECK(!createW.fn(NULL));
  HDC measured=CreateCompatibleDC(NULL);CHECK(measured);HGDIOBJ oldFont=SelectObject(measured,fonts[0]);CHECK(oldFont);
  TEXTMETRICA ma;TEXTMETRICW mw;CHECK(GetTextMetricsA(measured,&ma));CHECK(GetTextMetricsW(measured,&mw));
  CHECK(ma.tmWeight==700&&ma.tmItalic==1&&ma.tmUnderlined==1&&ma.tmStruckOut==0&&ma.tmCharSet==a.lfCharSet);
  CHECK(mw.tmWeight==700&&mw.tmItalic==1&&mw.tmUnderlined==1&&mw.tmStruckOut==0&&mw.tmCharSet==a.lfCharSet);
  union{FARPROC raw;BOOL(WINAPI *fn)(HDC,UINT,UINT,INT*);} widths; widths.raw=GetProcAddress(library,"Widths");CHECK(widths.fn);
  INT integer[98];FLOAT fractional[98];ABC abc[96];ABCFLOAT abcFloat[96];
  integer[95]=0x12345678;fractional[95]=123.5f;abc[95].abcA=0x12345678;abcFloat[95].abcfA=123.5f;
  CHECK(widths.fn(measured,32,126,integer));CHECK(GetCharWidthFloatA(measured,32,126,fractional));
  CHECK(GetCharABCWidthsA(measured,32,126,abc));CHECK(GetCharABCWidthsFloatA(measured,32,126,abcFloat));
  CHECK(integer[95]==0x12345678&&fractional[95]==123.5f&&abc[95].abcA==0x12345678&&abcFloat[95].abcfA==123.5f);
  CHECK(integer['W'-32]>integer['i'-32]);
  for(int i=0;i<95;i++) {
    CHECK(integer[i]==abc[i].abcA+(INT)abc[i].abcB+abc[i].abcC);
    FLOAT delta=abcFloat[i].abcfA+abcFloat[i].abcfB+abcFloat[i].abcfC-fractional[i];CHECK(delta<0.01f&&delta>-0.01f);
    delta=(FLOAT)integer[i]-fractional[i];CHECK(delta<=0.5f&&delta>=-0.5f);
  }
  FLOAT ansiEuro,wideEuro;CHECK(GetCharWidthFloatA(measured,0x80,0x80,&ansiEuro));CHECK(GetCharWidthFloatW(measured,0x20ac,0x20ac,&wideEuro));CHECK(ansiEuro==wideEuro);
  CHECK(GetCharWidth32W(measured,32,126,integer));CHECK(GetCharWidthFloatW(measured,32,126,fractional));
  CHECK(GetCharABCWidthsW(measured,32,126,abc));CHECK(GetCharABCWidthsFloatW(measured,32,126,abcFloat));
  CHECK(SelectObject(measured,oldFont)==fonts[0]);CHECK(DeleteDC(measured));CHECK(FreeLibrary(library));
  LOGFONTW zero={0};HFONT defaultFont=CreateFontIndirectW(&zero);CHECK(defaultFont);queries(defaultFont,&zero,sizeof(zero),TRUE,TRUE);CHECK(DeleteObject(defaultFont));
  LOGPEN p={PS_SOLID,{0,0},RGB(10,20,30)};HPEN pen=CreatePen(p.lopnStyle,0,p.lopnColor);CHECK(pen);queries(pen,&p,sizeof(p),FALSE,FALSE);CHECK(DeleteObject(pen));
  LOGBRUSH b={BS_SOLID,RGB(20,30,40),0};HBRUSH brush=CreateSolidBrush(b.lbColor);CHECK(brush);queries(brush,&b,sizeof(b),TRUE,TRUE);CHECK(DeleteObject(brush));
  b.lbStyle=BS_HATCHED;b.lbHatch=HS_DIAGCROSS;brush=CreateHatchBrush(b.lbHatch,b.lbColor);CHECK(brush);queries(brush,&b,sizeof(b),FALSE,TRUE);CHECK(DeleteObject(brush));
  WNDCLASSA klass={0};klass.hInstance=GetModuleHandleA(NULL);klass.lpfnWndProc=proc;klass.lpszClassName="NativeFonts";klass.hbrBackground=(HBRUSH)(COLOR_WINDOW+1);CHECK(RegisterClassA(&klass));
  RECT bounds={0,0,420,130};CHECK(AdjustWindowRect(&bounds,WS_OVERLAPPEDWINDOW,FALSE));
  HWND window=CreateWindowA(klass.lpszClassName,"Native EXE and DLL fonts",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,bounds.right-bounds.left,bounds.bottom-bounds.top,NULL,NULL,klass.hInstance,NULL);CHECK(window);CHECK(UpdateWindow(window));
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}
  CHECK(DeleteObject(fonts[0]));CHECK(DeleteObject(fonts[1]));ExitProcess((UINT)msg.wParam);
}
