/* Original MIT fixture. The unchanged PE32 binary is translated in Chromium. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(__LINE__+1000); } while(0)
static HWND root, controls[4];
static WNDPROC previous[4];
static HDC held;
static int drawing=1;
static unsigned edits, clicks, nested, resized, partial, recreated, colors, combos;
static const COLORREF ink[4]={RGB(24,100,200),RGB(200,80,24),RGB(30,150,80),RGB(160,40,100)};
static void draw(unsigned i) {
  HDC dc=GetDC(controls[i]);CHECK(dc);
  HBRUSH brush=CreateSolidBrush(ink[i]);CHECK(brush);
  RECT area={8,8,40,24};CHECK(FillRect(dc,&area,brush));
  CHECK(GetPixel(dc,10,10)==ink[i]);
  if(i==0){CHECK(SetBkMode(dc,TRANSPARENT));CHECK(SetTextColor(dc,RGB(120,20,140))!=CLR_INVALID);CHECK(TextOutA(dc,60,34,"Native GDI text",15));}
  CHECK(DeleteObject(brush));CHECK(ReleaseDC(controls[i],dc));
}
static LRESULT CALLBACK child(HWND w,UINT msg,WPARAM wp,LPARAM lp) {
  unsigned i=0;while(i<4 && controls[i]!=w)i++;CHECK(i<4);
  LRESULT value=CallWindowProcA(previous[i],w,msg,wp,lp);
  if(msg==WM_PAINT && drawing && IsWindow(w))draw(i);
  return value;
}
static void repaint(unsigned i){CHECK(InvalidateRect(controls[i],NULL,TRUE));CHECK(UpdateWindow(controls[i]));}
static void create_static(HINSTANCE instance) {
  controls[0]=CreateWindowA("STATIC","Browser label",WS_CHILD|WS_VISIBLE,20,20,300,72,root,(HMENU)70,instance,NULL);CHECK(controls[0]);
  previous[0]=(WNDPROC)SetWindowLongA(controls[0],GWL_WNDPROC,(LONG)child);CHECK(previous[0]);
  CHECK(CreateWindowA("BUTTON","Nested child",WS_CHILD|WS_VISIBLE,150,4,130,26,controls[0],(HMENU)90,instance,NULL));
}
static LRESULT CALLBACK proc(HWND w,UINT msg,WPARAM wp,LPARAM lp) {
  if(msg>=WM_CTLCOLORMSGBOX && msg<=WM_CTLCOLORSTATIC){colors++;return DefWindowProcA(w,msg,wp,lp);}
  if(msg==WM_COMMAND){unsigned id=LOWORD(wp);
    if(id==71 && HIWORD(wp)==EN_CHANGE){char value[32];CHECK(GetWindowTextA(controls[1],value,32)==5 && value[0]=='t');edits++;SetWindowTextA(root,"Typed through drawing");return 0;}
    if(id==73 && HIWORD(wp)==CBN_SELCHANGE){CHECK(SendMessageA(controls[3],CB_GETCURSEL,0,0)==1);combos++;SetWindowTextA(root,"Combo selection through drawing");return 0;}
    if(id==72){clicks++;SetWindowTextA(root,"Clicked through drawing");return 0;}
    if(id==80){drawing=0;for(unsigned i=0;i<4;i++)repaint(i);CHECK(GetPixel(held,10,10)==CLR_INVALID && GetLastError()==ERROR_CALL_NOT_IMPLEMENTED);SetWindowTextA(root,"Drawing cleared");return 0;}
    if(id==81){drawing=1;for(unsigned i=0;i<4;i++)draw(i);SetWindowTextA(root,"Direct drawing restored");return 0;}
    if(id==82){drawing=0;RECT area={8,8,24,24};CHECK(InvalidateRect(controls[0],&area,FALSE));CHECK(UpdateWindow(controls[0]));drawing=1;partial++;SetWindowTextA(root,"Partial repaint");return 0;}
    if(id==83){CHECK(SetWindowPos(controls[0],NULL,20,20,360,80,SWP_NOZORDER|SWP_NOACTIVATE));CHECK(UpdateWindow(controls[0]));RECT r;CHECK(GetClientRect(controls[0],&r) && r.right==360 && r.bottom==80);resized++;SetWindowTextA(root,"Drawing resized");return 0;}
    if(id==84){HWND old=controls[0];CHECK(DestroyWindow(old));CHECK(!GetDC(old) && GetLastError()==ERROR_INVALID_WINDOW_HANDLE);create_static(GetModuleHandleA(NULL));repaint(0);recreated++;SetWindowTextA(root,"Drawing recreated");return 0;}
  }
  if(msg==WM_CLOSE){CHECK(edits && clicks && nested && resized && partial && recreated && colors && combos);CHECK(ReleaseDC(controls[1],held));}
  if(msg==WM_DESTROY){PostQuitMessage(0);return 0;}
  return DefWindowProcA(w,msg,wp,lp);
}
/* Nested STATIC forwards its child's WM_COMMAND to the root explicitly. */
static LRESULT CALLBACK static_child(HWND w,UINT msg,WPARAM wp,LPARAM lp) {
  if(msg==WM_COMMAND && LOWORD(wp)==90){nested++;SetWindowTextA(root,"Nested child clicked");return 0;}
  return child(w,msg,wp,lp);
}
void start(void) {
  HINSTANCE instance=GetModuleHandleA(NULL);WNDCLASSA cls={0};cls.hInstance=instance;cls.lpfnWndProc=proc;cls.lpszClassName="NativeControlDrawing";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);CHECK(RegisterClassA(&cls));
  root=CreateWindowA(cls.lpszClassName,"Drawing starting",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,440,470,NULL,NULL,instance,NULL);CHECK(root);
  create_static(instance);CHECK(SetWindowLongA(controls[0],GWL_WNDPROC,(LONG)static_child));
  controls[1]=CreateWindowExA(WS_EX_CLIENTEDGE,"EDIT","native edit",WS_CHILD|WS_VISIBLE|WS_TABSTOP|ES_AUTOHSCROLL,20,110,300,40,root,(HMENU)71,instance,NULL);CHECK(controls[1]);
  controls[2]=CreateWindowA("BUTTON","Native button",WS_CHILD|WS_VISIBLE|WS_TABSTOP,20,170,300,40,root,(HMENU)72,instance,NULL);CHECK(controls[2]);
  controls[3]=CreateWindowA("COMBOBOX","Native combo",WS_CHILD|WS_VISIBLE|WS_TABSTOP|CBS_DROPDOWNLIST|CBS_HASSTRINGS,20,216,300,28,root,(HMENU)73,instance,NULL);CHECK(controls[3]);
  CHECK(SendMessageA(controls[3],CB_ADDSTRING,0,(LPARAM)"Alpha")==0);CHECK(SendMessageA(controls[3],CB_ADDSTRING,0,(LPARAM)"Beta")==1);CHECK(SendMessageA(controls[3],CB_SETCURSEL,0,0)==0);
  for(unsigned i=1;i<4;i++){previous[i]=(WNDPROC)SetWindowLongA(controls[i],GWL_WNDPROC,(LONG)child);CHECK(previous[i]);}
  const char *labels[5]={"Clear drawing","Draw directly","Partial repaint","Resize drawing","Recreate control"};
  for(unsigned i=0;i<5;i++)CHECK(CreateWindowA("BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,20+(i%2)*190,260+(i/2)*42,180,32,root,(HMENU)(80+i),instance,NULL));
  for(unsigned i=0;i<4;i++)repaint(i);
  held=GetDC(controls[1]);CHECK(held);SetWindowTextA(root,"Drawing ready");
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}
  CHECK(!IsWindow(controls[0]) && !IsWindow(controls[1]) && !IsWindow(controls[2]));ExitProcess((UINT)msg.wParam);
}
