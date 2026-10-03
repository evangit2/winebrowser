/* Original MIT native drag-list contract fixture. See README.md. */
#include <windows.h>
#include <commctrl.h>
#define CHECK(x) do { if(!(x))ExitProcess(__LINE__); } while(0)
static HWND list;
static UINT drag_message;
static int source=-1, allow_drag=1;
static unsigned dropped,cancelled,rejected,scrolled;
static LRESULT CALLBACK proc(HWND root,UINT msg,WPARAM wp,LPARAM lp) {
  if(msg==drag_message) {
    DRAGLISTINFO *d=(DRAGLISTINFO*)lp;
    CHECK(wp==80 && d->hWnd==list);
    if(d->uNotification==DL_BEGINDRAG) {
      if(!allow_drag){rejected++;CHECK(SetWindowTextA(root,"Rejected"));return FALSE;}
      source=LBItemFromPt(list,d->ptCursor,FALSE);CHECK(source>=0);
      CHECK(SetWindowTextA(root,"Dragging"));return TRUE;
    }
    if(d->uNotification==DL_DRAGGING) {
      int target=LBItemFromPt(list,d->ptCursor,TRUE);
      DrawInsert(root,list,target);
      if(SendMessageA(list,LB_GETTOPINDEX,0,0)>0){scrolled++;CHECK(SetWindowTextA(root,"Scrolled"));}
      else {char text[]="Target 0";text[7]=(char)('0'+target);CHECK(SetWindowTextA(root,text));}
      return DL_MOVECURSOR;
    }
    if(d->uNotification==DL_DROPPED) {
      CHECK(GetCapture()==NULL);
      int target=LBItemFromPt(list,d->ptCursor,FALSE);CHECK(target>=0 && source>=0);
      char text[32];CHECK(SendMessageA(list,LB_GETTEXT,source,(LPARAM)text)>0);
      LPARAM data=SendMessageA(list,LB_GETITEMDATA,source,0);
      CHECK(SendMessageA(list,LB_DELETESTRING,source,0)==7);
      if(source<target)target--;
      CHECK(SendMessageA(list,LB_INSERTSTRING,target,(LPARAM)text)==target);
      CHECK(SendMessageA(list,LB_SETITEMDATA,target,data)==0);
      CHECK(SendMessageA(list,LB_SETCURSEL,target,0)==target);
      DrawInsert(root,list,-1);dropped++;CHECK(SetWindowTextA(root,"Dropped"));return 0;
    }
    if(d->uNotification==DL_CANCELDRAG) {
      CHECK(GetCapture()==NULL);DrawInsert(root,list,-1);cancelled++;
      CHECK(SetWindowTextA(root,"Cancelled"));return 0;
    }
    CHECK(FALSE);
  }
  if(msg==WM_COMMAND && LOWORD(wp)==90) {allow_drag=!allow_drag;CHECK(SetWindowTextA(root,allow_drag?"Accept mode":"Reject mode"));return 0;}
  if(msg==WM_CLOSE) {
    CHECK(dropped==1 && cancelled==2 && rejected==1 && scrolled>0 && GetCapture()==NULL);
    char text[32];CHECK(SendMessageA(list,LB_GETTEXT,2,(LPARAM)text)==4);
    CHECK(text[0]=='B' && text[1]=='e' && text[2]=='t' && text[3]=='a');
    CHECK(SendMessageA(list,LB_GETITEMDATA,2,0)==20);
  }
  if(msg==WM_DESTROY){PostQuitMessage(0);return 0;}
  return DefWindowProcA(root,msg,wp,lp);
}
void start(void) {
  drag_message=RegisterWindowMessageA(DRAGLISTMSGSTRING);CHECK(drag_message>=0xc000);
  HMODULE common=LoadLibraryA("comctl32.dll");CHECK(common);
  CHECK(GetProcAddress(common,(LPCSTR)13)==GetProcAddress(common,"MakeDragList"));
  CHECK(GetProcAddress(common,(LPCSTR)14)==GetProcAddress(common,"LBItemFromPt"));
  CHECK(GetProcAddress(common,(LPCSTR)15)==GetProcAddress(common,"DrawInsert"));
  HINSTANCE instance=GetModuleHandleA(NULL);WNDCLASSA cls={0};cls.hInstance=instance;
  cls.lpfnWndProc=proc;cls.lpszClassName="NativeDragList";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);
  CHECK(RegisterClassA(&cls));RECT r={0,0,340,220};CHECK(AdjustWindowRect(&r,WS_OVERLAPPEDWINDOW,FALSE));
  HWND root=CreateWindowA(cls.lpszClassName,"Drag list ready",WS_OVERLAPPEDWINDOW|WS_VISIBLE,
    40,40,r.right-r.left,r.bottom-r.top,NULL,NULL,instance,NULL);CHECK(root);
  list=CreateWindowExA(WS_EX_CLIENTEDGE,"LISTBOX","Preferences",WS_CHILD|WS_VISIBLE|WS_TABSTOP|LBS_NOTIFY|LBS_HASSTRINGS,
    30,20,280,100,root,(HMENU)80,instance,NULL);CHECK(list);
  CHECK(SendMessageA(list,LB_SETITEMHEIGHT,0,24)==0);
  const char *items[]={"Alpha","Beta","Gamma","Delta","Epsilon","Zeta","Eta","Theta"};
  for(int i=0;i<8;i++){CHECK(SendMessageA(list,LB_ADDSTRING,0,(LPARAM)items[i])==i);CHECK(SendMessageA(list,LB_SETITEMDATA,i,(i+1)*10)==0);}
  CHECK(MakeDragList(list));CHECK(MakeDragList(list));
  RECT row;CHECK(SendMessageA(list,LB_GETITEMRECT,3,(LPARAM)&row)==0);
  CHECK(row.top==72 && row.bottom==96 && row.right==276);
  POINT p={row.left+1,row.top+1};CHECK(ClientToScreen(list,&p));CHECK(LBItemFromPt(list,p,FALSE)==3);
  CHECK(CreateWindowA("BUTTON","Toggle acceptance",WS_CHILD|WS_VISIBLE|WS_TABSTOP,30,155,200,28,root,(HMENU)90,instance,NULL));
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){if(!IsDialogMessageA(root,&msg)){TranslateMessage(&msg);DispatchMessageA(&msg);}}
  CHECK(!IsWindow(list));CHECK(FreeLibrary(common));ExitProcess((UINT)msg.wParam);
}
