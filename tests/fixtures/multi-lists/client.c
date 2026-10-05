/* Project-authored MIT PE32 fixture: native multiple/extended list selection. */
#include <windows.h>
#define CHECK(x) do {if(!(x))ExitProcess(1000+__LINE__);} while(0)
static HWND root,lists[3]; static HFONT font; static unsigned changes[3],deleted,states,measured;
static unsigned mask(HWND w) {unsigned value=0;int count=(int)SendMessageW(w,LB_GETCOUNT,0,0);for(int i=0;i<count;i++)if(SendMessageW(w,LB_GETSEL,i,0)>0)value|=1u<<i;return value;}
static void apis(HWND w) {
  int out[4]={-1,-1,-1,0xfeed};
  CHECK(SendMessageW(w,LB_GETSELCOUNT,0,0)==0);
  CHECK(SendMessageW(w,LB_SETCURSEL,2,0)==LB_ERR);
  CHECK(SendMessageW(w,LB_SETSEL,TRUE,1)==0 && SendMessageW(w,LB_SETSEL,TRUE,3)==0);
  CHECK(mask(w)==10 && SendMessageW(w,LB_GETCURSEL,0,0)==3);
  CHECK(SendMessageW(w,LB_GETSELITEMS,1,(LPARAM)out)==1 && out[0]==1 && out[1]==-1);
  CHECK(SendMessageW(w,LB_GETSELITEMS,3,(LPARAM)out)==2 && out[0]==1 && out[1]==3 && out[2]==-1 && out[3]==0xfeed);
  CHECK(SendMessageW(w,LB_SELITEMRANGE,TRUE,MAKELPARAM(4,2))==0 && mask(w)==30);
  CHECK(SendMessageW(w,LB_SELITEMRANGEEX,4,2)==0 && mask(w)==2);
  CHECK(SendMessageW(w,LB_SETSEL,FALSE,-1)==0 && mask(w)==0);
  CHECK(SendMessageW(w,LB_SETSEL,TRUE,99)==LB_ERR && SendMessageW(w,LB_GETSEL,99,0)==LB_ERR);
  CHECK(SendMessageW(w,LB_SETANCHORINDEX,2,0)==0 && SendMessageW(w,LB_GETANCHORINDEX,0,0)==2);
  CHECK(SendMessageW(w,LB_SETCARETINDEX,0,FALSE)==0 && SendMessageW(w,LB_GETCARETINDEX,0,0)==0);
  CHECK(SendMessageW(w,LB_SETANCHORINDEX,-1,0)==0);
}
static LRESULT CALLBACK proc(HWND w,UINT msg,WPARAM wp,LPARAM lp) {
  if(msg==WM_MEASUREITEM) {MEASUREITEMSTRUCT *m=(void*)lp; CHECK(m->CtlType==ODT_LISTBOX && m->CtlID==wp && wp>=71 && wp<=72);if(wp==71){CHECK(m->itemID==(UINT)-1);m->itemHeight=28;}else{CHECK(m->itemID<6 && ((WCHAR*)m->itemData)[0]=='R');m->itemHeight=28+(m->itemID%3)*8;}measured++;return TRUE;}
  if(msg==WM_DELETEITEM) {DELETEITEMSTRUCT *d=(void*)lp;CHECK(d->CtlType==ODT_LISTBOX && d->hwndItem==lists[wp-70] && d->itemID<6);deleted++;return TRUE;}
  if(msg==WM_CTLCOLORLISTBOX)return (LRESULT)GetStockObject(WHITE_BRUSH);
  if(msg==WM_DRAWITEM) {
    DRAWITEMSTRUCT *d=(void*)lp;CHECK(wp>=71 && wp<=72 && d->CtlType==ODT_LISTBOX && d->CtlID==wp && d->hwndItem==lists[wp-70]);
    if(d->itemID==(UINT)-1)return TRUE;
    CHECK(d->itemID<6 && !!(d->itemState&ODS_SELECTED)==!!SendMessageW(d->hwndItem,LB_GETSEL,d->itemID,0));
    CHECK(!!(d->itemState&ODS_DISABLED)==!IsWindowEnabled(d->hwndItem));CHECK(GetCurrentObject(d->hDC,OBJ_FONT)==font);
    RECT rect;CHECK(SendMessageW(d->hwndItem,LB_GETITEMRECT,d->itemID,(LPARAM)&rect)==0 && EqualRect(&rect,&d->rcItem));states|=d->itemState;
    COLORREF color=d->itemState&ODS_DISABLED?RGB(110,110,110):d->itemState&ODS_SELECTED?RGB(200,40,60):wp==71?RGB(24,100,200):RGB(30,150,80);
    HBRUSH brush=CreateSolidBrush(color); RECT large={-100,-100,2000,2000};CHECK(FillRect(d->hDC,&large,brush));CHECK(DeleteObject(brush));
    if(d->itemState&ODS_FOCUS){rect.top=rect.bottom-3;brush=CreateSolidBrush(RGB(255,210,20));CHECK(FillRect(d->hDC,&rect,brush));CHECK(DeleteObject(brush));}
    CHECK(SetBkMode(d->hDC,TRANSPARENT));SetTextColor(d->hDC,RGB(255,255,255));
    if(wp==72){WCHAR text[24];CHECK(SendMessageW(d->hwndItem,LB_GETTEXT,d->itemID,(LPARAM)text)==5);CHECK(TextOutW(d->hDC,28,d->rcItem.top+4,text,5));}
    else {CHECK(TextOutA(d->hDC,28,d->rcItem.top+4,"Native",6));}
    return TRUE;
  }
  if(msg==WM_COMMAND) {
    unsigned id=LOWORD(wp),code=HIWORD(wp);
    if(id>=70 && id<=72 && code==LBN_SELCHANGE){CHECK((HWND)lp==lists[id-70]);changes[id-70]++;SetWindowTextA(root,id==70?"Multiple changed":id==71?"Extended changed":"Variable changed");return 0;}
    if(code!=BN_CLICKED)return 0;
    if(id==80){CHECK(SendMessageW(lists[0],LB_INSERTSTRING,0,(LPARAM)L"New")==0 && mask(lists[0])==12);CHECK(SendMessageW(lists[0],LB_GETCARETINDEX,0,0)==2 && SendMessageW(lists[0],LB_GETANCHORINDEX,0,0)==2);SetWindowTextA(root,"Selection preserved on insert");return 0;}
    if(id==81){CHECK(SendMessageW(lists[0],LB_DELETESTRING,0,0)==6 && mask(lists[0])==6);SetWindowTextA(root,"Selection preserved on delete");return 0;}
    if(id==82){unsigned before=changes[1];CHECK(SendMessageW(lists[1],LB_SETSEL,TRUE,-1)==0 && mask(lists[1])==63 && changes[1]==before);SetWindowTextA(root,"Programmatic all selected");return 0;}
    if(id==83){CHECK(SendMessageW(lists[1],LB_SETSEL,FALSE,-1)==0);CHECK(SendMessageW(lists[1],LB_SETSEL,TRUE,1)==0 && SendMessageW(lists[1],LB_SETSEL,TRUE,2)==0);CHECK(SendMessageW(lists[1],LB_SETCARETINDEX,1,FALSE)==0 && SendMessageW(lists[1],LB_SETANCHORINDEX,2,0)==0);SetWindowTextA(root,"Native selection restored");return 0;}
    if(id==84){CHECK(!EnableWindow(lists[1],FALSE));CHECK(UpdateWindow(lists[1]));SetWindowTextA(root,"Multi disabled");return 0;}
    if(id==85){CHECK(EnableWindow(lists[1],TRUE));SetWindowTextA(root,"Multi enabled");return 0;}
    if(id==86){CHECK(mask(lists[2])==63 && SendMessageW(lists[2],LB_GETCARETINDEX,0,0)==5);CHECK(SendMessageW(lists[2],LB_RESETCONTENT,0,0)==0 && deleted==6);CHECK(SendMessageW(lists[2],LB_GETSELCOUNT,0,0)==0 && SendMessageW(lists[2],LB_GETCURSEL,0,0)==LB_ERR);SetWindowTextA(root,"Multi reset");return 0;}
  }
  if(msg==WM_CLOSE){CHECK(mask(lists[0])==6 && mask(lists[1])==6 && changes[0]>=4 && changes[1]>=4 && changes[2]>=3 && measured==7 && deleted==6 && (states&21)==21);}
  if(msg==WM_DESTROY){PostQuitMessage(0);return 0;}return DefWindowProcW(w,msg,wp,lp);
}
void start(void) {
  HINSTANCE instance=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.hInstance=instance;cls.lpfnWndProc=proc;cls.lpszClassName=L"NativeMultiLists";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);CHECK(RegisterClassW(&cls));
  root=CreateWindowW(cls.lpszClassName,L"Multi lists starting",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,700,410,NULL,NULL,instance,NULL);CHECK(root);
  font=CreateFontW(-16,0,0,0,FW_BOLD,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,0,0,L"Arial");CHECK(font);
  const WCHAR *names[3]={L"Multiple strings",L"Extended raw",L"Variable extended"};unsigned styles[3]={LBS_MULTIPLESEL,LBS_EXTENDEDSEL|LBS_OWNERDRAWFIXED,LBS_EXTENDEDSEL|LBS_OWNERDRAWVARIABLE|LBS_HASSTRINGS};
  for(unsigned i=0;i<3;i++){lists[i]=CreateWindowW(L"LISTBOX",names[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP|WS_BORDER|LBS_NOTIFY|styles[i],20+i*220,30,200,170,root,(HMENU)(70+i),instance,NULL);CHECK(lists[i]);SendMessageW(lists[i],WM_SETFONT,(WPARAM)font,TRUE);}
  const WCHAR *text[6]={L"Row \x03bb",L"Row \x03a9",L"Row \x20ac",L"Row D",L"Row E",L"Row F"};
  for(unsigned i=0;i<6;i++)for(unsigned j=0;j<3;j++)CHECK((unsigned)SendMessageW(lists[j],LB_ADDSTRING,0,j==1?(LPARAM)(0xfe000001u+i):(LPARAM)text[i])==i);
  for(unsigned i=0;i<3;i++){apis(lists[i]);CHECK(changes[i]==0);CHECK(UpdateWindow(lists[i]));}
  const char *labels[7]={"Insert before selection","Delete inserted item","Select all programmatically","Restore raw selection","Disable raw list","Enable raw list","Reset variable list"};
  for(unsigned i=0;i<7;i++)CHECK(CreateWindowA("BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,20+(i%3)*220,225+(i/3)*40,205,32,root,(HMENU)(80+i),instance,NULL));
  SetWindowTextA(root,"Multi lists ready");MSG msg;while(GetMessageW(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}CHECK(deleted==12 && DeleteObject(font));ExitProcess((UINT)msg.wParam);
}
