/* MIT license: see README.md. Native common-control contract fixture. */
#include <windows.h>
#include <commctrl.h>
#define CHECK(x) do { if (!(x)) ExitProcess(__LINE__); } while (0)
static HWND tree;
static HTREEITEM root, session, terminal, keyboard, blocked;
static unsigned changes, deletions;
static LRESULT CALLBACK proc(HWND w,UINT msg,WPARAM wp,LPARAM lp) {
  if(msg==WM_NOTIFY) {
    NMTREEVIEWA *n=(NMTREEVIEWA*)lp;
    CHECK(n->hdr.hwndFrom==tree && n->hdr.idFrom==70 && wp==70);
    if(n->hdr.code==TVN_SELCHANGINGA) return n->itemNew.hItem==blocked;
    if(n->hdr.code==TVN_SELCHANGEDA) {
      CHECK(TreeView_GetSelection(tree)==n->itemNew.hItem);
      CHECK(n->itemNew.lParam==(n->itemNew.hItem==terminal?22:n->itemNew.hItem==keyboard?33:n->itemNew.hItem==session?11:0));
      changes++;
      if(n->itemNew.hItem==terminal) CHECK(SetWindowTextA(w,"Selected Terminal"));
      if(n->itemNew.hItem==keyboard) CHECK(SetWindowTextA(w,"Selected Keyboard"));
      if(n->itemNew.hItem==session) CHECK(SetWindowTextA(w,"Selected Session"));
    }
    if(n->hdr.code==TVN_DELETEITEMA) deletions++;
    return 0;
  }
  if(msg==WM_DESTROY){PostQuitMessage(0);return 0;}
  return DefWindowProcA(w,msg,wp,lp);
}
static HTREEITEM insert(HTREEITEM parent,char *text,LPARAM param) {
  TVINSERTSTRUCTA i={0};i.hParent=parent;i.hInsertAfter=TVI_LAST;
  i.item.mask=TVIF_TEXT|TVIF_PARAM;i.item.pszText=text;i.item.lParam=param;
  HTREEITEM h=TreeView_InsertItem(tree,&i);CHECK(h);return h;
}
void start(void) {
  INITCOMMONCONTROLSEX init={sizeof(init),ICC_TREEVIEW_CLASSES};CHECK(InitCommonControlsEx(&init));
  HINSTANCE instance=GetModuleHandleA(NULL);
  WNDCLASSA cls={0};cls.hInstance=instance;cls.lpfnWndProc=proc;cls.lpszClassName="NativeTree";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);CHECK(RegisterClassA(&cls));
  RECT r={0,0,300,230};CHECK(AdjustWindowRect(&r,WS_OVERLAPPEDWINDOW,FALSE));
  HWND w=CreateWindowA(cls.lpszClassName,"Native TreeView",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,r.right-r.left,r.bottom-r.top,NULL,NULL,instance,NULL);CHECK(w);
  tree=CreateWindowExA(WS_EX_CLIENTEDGE,WC_TREEVIEWA,"Categories",WS_CHILD|WS_VISIBLE|WS_TABSTOP|TVS_HASBUTTONS|TVS_HASLINES,10,10,280,200,w,(HMENU)70,instance,NULL);CHECK(tree);
  CHECK(SendMessageA(tree,TVM_SETUNICODEFORMAT,FALSE,0)==FALSE);
  root=insert(TVI_ROOT,"Categories",0);session=insert(root,"Session",11);
  terminal=insert(root,"Terminal",22);keyboard=insert(terminal,"Keyboard",33);blocked=insert(root,"Blocked",44);
  CHECK(TreeView_GetCount(tree)==5);CHECK(TreeView_GetRoot(tree)==root);
  CHECK(TreeView_GetChild(tree,root)==session);CHECK(TreeView_GetNextSibling(tree,session)==terminal);
  CHECK(TreeView_GetParent(tree,keyboard)==terminal);
  CHECK(TreeView_Expand(tree,root,TVE_EXPAND));
  CHECK(TreeView_SelectItem(tree,session));CHECK(changes==1);
  CHECK(!TreeView_SelectItem(tree,blocked));CHECK(TreeView_GetSelection(tree)==session);CHECK(changes==1);
  TVINSERTSTRUCTW wi={0};wi.hParent=root;wi.hInsertAfter=TVI_FIRST;wi.item.mask=TVIF_TEXT|TVIF_PARAM;wi.item.pszText=L"Unicode \x03bb";wi.item.lParam=55;
  HTREEITEM unicode=(HTREEITEM)SendMessageW(tree,TVM_INSERTITEMW,0,(LPARAM)&wi);CHECK(unicode);
  WCHAR out[32];TVITEMW item={0};item.mask=TVIF_TEXT|TVIF_PARAM;item.hItem=unicode;item.pszText=out;item.cchTextMax=32;
  CHECK(SendMessageW(tree,TVM_GETITEMW,0,(LPARAM)&item));CHECK(item.lParam==55 && out[8]==0x03bb && out[9]==0);
  CHECK(TreeView_DeleteItem(tree,unicode));CHECK(deletions==1);CHECK(TreeView_GetCount(tree)==5);
  CHECK(TreeView_GetChild(tree,root)==session);
  CHECK(SetFocus(tree)!=tree);
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}
  CHECK(changes>=3);ExitProcess((UINT)msg.wParam);
}
