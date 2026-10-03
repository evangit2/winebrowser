/* Original MIT native tab-control fixture; see README.md. */
#include <windows.h>
#include <commctrl.h>
#define CHECK(x) do {if(!(x))ExitProcess(__LINE__);} while(0)
static HWND tabs,pages[3];
static unsigned changes,vetoes,keys;
static int allow;
static void show_page(int selected) {
  for(int i=0;i<3;i++)ShowWindow(pages[i],selected==i?SW_SHOW:SW_HIDE);
}
static LRESULT CALLBACK proc(HWND root,UINT msg,WPARAM wp,LPARAM lp) {
  if(msg==WM_NOTIFY) {
    NMHDR *n=(NMHDR*)lp;CHECK(wp==70 && n->idFrom==70 && n->hwndFrom==tabs);
    if(n->code==TCN_SELCHANGING) {
      if(!allow){vetoes++;CHECK(TabCtrl_GetCurSel(tabs)==0);SetWindowTextA(root,"Change vetoed");return 1;}
      return 0;
    }
    if(n->code==TCN_SELCHANGE) {
      int index=TabCtrl_GetCurSel(tabs);CHECK(index>=0 && index<3);
      TCITEMA item={0};item.mask=TCIF_PARAM;CHECK(TabCtrl_GetItem(tabs,index,&item));CHECK(item.lParam==(index+1)*11);
      changes++;show_page(index);SetWindowTextA(root,index==0?"Selected General":index==1?"Selected Display":"Selected Advanced");return 0;
    }
    if(n->code==TCN_KEYDOWN) {NMTCKEYDOWN *key=(NMTCKEYDOWN*)lp;CHECK(key->wVKey==VK_LEFT || key->wVKey==VK_RIGHT);CHECK(key->flags!=0);keys++;return 0;}
    CHECK(FALSE);
  }
  if(msg==WM_COMMAND && LOWORD(wp)==90) {allow=1;SetWindowTextA(root,"Changes allowed");return 0;}
  if(msg==WM_CLOSE) {
    CHECK(vetoes==1 && changes>=4 && keys>=1);
    char text[32];CHECK(GetWindowTextA(pages[1],text,sizeof(text))==15);
    CHECK(text[0]=='B' && text[14]=='e');
  }
  if(msg==WM_DESTROY){PostQuitMessage(0);return 0;}
  return DefWindowProcA(root,msg,wp,lp);
}
void start(void) {
  INITCOMMONCONTROLSEX init={sizeof(init),ICC_TAB_CLASSES};CHECK(InitCommonControlsEx(&init));
  HINSTANCE instance=GetModuleHandleA(NULL);WNDCLASSA cls={0};cls.hInstance=instance;
  cls.lpfnWndProc=proc;cls.lpszClassName="NativeTabs";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);CHECK(RegisterClassA(&cls));
  RECT area={0,0,360,240};CHECK(AdjustWindowRect(&area,WS_OVERLAPPEDWINDOW,FALSE));
  HWND root=CreateWindowA(cls.lpszClassName,"Tabs ready",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,area.right-area.left,area.bottom-area.top,NULL,NULL,instance,NULL);CHECK(root);
  tabs=CreateWindowA(WC_TABCONTROLA,"Settings",WS_CHILD|WS_VISIBLE|WS_TABSTOP|TCS_FIXEDWIDTH,10,10,340,160,root,(HMENU)70,instance,NULL);CHECK(tabs);
  CHECK(TabCtrl_GetCurSel(tabs)==-1 && TabCtrl_GetItemCount(tabs)==0);
  const char *names[]={"General","Display","Advanced"};
  for(int i=0;i<3;i++){TCITEMA item={0};item.mask=TCIF_TEXT|TCIF_PARAM;item.pszText=(LPSTR)names[i];item.lParam=(i+1)*11;CHECK(TabCtrl_InsertItem(tabs,i,&item)==i);}
  CHECK(TabCtrl_GetCurSel(tabs)==0 && TabCtrl_GetCurFocus(tabs)==0);
  CHECK(TabCtrl_SetCurSel(tabs,1)==0);CHECK(changes==0 && TabCtrl_GetCurSel(tabs)==1);
  CHECK(TabCtrl_SetCurSel(tabs,0)==1);CHECK(TabCtrl_SetCurSel(tabs,99)==-1 && TabCtrl_GetCurSel(tabs)==0);
  TCITEMW item={0};item.mask=TCIF_TEXT|TCIF_PARAM;item.pszText=L"Unicode \x03bb";item.lParam=44;
  CHECK(SendMessageW(tabs,TCM_INSERTITEMW,3,(LPARAM)&item)==3);
  WCHAR out[10];item.pszText=out;item.cchTextMax=10;CHECK(SendMessageW(tabs,TCM_GETITEMW,3,(LPARAM)&item));CHECK(out[8]==0x03bb && out[9]==0 && item.lParam==44);
  CHECK(TabCtrl_DeleteItem(tabs,3));CHECK(TabCtrl_GetItemCount(tabs)==3);
  CHECK(TabCtrl_SetItemSize(tabs,100,30)!=0);
  RECT r;CHECK(TabCtrl_GetItemRect(tabs,1,&r));CHECK(r.right-r.left==100 && r.bottom-r.top==30);
  TCHITTESTINFO hit={0};hit.pt.x=r.left+2;hit.pt.y=r.top+2;CHECK(TabCtrl_HitTest(tabs,&hit)==1 && hit.flags&TCHT_ONITEM);
  RECT page={0,0,340,160};TabCtrl_AdjustRect(tabs,FALSE,&page);CHECK(page.left>0 && page.top>=30 && page.right<340 && page.bottom<160);
  TabCtrl_AdjustRect(tabs,TRUE,&page);CHECK(page.left==0 && page.top==0 && page.right==340 && page.bottom==160);
  for(int i=0;i<3;i++){pages[i]=CreateWindowExA(WS_EX_CLIENTEDGE,"EDIT",names[i],WS_CHILD|WS_TABSTOP|ES_AUTOHSCROLL,20,60,310,28,root,(HMENU)(80+i),instance,NULL);CHECK(pages[i]);}
  CHECK(SetWindowPos(tabs,HWND_BOTTOM,0,0,0,0,SWP_NOMOVE|SWP_NOSIZE|SWP_NOACTIVATE));
  show_page(0);
  CHECK(CreateWindowA("BUTTON","Allow changes",WS_CHILD|WS_VISIBLE|WS_TABSTOP,20,190,160,28,root,(HMENU)90,instance,NULL));
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}
  CHECK(!IsWindow(tabs));ExitProcess((UINT)msg.wParam);
}
