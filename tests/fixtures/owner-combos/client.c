/* Project-authored MIT fixture: owner-drawn combo text, popup and real children. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(1000+__LINE__); } while(0)
static HWND root,combos[3]; static COMBOBOXINFO info[3]; static HFONT font;
static WNDPROC old_list; static unsigned measured,compared,deleted,actions,states,accepted,cancelled,opened,closed,edits,subclassed;
static unsigned data[3]={0xfe000003u,0xfe000001u,0xfe000002u};
static LRESULT CALLBACK listproc(HWND w,UINT msg,WPARAM wp,LPARAM lp) {
  if(msg==LB_GETCOUNT)subclassed++;
  return CallWindowProcA(old_list,w,msg,wp,lp);
}
static LRESULT CALLBACK proc(HWND w,UINT msg,WPARAM wp,LPARAM lp) {
  if(msg==WM_MEASUREITEM) {
    MEASUREITEMSTRUCT *m=(MEASUREITEMSTRUCT*)lp; unsigned i=(unsigned)wp-70;
    CHECK(m->CtlType==ODT_COMBOBOX && m->CtlID==wp && i<3 && m->itemWidth>0);
    if(m->itemID==(UINT)-1) { CHECK(m->itemData==0); m->itemHeight=24; }
    else if(i==1) { CHECK(m->itemID<3 && ((WCHAR*)m->itemData)[0]=='W'); m->itemHeight=32+m->itemID*8; }
    else { CHECK(m->itemID==0 && m->itemData==0); m->itemHeight=i==0?32:30; }
    measured++; return TRUE;
  }
  if(msg==WM_COMPAREITEM) {
    COMPAREITEMSTRUCT *c=(COMPAREITEMSTRUCT*)lp;
    CHECK(c->CtlType==ODT_COMBOBOX && c->CtlID==70 && c->hwndItem==combos[0] && c->itemID2==(UINT)-1);
    compared++; return c->itemData1<c->itemData2?-1:c->itemData1>c->itemData2?1:0;
  }
  if(msg==WM_DELETEITEM) {
    DELETEITEMSTRUCT *d=(DELETEITEMSTRUCT*)lp;
    CHECK(d->CtlType==ODT_COMBOBOX && d->CtlID==wp && d->hwndItem==combos[wp-70] && d->itemID<3);
    deleted++; return TRUE;
  }
  if(msg==WM_CTLCOLORLISTBOX || msg==WM_CTLCOLORSTATIC) { SetBkMode((HDC)wp,TRANSPARENT); return (LRESULT)GetStockObject(WHITE_BRUSH); }
  if(msg==WM_DRAWITEM) {
    DRAWITEMSTRUCT *d=(DRAWITEMSTRUCT*)lp; unsigned i=(unsigned)wp-70;
    CHECK(d->CtlType==ODT_COMBOBOX && d->CtlID==wp && i<3 && d->hwndItem==combos[i]);
    CHECK(d->itemAction==ODA_DRAWENTIRE || d->itemAction==ODA_SELECT || d->itemAction==ODA_FOCUS);
    if(d->itemID==(UINT)-1) return TRUE;
    CHECK(d->itemID<3 && d->itemData==(ULONG_PTR)SendMessageW(combos[i],CB_GETITEMDATA,d->itemID,0));
    CHECK(GetCurrentObject(d->hDC,OBJ_FONT)==font);
    RECT clip; CHECK(GetClipBox(d->hDC,&clip)==SIMPLEREGION && clip.left>=0 && clip.top>=0);
    if(d->itemState&ODS_COMBOBOXEDIT) {
      CHECK(i==0); RECT rect=info[i].rcItem; InflateRect(&rect,-1,-1);
      CHECK(EqualRect(&rect,&d->rcItem));
    } else {
      RECT rect; CHECK(SendMessageW(info[i].hwndList,LB_GETITEMRECT,d->itemID,(LPARAM)&rect)==0);
      CHECK(EqualRect(&rect,&d->rcItem));
    }
    actions|=d->itemAction; states|=d->itemState;
    COLORREF color=d->itemState&ODS_DISABLED?RGB(110,110,110):d->itemState&ODS_SELECTED?RGB(200,40,60):i==0?RGB(24,100,200):i==1?RGB(30,150,80):RGB(200,110,20);
    HBRUSH brush=CreateSolidBrush(color); RECT all={-100,-100,1000,1000}; CHECK(FillRect(d->hDC,&all,brush)); CHECK(DeleteObject(brush));
    CHECK(SetBkMode(d->hDC,TRANSPARENT)); CHECK(SetTextColor(d->hDC,RGB(255,255,255))!=CLR_INVALID);
    if(i) { WCHAR text[24]; CHECK(SendMessageW(combos[i],CB_GETLBTEXT,d->itemID,(LPARAM)text)==6); CHECK(TextOutW(d->hDC,30,d->rcItem.top+4,text,6)); }
    else CHECK(TextOutA(d->hDC,30,d->rcItem.top+4,"Native color",12));
    if(d->itemState&ODS_FOCUS) { RECT rect=d->rcItem; rect.top=rect.bottom-3; brush=CreateSolidBrush(RGB(255,210,20)); CHECK(FillRect(d->hDC,&rect,brush)); CHECK(DeleteObject(brush)); }
    return TRUE;
  }
  if(msg==WM_COMMAND) {
    unsigned id=LOWORD(wp),code=HIWORD(wp),i=id-70;
    if(i<3) {
      CHECK((HWND)lp==combos[i]);
      if(code==CBN_DROPDOWN) { CHECK(!SendMessageW(combos[i],CB_GETDROPPEDSTATE,0,0)); opened++; }
      if(code==CBN_CLOSEUP) { CHECK(!SendMessageW(combos[i],CB_GETDROPPEDSTATE,0,0)); closed++; }
      if(code==CBN_SELENDOK) { CHECK(SendMessageW(combos[i],CB_GETDROPPEDSTATE,0,0)); accepted++; SetWindowTextA(root,i==0?"Raw accepted":"Variable accepted"); }
      if(code==CBN_SELENDCANCEL) { cancelled++; SetWindowTextA(root,"Popup cancelled"); }
      if(code==CBN_SELCHANGE) { CHECK(SendMessageW(combos[i],CB_GETCURSEL,0,0)!=CB_ERR); SetWindowTextA(root,i==0?"Raw selection":i==1?"Variable selection":"Simple selection"); }
      if(code==CBN_EDITCHANGE) { CHECK(i>0 && SendMessageW(combos[i],CB_GETCURSEL,0,0)==CB_ERR); edits++; SetWindowTextA(root,"Editable changed"); }
      return 0;
    }
    if(code!=BN_CLICKED)return 0;
    if(id==80) { CHECK(SendMessageA(combos[0],CB_SHOWDROPDOWN,TRUE,0)); CHECK(IsWindowVisible(info[0].hwndList)); SetWindowTextA(root,"Raw popup visible"); return 0; }
    if(id==81) { CHECK(!EnableWindow(combos[0],FALSE)); CHECK(UpdateWindow(combos[0])); SetWindowTextA(root,"Combo disabled"); return 0; }
    if(id==82) { CHECK(EnableWindow(combos[0],TRUE)); CHECK(UpdateWindow(combos[0])); SetWindowTextA(root,"Combo enabled"); return 0; }
    if(id==83) { CHECK(SendMessageW(combos[1],CB_SETITEMHEIGHT,(WPARAM)-1,30)==30); CHECK(SendMessageW(combos[1],CB_GETITEMHEIGHT,(WPARAM)-1,0)==32); CHECK(SendMessageW(combos[1],CB_SETITEMHEIGHT,1,44)==0); CHECK(GetComboBoxInfo(combos[1],&info[1])); SetWindowTextA(root,"Combo resized"); return 0; }
    if(id==84) { CHECK(SendMessageA(combos[0],CB_RESETCONTENT,0,0)); CHECK(deleted==3); SetWindowTextA(root,"Raw reset"); return 0; }
    if(id==85) { CHECK(DestroyWindow(combos[2])); CHECK(deleted==6 && !IsWindow(info[2].hwndItem) && !IsWindow(info[2].hwndList)); SetWindowTextA(root,"Simple destroyed"); return 0; }
    if(id==86) { unsigned before=edits; CHECK(SetWindowTextW(combos[1],L"Program \x03bb")); WCHAR text[24]; CHECK(GetWindowTextW(combos[1],text,24)==9 && text[8]==0x03bb); CHECK(edits==before); SetWindowTextA(root,"Native edit setter"); return 0; }
  }
  if(msg==WM_CLOSE) { CHECK(measured==8 && compared>0 && opened>=3 && closed==opened && accepted>=2 && cancelled>=1 && edits>0 && subclassed>0 && deleted==6 && (states&0x1015)==0x1015); }
  if(msg==WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcW(w,msg,wp,lp);
}
void start(void) {
  HINSTANCE instance=GetModuleHandleW(NULL); WNDCLASSW cls={0}; cls.hInstance=instance; cls.lpfnWndProc=proc; cls.lpszClassName=L"NativeOwnerCombos"; cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1); CHECK(RegisterClassW(&cls));
  RECT rect={0,0,760,380}; CHECK(AdjustWindowRect(&rect,WS_OVERLAPPEDWINDOW,FALSE));
  root=CreateWindowW(cls.lpszClassName,L"Owner combos starting",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,rect.right-rect.left,rect.bottom-rect.top,NULL,NULL,instance,NULL); CHECK(root);
  font=CreateFontW(-16,0,0,0,FW_BOLD,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,0,0,L"Arial"); CHECK(font);
  combos[0]=CreateWindowExA(WS_EX_CLIENTEDGE,"COMBOBOX","Raw colors",WS_CHILD|WS_VISIBLE|WS_TABSTOP|CBS_DROPDOWNLIST|CBS_OWNERDRAWFIXED|CBS_SORT,20,300,220,220,root,(HMENU)70,instance,NULL); CHECK(combos[0]);
  combos[1]=CreateWindowExW(WS_EX_CLIENTEDGE,L"COMBOBOX",L"Editable colors",WS_CHILD|WS_VISIBLE|WS_TABSTOP|CBS_DROPDOWN|CBS_OWNERDRAWVARIABLE|CBS_HASSTRINGS,280,30,220,220,root,(HMENU)71,instance,NULL); CHECK(combos[1]);
  combos[2]=CreateWindowExW(WS_EX_CLIENTEDGE,L"COMBOBOX",L"Simple colors",WS_CHILD|WS_VISIBLE|WS_TABSTOP|CBS_SIMPLE|CBS_OWNERDRAWFIXED|CBS_HASSTRINGS,540,30,200,180,root,(HMENU)72,instance,NULL); CHECK(combos[2]);
  for(unsigned i=0;i<3;i++) {
    SendMessageW(combos[i],WM_SETFONT,(WPARAM)font,TRUE); info[i].cbSize=sizeof(info[i]); CHECK(GetComboBoxInfo(combos[i],&info[i]));
    CHECK(info[i].hwndCombo==combos[i] && IsWindow(info[i].hwndList) && GetParent(info[i].hwndList)==combos[i]);
    CHECK(i==0?info[i].hwndItem==NULL:IsWindow(info[i].hwndItem));
    WCHAR name[24]; CHECK(GetClassNameW(info[i].hwndList,name,24)==9 && name[0]=='C' && name[5]=='L');
    CHECK(SendMessageW(combos[i],CB_GETITEMHEIGHT,(WPARAM)-1,0)==26);
  }
  for(unsigned i=0;i<3;i++)CHECK(SendMessageA(combos[0],CB_ADDSTRING,0,data[i])!=CB_ERR);
  for(unsigned i=1;i<3;i++) { CHECK(SendMessageW(combos[i],CB_ADDSTRING,0,(LPARAM)L"Wide \x03bb")==0); CHECK(SendMessageW(combos[i],CB_ADDSTRING,0,(LPARAM)L"Wide \x03a9")==1); CHECK(SendMessageW(combos[i],CB_ADDSTRING,0,(LPARAM)L"Wide \x20ac")==2); }
  unsigned out[2]={0,0xfeed}; CHECK(SendMessageA(combos[0],CB_GETLBTEXT,0,(LPARAM)out)==4 && out[0]==0xfe000001u && out[1]==0xfeed);
  old_list=(WNDPROC)SetWindowLongPtrA(info[0].hwndList,GWLP_WNDPROC,(LONG_PTR)listproc); CHECK(old_list); CHECK(SendMessageA(combos[0],CB_GETCOUNT,0,0)==3 && subclassed==1);
  for(unsigned i=0;i<3;i++) { CHECK(SendMessageW(combos[i],CB_SETCURSEL,0,0)==0); CHECK(UpdateWindow(combos[i])); CHECK(UpdateWindow(info[i].hwndList)); }
  const char *labels[7]={"Show raw popup","Disable combo","Enable combo","Resize editable combo","Reset raw combo","Destroy simple combo","Set native edit text"};
  for(unsigned i=0;i<7;i++)CHECK(CreateWindowA("BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,20+(i==6?1:i%3)*240,210+(i/3)*42,220,34,root,(HMENU)(80+i),instance,NULL));
  SetWindowTextA(root,"Owner combos ready"); MSG msg;
  while(GetMessageW(&msg,NULL,0,0)>0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  CHECK(deleted==9 && DeleteObject(font)); ExitProcess((UINT)msg.wParam);
}
