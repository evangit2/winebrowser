/* Project-authored MIT fixture: native fixed/variable and raw/string lists. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(1000+__LINE__); } while(0)
static HWND root,lists[3]; static HFONT font;
static unsigned measured,compared,deleted,actions,states,selected;
static unsigned raw[3]={0xde000003u,0xde000001u,0xde000002u};
static LRESULT CALLBACK proc(HWND w,UINT msg,WPARAM wp,LPARAM lp) {
  if(msg==WM_MEASUREITEM) {
    MEASUREITEMSTRUCT *m=(MEASUREITEMSTRUCT*)lp;
    CHECK(m->CtlType==ODT_LISTBOX && m->CtlID==wp && wp>=70 && wp<=72);
    if(wp==71) { CHECK(m->itemID<3 && m->itemData==raw[m->itemID]); m->itemHeight=24+(m->itemData&3)*8; }
    else { CHECK(m->itemID==(UINT)-1 && m->itemWidth==0 && m->itemData==0); m->itemHeight=28; }
    measured++; return TRUE;
  }
  if(msg==WM_COMPAREITEM) {
    COMPAREITEMSTRUCT *c=(COMPAREITEMSTRUCT*)lp;
    CHECK(wp==70 && c->CtlID==70 && c->CtlType==ODT_LISTBOX && c->hwndItem==lists[0]);
    CHECK(c->itemID2==(UINT)-1 && c->itemID1<3 && c->dwLocaleId==0x409);
    compared++; return c->itemData1<c->itemData2?-1:c->itemData1>c->itemData2?1:0;
  }
  if(msg==WM_DELETEITEM) {
    DELETEITEMSTRUCT *d=(DELETEITEMSTRUCT*)lp;
    CHECK(d->CtlType==ODT_LISTBOX && d->CtlID==wp && d->hwndItem==lists[wp-70]);
    CHECK(d->itemID<3 && (wp==72 || (d->itemData&0xffff0000)==0xde000000)); deleted++; return TRUE;
  }
  if(msg==WM_CTLCOLORLISTBOX) { SetBkMode((HDC)wp,TRANSPARENT); return (LRESULT)GetStockObject(WHITE_BRUSH); }
  if(msg==WM_DRAWITEM) {
    DRAWITEMSTRUCT *d=(DRAWITEMSTRUCT*)lp; unsigned i=(unsigned)wp-70;
    CHECK(d->CtlType==ODT_LISTBOX && d->CtlID==wp && i<3 && d->hwndItem==lists[i]);
    CHECK(d->itemAction==ODA_DRAWENTIRE || d->itemAction==ODA_SELECT || d->itemAction==ODA_FOCUS);
    if(d->itemID==(UINT)-1)return TRUE;
    CHECK(d->itemData==(ULONG_PTR)SendMessageA(d->hwndItem,LB_GETITEMDATA,d->itemID,0));
    CHECK(!!(d->itemState&ODS_SELECTED)==((UINT)SendMessageA(d->hwndItem,LB_GETCURSEL,0,0)==d->itemID));
    CHECK(!!(d->itemState&ODS_DISABLED)==!IsWindowEnabled(d->hwndItem));
    CHECK(GetCurrentObject(d->hDC,OBJ_FONT)==font);
    RECT rect,client,clip; CHECK(GetClientRect(d->hwndItem,&client));
    CHECK(SendMessageA(d->hwndItem,LB_GETITEMRECT,d->itemID,(LPARAM)&rect)==0);
    CHECK(d->rcItem.left==rect.left && d->rcItem.top==rect.top && d->rcItem.right==rect.right && d->rcItem.bottom==rect.bottom);
    CHECK(GetClipBox(d->hDC,&clip)==SIMPLEREGION && clip.left==0 && clip.right==client.right && clip.top>=0 && clip.bottom<=client.bottom);
    actions|=d->itemAction; states|=d->itemState;
    COLORREF color=d->itemState&ODS_DISABLED?RGB(110,110,110):d->itemState&ODS_SELECTED?RGB(200,40,60):i==0?RGB(24,100,200):i==1?RGB(30,150,80):RGB(200,110,20);
    HBRUSH brush=CreateSolidBrush(color); CHECK(brush);
    RECT oversized={-100,-100,1000,1000}; CHECK(FillRect(d->hDC,&oversized,brush)); CHECK(DeleteObject(brush));
    if(d->itemState&ODS_FOCUS) { rect.top=rect.bottom-4; brush=CreateSolidBrush(RGB(255,210,20)); CHECK(FillRect(d->hDC,&rect,brush)); CHECK(DeleteObject(brush)); }
    CHECK(SetTextColor(d->hDC,RGB(255,255,255))!=CLR_INVALID); CHECK(SetBkMode(d->hDC,TRANSPARENT));
    if(i==2) { WCHAR text[40]; CHECK(SendMessageW(d->hwndItem,LB_GETTEXT,d->itemID,(LPARAM)text)!=LB_ERR); CHECK(TextOutW(d->hDC,30,d->rcItem.top+4,text,6)); }
    else CHECK(TextOutA(d->hDC,30,d->rcItem.top+4,"Native",6));
    return TRUE;
  }
  if(msg==WM_COMMAND) {
    unsigned id=LOWORD(wp), code=HIWORD(wp);
    if(id>=70 && id<=72 && code==LBN_SELCHANGE) { selected++; SetWindowTextA(root,id==70?"Fixed selection":id==71?"Variable selection":"Unicode selection"); return 0; }
    if(code!=BN_CLICKED)return 0;
    if(id==80) { CHECK(!EnableWindow(lists[0],FALSE)); CHECK(UpdateWindow(lists[0])); SetWindowTextA(root,"List disabled"); return 0; }
    if(id==81) { CHECK(EnableWindow(lists[0],TRUE)); CHECK(UpdateWindow(lists[0])); SetWindowTextA(root,"List enabled"); return 0; }
    if(id==82) { CHECK(SendMessageA(lists[1],LB_SETTOPINDEX,1,0)==0); CHECK(UpdateWindow(lists[1])); SetWindowTextA(root,"Variable scrolled"); return 0; }
    if(id==83) { CHECK(SendMessageA(lists[0],LB_DELETESTRING,1,0)==2); CHECK(deleted==1); SetWindowTextA(root,"Item deleted"); return 0; }
    if(id==84) { CHECK(SendMessageA(lists[1],LB_RESETCONTENT,0,0)==0); CHECK(deleted==4); SetWindowTextA(root,"List reset"); return 0; }
    if(id==85) { CHECK(SetWindowPos(lists[2],NULL,420,30,200,180,SWP_NOZORDER|SWP_NOACTIVATE)); CHECK(UpdateWindow(lists[2])); SetWindowTextA(root,"List resized"); return 0; }
  }
  if(msg==WM_CLOSE) { CHECK(measured==5 && compared>0 && deleted==4 && selected>=3 && (actions&7)==7 && (states&21)==21); }
  if(msg==WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcA(w,msg,wp,lp);
}
void start(void) {
  HINSTANCE instance=GetModuleHandleA(NULL); WNDCLASSA cls={0}; cls.hInstance=instance; cls.lpfnWndProc=proc; cls.lpszClassName="NativeOwnerLists";
  CHECK(RegisterClassA(&cls)); root=CreateWindowA(cls.lpszClassName,"Owner lists starting",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,680,390,NULL,NULL,instance,NULL); CHECK(root);
  font=CreateFontA(-16,0,0,0,FW_BOLD,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,0,0,"Arial"); CHECK(font);
  lists[0]=CreateWindowA("LISTBOX","Fixed data",WS_CHILD|WS_VISIBLE|WS_TABSTOP|WS_BORDER|LBS_NOTIFY|LBS_SORT|LBS_OWNERDRAWFIXED,20,30,180,160,root,(HMENU)70,instance,NULL); CHECK(lists[0]);
  lists[1]=CreateWindowA("LISTBOX","Variable data",WS_CHILD|WS_VISIBLE|WS_TABSTOP|WS_BORDER|LBS_NOTIFY|LBS_OWNERDRAWVARIABLE,220,30,180,100,root,(HMENU)71,instance,NULL); CHECK(lists[1]);
  lists[2]=CreateWindowW(L"LISTBOX",L"Unicode strings",WS_CHILD|WS_VISIBLE|WS_TABSTOP|WS_BORDER|LBS_NOTIFY|LBS_OWNERDRAWFIXED|LBS_HASSTRINGS,420,30,180,160,root,(HMENU)72,instance,NULL); CHECK(lists[2]);
  for(unsigned i=0;i<3;i++)SendMessageA(lists[i],WM_SETFONT,(WPARAM)font,TRUE);
  for(unsigned i=0;i<3;i++) { CHECK(SendMessageA(lists[0],LB_ADDSTRING,0,raw[i])!=LB_ERR); CHECK((unsigned)SendMessageA(lists[1],LB_ADDSTRING,0,raw[i])==i); }
  CHECK(SendMessageW(lists[2],LB_ADDSTRING,0,(LPARAM)L"Wide \x03bb")==0);
  CHECK(SendMessageW(lists[2],LB_ADDSTRING,0,(LPARAM)L"Wide \x03a9")==1);
  CHECK(SendMessageW(lists[2],LB_ADDSTRING,0,(LPARAM)L"Wide \x20ac")==2);
  unsigned data[2]={0,0xfeed}; CHECK(SendMessageA(lists[0],LB_GETTEXTLEN,0,0)==4); CHECK(SendMessageA(lists[0],LB_GETTEXT,0,(LPARAM)data)==4 && data[0]==0xde000001u && data[1]==0xfeed);
  for(unsigned i=0;i<3;i++)CHECK((unsigned)SendMessageA(lists[0],LB_GETITEMDATA,i,0)==0xde000001u+i);
  CHECK(SendMessageA(lists[1],LB_GETITEMHEIGHT,0,0)==48 && SendMessageA(lists[1],LB_GETITEMHEIGHT,1,0)==32 && SendMessageA(lists[1],LB_GETITEMHEIGHT,2,0)==40);
  CHECK(SendMessageA(lists[1],LB_SETITEMHEIGHT,1,36)==0); CHECK(SendMessageA(lists[1],LB_GETITEMHEIGHT,1,0)==36);
  CHECK(SendMessageA(lists[0],LB_FINDSTRINGEXACT,(WPARAM)-1,0xde000002u)==1);
  for(unsigned i=0;i<3;i++)CHECK(UpdateWindow(lists[i]));
  const char *labels[6]={"Disable fixed list","Enable fixed list","Scroll variable list","Delete fixed item","Reset variable list","Resize Unicode list"};
  for(unsigned i=0;i<6;i++)CHECK(CreateWindowA("BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,20+(i%3)*200,240+(i/3)*42,188,32,root,(HMENU)(80+i),instance,NULL));
  SetWindowTextA(root,"Owner lists ready"); MSG msg;
  while(GetMessageA(&msg,NULL,0,0)>0) { TranslateMessage(&msg); DispatchMessageA(&msg); }
  CHECK(deleted==9 && DeleteObject(font)); ExitProcess((UINT)msg.wParam);
}
