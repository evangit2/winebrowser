/* Original MIT Win32 status-bar contract fixture. */
#include <windows.h>
#include <commctrl.h>
#define CHECK(x) do {if(!(x))ExitProcess(__LINE__);} while(0)
static HWND bar,wide_bar;
static unsigned simple_notifications,clicks;
static LRESULT CALLBACK proc(HWND window,UINT message,WPARAM wp,LPARAM lp) {
  if(message==WM_SIZE&&bar){SendMessageA(bar,WM_SIZE,wp,lp);return 0;}
  if(message==WM_NOTIFY){
    NMHDR *hdr=(NMHDR*)lp;
    if(hdr->code==SBN_SIMPLEMODECHANGE){CHECK(hdr->hwndFrom==bar&&hdr->idFrom==50&&wp==0);simple_notifications++;return 0;}
    if(hdr->code==NM_CLICK){
      NMMOUSE *mouse=(NMMOUSE*)lp;CHECK(hdr->hwndFrom==bar&&hdr->idFrom==50&&wp==50);
      CHECK(mouse->dwItemData==0&&mouse->dwHitInfo==0x30000);
      CHECK(mouse->dwItemSpec==(SendMessageA(bar,SB_ISSIMPLE,0,0)?255:1));
      clicks++;SetWindowTextA(window,"Native status click");return 1;
    }
  }
  if(message==WM_COMMAND&&LOWORD(wp)==10){
    BOOL simple=!SendMessageA(bar,SB_ISSIMPLE,0,0);
    CHECK(SendMessageA(bar,SB_SIMPLE,simple,0));
    CHECK(simple_notifications>=3);SetWindowTextA(window,simple?"Simple status":"Multipart status");return 0;
  }
  if(message==WM_COMMAND&&LOWORD(wp)==11){
    RECT rect={0,0,460,220};CHECK(AdjustWindowRect(&rect,WS_OVERLAPPEDWINDOW,FALSE));
    CHECK(MoveWindow(window,40,40,rect.right-rect.left,rect.bottom-rect.top,TRUE));
    CHECK(SendMessageA(bar,WM_SIZE,0,0)==0);
    RECT client,bounds;CHECK(GetClientRect(window,&client));CHECK(GetClientRect(bar,&bounds));
    CHECK(client.right==460&&client.bottom==220&&bounds.right==460);
    SetWindowTextA(window,"Resized status");return 0;
  }
  if(message==WM_DESTROY){CHECK(clicks>=2&&simple_notifications==4);PostQuitMessage(0);return 0;}
  return DefWindowProcA(window,message,wp,lp);
}
void start(void){
  HINSTANCE instance=GetModuleHandleA(NULL);
  WNDCLASSA klass={0};klass.hInstance=instance;klass.lpfnWndProc=proc;klass.lpszClassName="NativeStatusbar";klass.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);
  CHECK(RegisterClassA(&klass));
  RECT dimensions={0,0,360,180};CHECK(AdjustWindowRect(&dimensions,WS_OVERLAPPEDWINDOW,FALSE));
  HWND window=CreateWindowA(klass.lpszClassName,"Native status bars",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,dimensions.right-dimensions.left,dimensions.bottom-dimensions.top,NULL,NULL,instance,NULL);CHECK(window);
  HMODULE controls=LoadLibraryA("comctl32.dll");CHECK(controls);
  typedef HWND (WINAPI *CREATESTATUS)(LONG,LPCSTR,HWND,UINT);
  union {FARPROC raw;CREATESTATUS fn;} create;create.raw=GetProcAddress(controls,(LPCSTR)6);CHECK(create.fn);
  CHECK(create.raw==GetProcAddress(controls,"CreateStatusWindowA"));
  bar=create.fn(WS_CHILD|WS_VISIBLE|SBARS_TOOLTIPS,"Initial",window,50);CHECK(bar);
  wide_bar=CreateWindowW(STATUSCLASSNAMEW,L"Unicode status",WS_CHILD|WS_VISIBLE|CCS_NORESIZE,12,90,330,26,window,(HMENU)51,instance,NULL);CHECK(wide_bar);
  HWND transient=CreateStatusWindowW(WS_CHILD,L"Transient",window,52);CHECK(transient);CHECK(DestroyWindow(transient));
  CHECK(GetDlgCtrlID(bar)==50);
  int parts[]={150,-1},copied[3]={0,0,0x12345678};
  CHECK(SendMessageA(bar,SB_SETPARTS,2,(LPARAM)parts));
  CHECK(SendMessageA(bar,SB_GETPARTS,1,(LPARAM)copied)==2&&copied[0]==150&&!copied[1]&&copied[2]==0x12345678);
  int badparts[]={180,100};CHECK(!SendMessageA(bar,SB_SETPARTS,2,(LPARAM)badparts));
  CHECK(SendMessageA(bar,SB_GETPARTS,2,(LPARAM)copied)==2&&copied[0]==150&&copied[1]==-1);
  CHECK(SendMessageA(bar,SB_SETTEXTA,SBT_NOBORDERS,(LPARAM)"caf\xe9 \x80"));
  CHECK(SendMessageW(bar,SB_SETTEXTW,1|SBT_POPOUT,(LPARAM)L"Ready \x03a9"));
  char text[32];WCHAR unicode[32];
  CHECK(LOWORD(SendMessageA(bar,SB_GETTEXTA,0,(LPARAM)text))==6&&text[3]==(char)0xe9&&text[5]==(char)0x80&&!text[6]);
  LRESULT result=SendMessageW(bar,SB_GETTEXTW,1,(LPARAM)unicode);
  CHECK(LOWORD(result)==7&&HIWORD(result)==SBT_POPOUT&&unicode[6]==0x03a9&&!unicode[7]);
  CHECK(SendMessageW(bar,SB_GETTEXTLENGTHW,1,0)==result);
  CHECK(SendMessageW(wide_bar,SB_SETTEXTW,0,(LPARAM)L"Left\tMiddle\tRight"));
  CHECK(SendMessageA(bar,SB_SETTIPTEXTA,1,(LPARAM)"Native tip")==0);
  char tip[5]={'!','!','!','!','!'};CHECK(SendMessageA(bar,SB_GETTIPTEXTA,MAKELONG(1,4),(LPARAM)tip)==0);
  CHECK(tip[0]=='N'&&tip[2]=='t'&&!tip[3]&&tip[4]=='!');
  CHECK(SendMessageA(bar,SB_SETUNICODEFORMAT,TRUE,0)==FALSE&&SendMessageA(bar,SB_GETUNICODEFORMAT,0,0));
  int borders[3];CHECK(SendMessageA(bar,SB_GETBORDERS,0,(LPARAM)borders));CHECK(borders[0]==0&&borders[1]==2&&borders[2]==2);
  RECT rect;CHECK(SendMessageA(bar,SB_GETRECT,1,(LPARAM)&rect));CHECK(rect.left==152&&rect.right==360&&rect.top==2);
  CHECK(!SendMessageA(bar,SB_GETRECT,2,(LPARAM)&rect));
  CHECK(SendMessageA(bar,SB_SETTEXTA,SB_SIMPLEID|SBT_NOBORDERS,(LPARAM)"Simple progress"));
  CHECK(SendMessageA(bar,SB_SIMPLE,TRUE,0));CHECK(simple_notifications==1);
  CHECK(SendMessageA(bar,SB_SIMPLE,TRUE,0)&&simple_notifications==1);
  CHECK(LOWORD(SendMessageA(bar,SB_GETTEXTA,0,(LPARAM)text))==15&&text[0]=='S');
  CHECK(SendMessageA(bar,SB_SIMPLE,FALSE,0)&&simple_notifications==2);
  CHECK(SendMessageA(bar,SB_SETMINHEIGHT,24,0)==0);CHECK(SendMessageA(bar,WM_SIZE,0,0)==0);
  CHECK(GetClientRect(bar,&rect)&&rect.right==360&&rect.bottom==26);
  CHECK((COLORREF)SendMessageA(bar,SB_SETBKCOLOR,0,RGB(220,230,240))==CLR_DEFAULT);
  CHECK(SetWindowTextW(wide_bar,L"WM_SETTEXT \x03bb"));CHECK(GetWindowTextW(wide_bar,unicode,32)==12&&unicode[11]==0x03bb);
  CHECK(SendMessageW(wide_bar,SB_SETTEXTW,0,(LPARAM)L"Left\tMiddle\tRight"));
  CHECK(CreateWindowA("BUTTON","Toggle simple",WS_CHILD|WS_VISIBLE|WS_TABSTOP,12,12,140,28,window,(HMENU)10,instance,NULL));
  CHECK(CreateWindowA("BUTTON","Resize owner",WS_CHILD|WS_VISIBLE|WS_TABSTOP,172,12,140,28,window,(HMENU)11,instance,NULL));
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}
  ExitProcess((UINT)msg.wParam);
}
