/* Original WineBrowser contributors, MIT. Native interactive scrollbar GUI. */
#define UNICODE
#include <windows.h>
#define CHECK(x) do{if(!(x))ExitProcess(1000+__LINE__);}while(0)
void *memset(void *target,int value,size_t count){BYTE *p=target;while(count--)*p++=(BYTE)value;return target;}
static HWND root,bars[9],labels[6];static unsigned stage;
static const WCHAR *titles[]={L"Native scrollbars - Normal",L"Native scrollbars - Large page",L"Native scrollbars - Left off",L"Native scrollbars - Right off",L"Native scrollbars - All off",L"Native scrollbars - Limits",L"Native scrollbars - Normal",L"Native scrollbars - Disabled window",L"Native scrollbars - Enabled window"};
static WCHAR *copy(WCHAR *out,const WCHAR *in){while(*in)*out++=*in++;return out;}
static WCHAR *number(WCHAR *out,LONG value){WCHAR digits[10];unsigned count=0;DWORD n=(DWORD)value;if(value<0){*out++=L'-';n=0-n;}do{digits[count++]=(WCHAR)(L'0'+n%10);n/=10;}while(n);while(count)*out++=digits[--count];return out;}
static void label(HWND window,const WCHAR *prefix,LONG value){WCHAR buf[80],*end=copy(buf,prefix);end=number(end,value);*end=0;CHECK(SetWindowTextW(window,buf));}
static SCROLLINFO info(HWND window){SCROLLINFO out={28,SIF_ALL,1,2,3,4,5};SetLastError(777);CHECK(GetScrollInfo(window,SB_CTL,&out)&&GetLastError()==777);CHECK(out.cbSize==28&&out.fMask==SIF_ALL);
 SCROLLBARINFO b={0};b.cbSize=60;b.reserved=12345;SetLastError(777);CHECK(GetScrollBarInfo(window,OBJID_CLIENT,&b)&&GetLastError()==0);
 CHECK(b.cbSize==60&&b.reserved==12345&&b.dxyLineButton==b.xyThumbBottom-b.xyThumbTop);
 RECT rect;CHECK(GetWindowRect(window,&rect));CHECK(b.rcScrollBar.left==rect.left&&b.rcScrollBar.top==rect.top&&b.rcScrollBar.right==rect.right&&b.rcScrollBar.bottom==rect.bottom);
 BOOL unavailable=(LONGLONG)out.nMin>=(LONGLONG)out.nMax-(out.nPage?(LONGLONG)out.nPage-1:0)||!IsWindowEnabled(window);
 CHECK(((b.rgstate[0]&STATE_SYSTEM_UNAVAILABLE)!=0)==unavailable);return out;}
static void update(void){SCROLLINFO h=info(bars[0]),v=info(bars[3]);label(labels[0],L"Horizontal position: ",h.nPos);label(labels[1],L"Vertical position: ",v.nPos);SetLastError(777);UINT dpi=GetDpiForWindow(root);CHECK(dpi==96&&GetLastError()==777);label(labels[3],L"Window DPI: ",dpi);SCROLLBARINFO b={0};b.cbSize=60;CHECK(GetScrollBarInfo(bars[0],OBJID_CLIENT,&b));label(labels[5],L"Horizontal thumb pixels: ",b.dxyLineButton);}
static void reset(unsigned next){stage=next;SCROLLINFO in={28,SIF_ALL,10,40,8,20,0};if(stage==1)in.nPage=100;if(stage==5){in.nMin=-20;in.nMax=200000;in.nPage=64;in.nPos=80000;}
 for(int i=0;i<9;i++){
  SetLastError(777);
  CHECK(EnableScrollBar(bars[i],SB_CTL,0));
  int expected=stage==1?10:stage==5?80000:20;
  CHECK(SetScrollInfo(bars[i],SB_CTL,&in,TRUE)==expected);
  if(stage>=2&&stage<=4)CHECK(EnableScrollBar(bars[i],SB_CTL,stage-1));
  CHECK(IsWindowEnabled(bars[i])==(stage!=4));
  CHECK(((GetWindowLongW(bars[i],GWL_STYLE)&WS_DISABLED)!=0)==(stage==4));
  SCROLLINFO out=info(bars[i]);
  CHECK(out.nMin==in.nMin);
  CHECK(out.nMax==in.nMax);
  CHECK(out.nPos==expected);
  CHECK(out.nPage==(stage==1?31:in.nPage));
 }

 update();label(labels[2],L"Last event: ",-1);label(labels[4],L"Aligned position: ",info(bars[5]).nPos);CHECK(SetWindowTextW(root,titles[stage]));}
static LRESULT CALLBACK procedure(HWND window,UINT msg,WPARAM wp,LPARAM lp){
 if(window==root&&msg==WM_COMMAND&&HIWORD(wp)==BN_CLICKED&&LOWORD(wp)>=101&&LOWORD(wp)<=107){reset(LOWORD(wp)-101);return 0;}
 if(window==root&&msg==WM_COMMAND&&HIWORD(wp)==BN_CLICKED&&(LOWORD(wp)==108||LOWORD(wp)==109)){
  BOOL enabled=LOWORD(wp)==109;for(int i=0;i<9;i++){
   EnableWindow(bars[i],enabled);CHECK(IsWindowEnabled(bars[i])==enabled);
   CHECK(((GetWindowLongW(bars[i],GWL_STYLE)&WS_DISABLED)!=0)==!enabled);
  }update();label(labels[2],L"Last event: ",-1);CHECK(SetWindowTextW(root,titles[enabled?8:7]));return 0;
 }
 if(window==root&&(msg==WM_HSCROLL||msg==WM_VSCROLL)){
  HWND control=(HWND)lp;BOOL found=FALSE;for(int i=0;i<9;i++)if(bars[i]==control)found=TRUE;CHECK(found);
  SCROLLINFO out=info(control);int command=LOWORD(wp),pos=out.nPos;
  if(command==SB_LINEUP)pos--;else if(command==SB_LINEDOWN)pos++;else if(command==SB_PAGEUP)pos-=(int)out.nPage;else if(command==SB_PAGEDOWN)pos+=(int)out.nPage;else if(command==SB_TOP)pos=out.nMin;else if(command==SB_BOTTOM)pos=out.nMax;else if(command==SB_THUMBTRACK||command==SB_THUMBPOSITION)pos=out.nTrackPos;else CHECK(command==SB_ENDSCROLL);
  if(command!=SB_ENDSCROLL){out.fMask=SIF_POS;out.nPos=pos;SetScrollInfo(control,SB_CTL,&out,TRUE);}
  update();label(labels[2],L"Last event: ",command);if(control!=bars[0]&&control!=bars[3])label(labels[4],L"Aligned position: ",info(control).nPos);return 0;
 }
 if(window==root&&msg==WM_PAINT){PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);RECT rect={0,0,640,410};CHECK(FillRect(dc,&rect,(HBRUSH)GetStockObject(WHITE_BRUSH))&&EndPaint(window,&ps));return 0;}
 if(window==root&&(msg==WM_CLOSE||(msg==WM_KEYDOWN&&wp==VK_ESCAPE))){PostQuitMessage(0);return 0;}
 return DefWindowProcW(window,msg,wp,lp);
}
void start(void){
 WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=GetModuleHandleW(NULL);cls.hCursor=LoadCursorW(NULL,IDC_ARROW);cls.lpszClassName=L"NativeScrollbarControls";CHECK(RegisterClassW(&cls));
 root=CreateWindowExW(0,cls.lpszClassName,L"Native scrollbars",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,642,440,NULL,NULL,cls.hInstance,NULL);CHECK(root);
 SetLastError(777);CHECK(!GetDpiForWindow(NULL)&&GetLastError()==1400);
 SetLastError(777);CHECK(GetDpiForWindow(GetDesktopWindow())==96&&GetLastError()==777);
 const WCHAR *buttons[]={L"Normal",L"Large page",L"Left off",L"Right off",L"All off",L"Limits",L"Reset",L"Disable",L"Enable"};
 for(int i=0;i<9;i++)CHECK(CreateWindowExW(0,L"BUTTON",buttons[i],WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,12+(i%5)*124,8+(i/5)*36,116,28,root,(HMENU)(INT_PTR)(101+i),cls.hInstance,NULL));
 CHECK(CreateWindowExW(0,L"STATIC",L"Click arrows or track, drag thumbs, or use arrow/page keys.",WS_CHILD|WS_VISIBLE|SS_CENTER,8,76,624,24,root,NULL,cls.hInstance,NULL));
 const int rects[9][4]={{20,112,180,17},{220,112,180,25},{20,158,8,17},{520,112,17,180},{560,112,25,180},{60,158,180,25},{260,158,180,25},{600,112,25,180},{607,112,33,180}};
 const DWORD styles[9]={0,0,0,SBS_VERT,SBS_VERT,SBS_TOPALIGN,SBS_BOTTOMALIGN,SBS_VERT|SBS_LEFTALIGN,SBS_VERT|SBS_RIGHTALIGN};
 const int expected[9][4]={{20,112,180,17},{220,112,180,25},{20,158,8,17},{520,112,17,180},{560,112,25,180},{60,158,180,18},{260,165,180,18},{600,112,18,180},{622,112,18,180}};
 for(int i=0;i<9;i++){bars[i]=CreateWindowExW(0,L"SCROLLBAR",L"",WS_CHILD|WS_VISIBLE|WS_TABSTOP|styles[i],rects[i][0],rects[i][1],rects[i][2],rects[i][3],root,(HMENU)(INT_PTR)(201+i),cls.hInstance,NULL);CHECK(bars[i]);
 RECT rect,client;CHECK(GetWindowRect(bars[i],&rect)&&GetClientRect(bars[i],&client));POINT point={rect.left,rect.top};CHECK(ScreenToClient(root,&point));
 CHECK(point.x==expected[i][0]&&point.y==expected[i][1]&&rect.right-rect.left==expected[i][2]&&rect.bottom-rect.top==expected[i][3]);
 CHECK(client.left==0&&client.top==0&&client.right==expected[i][2]&&client.bottom==expected[i][3]);
 CHECK((GetWindowLongW(bars[i],GWL_STYLE)&7)==(LONG)styles[i]);
 SCROLLINFO out=info(bars[i]);CHECK(out.nMin==0&&out.nMax==0&&out.nPage==0&&out.nPos==0&&out.nTrackPos==0);}
 WCHAR className[32];CHECK(GetClassNameW(bars[0],className,32)==9&&!lstrcmpW(className,L"ScrollBar"));
 for(int i=0;i<4;i++){labels[i]=CreateWindowExW(0,L"STATIC",L"",WS_CHILD|WS_VISIBLE|SS_LEFT,20,216+i*40,470,30,root,(HMENU)(INT_PTR)(301+i),cls.hInstance,NULL);CHECK(labels[i]);}
 labels[4]=CreateWindowExW(0,L"STATIC",L"",WS_CHILD|WS_VISIBLE|SS_LEFT,20,188,470,24,root,(HMENU)305,cls.hInstance,NULL);CHECK(labels[4]);
 labels[5]=CreateWindowExW(0,L"STATIC",L"",WS_CHILD|WS_VISIBLE|SS_LEFT,20,376,470,24,root,(HMENU)306,cls.hInstance,NULL);CHECK(labels[5]);
 reset(0);ShowWindow(root,SW_SHOW);CHECK(UpdateWindow(root));MSG msg;while(GetMessageW(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}
 CHECK(DestroyWindow(root));const char output[]="NATIVE SCROLLBAR CONTROLS GUI PASS\n";DWORD wrote=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),output,sizeof(output)-1,&wrote,NULL)&&wrote==sizeof(output)-1);ExitProcess(0);
}
