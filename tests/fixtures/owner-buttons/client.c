/* Authored MIT fixture: native owner-drawn ANSI/Unicode BUTTON controls. */
#include <windows.h>
#define CHECK(x) do {if(!(x))ExitProcess(__LINE__+1000);} while(0)
static HWND root,buttons[2];static HFONT font;
static unsigned actions,states,clicked,wide_clicked,disabled,manual,resize;
static LRESULT CALLBACK proc(HWND w,UINT msg,WPARAM wp,LPARAM lp) {
  if(msg==WM_CTLCOLORBTN){CHECK(SetTextColor((HDC)wp,RGB(255,255,255))!=CLR_INVALID);CHECK(SetBkMode((HDC)wp,TRANSPARENT));return (LRESULT)GetStockObject(NULL_BRUSH);}
  if(msg==WM_DRAWITEM){DRAWITEMSTRUCT *item=(DRAWITEMSTRUCT*)lp;
    CHECK(item->CtlType==ODT_BUTTON && item->CtlID==wp && item->itemID==0 && item->itemData==0);
    unsigned i=item->CtlID==70?0:1;CHECK(item->CtlID==70 || item->CtlID==71);CHECK(item->hwndItem==buttons[i]);
    CHECK(item->itemAction==ODA_DRAWENTIRE || item->itemAction==ODA_SELECT || item->itemAction==ODA_FOCUS);
    unsigned state=(unsigned)SendMessageA(item->hwndItem,BM_GETSTATE,0,0);
    CHECK(!!(item->itemState&ODS_SELECTED)==!!(state&BST_PUSHED));CHECK(!!(item->itemState&ODS_FOCUS)==!!(state&BST_FOCUS));CHECK(!!(item->itemState&ODS_DISABLED)==!IsWindowEnabled(item->hwndItem));
    RECT rect;CHECK(GetClientRect(item->hwndItem,&rect));CHECK(item->rcItem.left==0 && item->rcItem.top==0 && item->rcItem.right==rect.right && item->rcItem.bottom==rect.bottom);
    CHECK(GetCurrentObject(item->hDC,OBJ_FONT)==font);CHECK(GetTextColor(item->hDC)==RGB(255,255,255));
    actions|=item->itemAction;states|=item->itemState;
    COLORREF color=item->itemState&ODS_DISABLED?RGB(110,110,110):item->itemState&ODS_SELECTED?RGB(200,40,60):i?RGB(30,150,80):RGB(24,100,200);
    HBRUSH brush=CreateSolidBrush(color);CHECK(brush && FillRect(item->hDC,&rect,brush));CHECK(DeleteObject(brush));
    if(item->itemState&ODS_FOCUS){rect.top=rect.bottom-4;brush=CreateSolidBrush(RGB(255,210,20));CHECK(FillRect(item->hDC,&rect,brush));CHECK(DeleteObject(brush));}
    if(i)CHECK(TextOutW(item->hDC,52,16,L"Wide \x03bb",6));else CHECK(TextOutA(item->hDC,52,16,"Draw button",11));
    return TRUE;
  }
  if(msg==WM_COMMAND){unsigned id=LOWORD(wp);
    if(HIWORD(wp)!=BN_CLICKED)return 0;
    if(id==70){CHECK(!(SendMessageA(buttons[0],BM_GETSTATE,0,0)&BST_PUSHED));clicked++;SetWindowTextA(root,clicked==1?"Mouse clicked":clicked==2?"Space clicked":clicked==3?"Enter clicked":"Programmatic clicked");return 0;}
    if(id==71){wide_clicked++;SetWindowTextA(root,"Wide clicked");return 0;}
    if(id==80){CHECK(!EnableWindow(buttons[0],FALSE));CHECK(UpdateWindow(buttons[0]));CHECK(!(SendMessageA(buttons[0],BM_GETSTATE,0,0)&BST_PUSHED));SendMessageA(buttons[0],BM_CLICK,0,0);CHECK(clicked==3);disabled++;SetWindowTextA(root,"Disabled drawing");return 0;}
    if(id==81){CHECK(EnableWindow(buttons[0],TRUE));CHECK(UpdateWindow(buttons[0]));SetWindowTextA(root,"Enabled drawing");return 0;}
    if(id==82){SendMessageA(buttons[0],BM_SETSTATE,TRUE,0);CHECK(SendMessageA(buttons[0],BM_GETSTATE,0,0)&BST_PUSHED);manual++;SetWindowTextA(root,"Manual pushed");return 0;}
    if(id==83){SendMessageA(buttons[0],BM_SETSTATE,FALSE,0);CHECK(!(SendMessageA(buttons[0],BM_GETSTATE,0,0)&BST_PUSHED));SetWindowTextA(root,"Manual released");return 0;}
    if(id==84){SendMessageA(buttons[0],BM_CLICK,0,0);CHECK(clicked==4);return 0;}
    if(id==85){CHECK(SetWindowPos(buttons[1],NULL,20,112,320,64,SWP_NOZORDER|SWP_NOACTIVATE));CHECK(UpdateWindow(buttons[1]));resize++;SetWindowTextA(root,"Wide resized");return 0;}
  }
  if(msg==WM_CLOSE){CHECK(clicked==4 && wide_clicked==1 && disabled==1 && manual==1 && resize==1 && (actions&7)==7 && (states&21)==21);}
  if(msg==WM_DESTROY){PostQuitMessage(0);return 0;}
  return DefWindowProcA(w,msg,wp,lp);
}
void start(void){
  HINSTANCE instance=GetModuleHandleA(NULL);WNDCLASSA cls={0};cls.hInstance=instance;cls.lpfnWndProc=proc;cls.lpszClassName="NativeOwnerButton";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);CHECK(RegisterClassA(&cls));
  root=CreateWindowA(cls.lpszClassName,"Owner buttons starting",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,440,430,NULL,NULL,instance,NULL);CHECK(root);
  font=CreateFontA(-18,0,0,0,FW_BOLD,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,0,0,"Arial");CHECK(font);
  buttons[0]=CreateWindowA("BUTTON","Draw button",WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_OWNERDRAW,20,30,280,56,root,(HMENU)70,instance,NULL);CHECK(buttons[0]);
  buttons[1]=CreateWindowW(L"BUTTON",L"Wide \x03bb",WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_OWNERDRAW,20,112,280,56,root,(HMENU)71,instance,NULL);CHECK(buttons[1]);
  for(unsigned i=0;i<2;i++){SendMessageA(buttons[i],WM_SETFONT,(WPARAM)font,TRUE);CHECK(UpdateWindow(buttons[i]));}
  const char *labels[6]={"Disable draw button","Enable draw button","Set pushed","Clear pushed","Native BM_CLICK","Resize wide button"};
  for(unsigned i=0;i<6;i++)CHECK(CreateWindowA("BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,20+(i%2)*196,210+(i/2)*42,188,32,root,(HMENU)(80+i),instance,NULL));
  SetWindowTextA(root,"Owner buttons ready");MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}
  CHECK(DeleteObject(font));CHECK(!IsWindow(buttons[0]) && !IsWindow(buttons[1]));ExitProcess((UINT)msg.wParam);
}
