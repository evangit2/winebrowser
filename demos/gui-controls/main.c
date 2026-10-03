/* Copyright (c) 2026 WineBrowser contributors. MIT license: see LICENSE. */
#include <windows.h>
#include <commctrl.h>
static HWND tree, items, combo, status, canvas, priorities, pages, notes;
static HTREEITEM root, first;
static HFONT font;
static UINT drag_message;
static int drag_source=-1;
static const char *priority_names[]={"Paint window", "Handle input", "Update controls", "Save settings"};
static void say(const char *text) { SetWindowTextA(status,text); }
static void reset_priorities(void) {
  SendMessageA(priorities,LB_RESETCONTENT,0,0);
  for(int i=0;i<4;i++) {
    int index=(int)SendMessageA(priorities,LB_ADDSTRING,0,(LPARAM)priority_names[i]);
    SendMessageA(priorities,LB_SETITEMDATA,index,i+1);
  }
  SendMessageA(priorities,LB_SETCURSEL,0,0);
}
static LRESULT CALLBACK canvas_proc(HWND window,UINT message,WPARAM wp,LPARAM lp) {
  if(message==WM_COMMAND && LOWORD(wp)==51) {
    SetWindowLongA(window,GWL_USERDATA,!GetWindowLongA(window,GWL_USERDATA));
    InvalidateRect(window,NULL,TRUE);
    say("Nested button: native child window repainted with GDI.");return 0;
  }
  if(message==WM_LBUTTONDOWN) { say("Custom canvas: mouse input reached its native window procedure.");return 0; }
  if(message==WM_PAINT) {
    PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);if(!dc)return 0;
    RECT area;GetClientRect(window,&area);FillRect(dc,&area,GetSysColorBrush(COLOR_WINDOW));
    int swapped=GetWindowLongA(window,GWL_USERDATA)!=0;
    COLORREF colors[3]={RGB(28,110,210),RGB(30,160,100),RGB(230,140,30)};
    for(int i=0;i<3;i++) {
      RECT swatch={8+i*64,6,64+i*64,22};
      HBRUSH brush=CreateSolidBrush(colors[swapped?2-i:i]);FillRect(dc,&swatch,brush);DeleteObject(brush);
    }
    SelectObject(dc,font);SetBkMode(dc,TRANSPARENT);SetTextColor(dc,RGB(30,30,30));
    static const char label[]="Application-painted child window";
    TextOutA(dc,8,26,label,sizeof(label)-1);EndPaint(window,&ps);return 0;
  }
  return DefWindowProcA(window,message,wp,lp);
}
static void reset(HWND window) {
  SendMessageA(items,LB_SETCURSEL,0,0);SendMessageA(combo,CB_SETCURSEL,0,0);
  CheckDlgButton(window,30,BST_UNCHECKED);CheckRadioButton(window,31,32,31);
  SetWindowLongA(canvas,GWL_USERDATA,0);InvalidateRect(canvas,NULL,TRUE);
  reset_priorities();
  TabCtrl_SetCurSel(pages,0);ShowWindow(priorities,SW_SHOW);ShowWindow(notes,SW_HIDE);
  TreeView_SelectItem(tree,first);say("Choose a category, list item or option.");
}
static LRESULT CALLBACK proc(HWND window,UINT message,WPARAM wp,LPARAM lp) {
  if(message==WM_NOTIFY && ((NMHDR*)lp)->hwndFrom==pages) {
    if(((NMHDR*)lp)->code==TCN_SELCHANGE) {
      int page=TabCtrl_GetCurSel(pages);
      ShowWindow(priorities,page==0?SW_SHOW:SW_HIDE);ShowWindow(notes,page==1?SW_SHOW:SW_HIDE);
      say(page==0?"Drag priorities to reorder; Escape cancels.":"Notes: native edit text stays when you switch tabs.");
    }
    return 0;
  }
  if(message==drag_message) {
    DRAGLISTINFO *drag=(DRAGLISTINFO*)lp;
    if(drag->hWnd!=priorities)return 0;
    if(drag->uNotification==DL_BEGINDRAG) {
      drag_source=LBItemFromPt(priorities,drag->ptCursor,FALSE);
      return drag_source>=0;
    }
    if(drag->uNotification==DL_DRAGGING) {
      int target=LBItemFromPt(priorities,drag->ptCursor,TRUE);
      DrawInsert(window,priorities,target);
      return target>=0?DL_MOVECURSOR:DL_STOPCURSOR;
    }
    if(drag->uNotification==DL_DROPPED) {
      int target=LBItemFromPt(priorities,drag->ptCursor,FALSE);
      DrawInsert(window,priorities,-1);
      if(target>=0 && drag_source>=0) {
        char text[64];SendMessageA(priorities,LB_GETTEXT,drag_source,(LPARAM)text);
        LPARAM data=SendMessageA(priorities,LB_GETITEMDATA,drag_source,0);
        SendMessageA(priorities,LB_DELETESTRING,drag_source,0);
        if(drag_source<target)target--;
        target=(int)SendMessageA(priorities,LB_INSERTSTRING,target,(LPARAM)text);
        SendMessageA(priorities,LB_SETITEMDATA,target,data);
        SendMessageA(priorities,LB_SETCURSEL,target,0);
        say("Drag list: native callback reordered the item and preserved its data.");
      }
      drag_source=-1;return 0;
    }
    if(drag->uNotification==DL_CANCELDRAG) {
      DrawInsert(window,priorities,-1);drag_source=-1;
      say("Drag cancelled; priority order is unchanged.");return 0;
    }
  }
  if(message==WM_NOTIFY && ((NMHDR*)lp)->hwndFrom==tree && ((NMHDR*)lp)->code==TVN_SELCHANGEDA) {
    NMTREEVIEWA *n=(NMTREEVIEWA*)lp;
    say(n->itemNew.lParam==1?"TreeView: native item selection and WM_NOTIFY.":n->itemNew.lParam==2?"ListBox: strings, sorted insertion and selection.":"ComboBox: editable text and native selection notifications.");return 0;
  }
  if(message==WM_COMMAND) {
    UINT id=LOWORD(wp),code=HIWORD(wp);
    if(id==40 || id==100){reset(window);return 0;}
    if(id==101){DestroyWindow(window);return 0;}
    if(id==20 && code==LBN_SELCHANGE){char text[128];LRESULT index=SendMessageA(items,LB_GETCURSEL,0,0);if(index>=0){SendMessageA(items,LB_GETTEXT,index,(LPARAM)text);say(text);}return 0;}
    if(id==21 && (code==CBN_SELCHANGE||code==CBN_EDITCHANGE)){char text[128];GetWindowTextA(combo,text,sizeof(text));say(text);return 0;}
    if(id==30){say(IsDlgButtonChecked(window,30)==BST_CHECKED?"Checkbox is checked.":"Checkbox is unchecked.");return 0;}
    if(id==31||id==32){say(id==31?"First radio selected; its group remains exclusive.":"Second radio selected; its group remains exclusive.");return 0;}
  }
  if(message==WM_DESTROY){PostQuitMessage(0);return 0;}
  return DefWindowProcA(window,message,wp,lp);
}
static HWND child(HWND window,HINSTANCE instance,const char *className,const char *title,DWORD style,int x,int y,int width,int height,UINT id) {
  HWND result=CreateWindowExA((style&WS_BORDER)?WS_EX_CLIENTEDGE:0,className,title,WS_CHILD|WS_VISIBLE|WS_TABSTOP|(style&~WS_BORDER),x,y,width,height,window,(HMENU)id,instance,NULL);
  if(result)SendMessageA(result,WM_SETFONT,(WPARAM)font,TRUE);
  return result;
}
static HTREEITEM category(HTREEITEM parent,const char *text,LPARAM param) {
  TVINSERTSTRUCTA insert={0};insert.hParent=parent;insert.hInsertAfter=TVI_LAST;
  insert.item.mask=TVIF_TEXT|TVIF_PARAM;insert.item.pszText=(LPSTR)text;insert.item.lParam=param;
  return TreeView_InsertItem(tree,&insert);
}
void start(void) {
  HINSTANCE instance=GetModuleHandleA(NULL);
  INITCOMMONCONTROLSEX init={sizeof(init),ICC_TREEVIEW_CLASSES|ICC_TAB_CLASSES};InitCommonControlsEx(&init);
  WNDCLASSA cls={0};cls.hInstance=instance;cls.lpfnWndProc=proc;cls.lpszClassName="GuiControlsDemo";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);cls.hCursor=LoadCursorA(NULL,IDC_ARROW);
  if(!RegisterClassA(&cls))ExitProcess(1);
  WNDCLASSA custom={0};custom.hInstance=instance;custom.lpfnWndProc=canvas_proc;
  custom.lpszClassName="GuiPaintedChild";custom.hCursor=LoadCursorA(NULL,IDC_ARROW);
  if(!RegisterClassA(&custom))ExitProcess(1);
  font=CreateFontA(-14,0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,DEFAULT_QUALITY,DEFAULT_PITCH,"Arial");
  HMENU menu=CreateMenu(),popup=CreatePopupMenu();AppendMenuA(popup,MF_STRING,100,"&Reset");AppendMenuA(popup,MF_STRING,101,"E&xit");AppendMenuA(menu,MF_POPUP,(UINT_PTR)popup,"&Demo");
  drag_message=RegisterWindowMessageA(DRAGLISTMSGSTRING);
  RECT rect={0,0,500,438};AdjustWindowRect(&rect,WS_OVERLAPPEDWINDOW,TRUE);
  HWND window=CreateWindowA(cls.lpszClassName,"Native GUI controls",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,rect.right-rect.left,rect.bottom-rect.top,NULL,menu,instance,NULL);if(!window)ExitProcess(2);
  child(window,instance,"STATIC","Native Windows controls, running in your browser",SS_LEFTNOWORDWRAP,12,12,476,20,10);
  tree=child(window,instance,WC_TREEVIEWA,"Categories",WS_BORDER|TVS_HASBUTTONS|TVS_HASLINES|TVS_SHOWSELALWAYS,12,42,144,348,11);
  items=child(window,instance,"LISTBOX","Items",WS_BORDER|LBS_NOTIFY|LBS_SORT|LBS_HASSTRINGS|LBS_NOINTEGRALHEIGHT,172,42,152,108,20);
  combo=child(window,instance,"COMBOBOX","Value",WS_BORDER|CBS_DROPDOWN|CBS_AUTOHSCROLL,172,168,152,120,21);
  status=child(window,instance,"STATIC","",SS_LEFT,12,402,476,32,22);
  child(window,instance,"BUTTON","Enable option",BS_AUTOCHECKBOX,344,46,144,24,30);
  child(window,instance,"BUTTON","First radio",BS_AUTORADIOBUTTON|WS_GROUP,344,86,144,24,31);
  child(window,instance,"BUTTON","Second radio",BS_AUTORADIOBUTTON,344,116,144,24,32);
  child(window,instance,"BUTTON","Reset controls",BS_PUSHBUTTON,344,168,144,28,40);
  canvas=child(window,instance,custom.lpszClassName,"Custom canvas",WS_BORDER,172,210,316,50,50);
  child(canvas,instance,"BUTTON","Change",BS_PUSHBUTTON,224,8,80,28,51);
  pages=child(window,instance,WC_TABCONTROLA,"Priority pages",TCS_FIXEDWIDTH,172,270,316,30,60);
  priorities=child(window,instance,"LISTBOX","Priorities",WS_BORDER|LBS_NOTIFY|LBS_HASSTRINGS|LBS_NOINTEGRALHEIGHT,172,306,316,84,61);
  notes=child(window,instance,"EDIT","Type notes here. Switching tabs preserves your text.",WS_BORDER|ES_MULTILINE|ES_AUTOVSCROLL|ES_WANTRETURN,172,306,316,84,62);
  if(!tree||!items||!combo||!status||!canvas||!priorities||!pages||!notes)ExitProcess(3);
  TCITEMA tab={0};tab.mask=TCIF_TEXT;tab.pszText="Priorities";TabCtrl_InsertItem(pages,0,&tab);
  tab.pszText="Notes";TabCtrl_InsertItem(pages,1,&tab);
  if(!MakeDragList(priorities))ExitProcess(4);
  root=category(TVI_ROOT,"Controls",0);first=category(root,"Tree view",1);category(root,"List box",2);category(root,"Combo box",3);TreeView_Expand(tree,root,TVE_EXPAND);
  SendMessageA(items,LB_ADDSTRING,0,(LPARAM)"Alpha");SendMessageA(items,LB_ADDSTRING,0,(LPARAM)"Beta");SendMessageA(items,LB_ADDSTRING,0,(LPARAM)"Gamma");
  SendMessageA(combo,CB_ADDSTRING,0,(LPARAM)"Choice One");SendMessageA(combo,CB_ADDSTRING,0,(LPARAM)"Choice Two");
  reset(window);
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}DestroyMenu(menu);if(font)DeleteObject(font);ExitProcess((UINT)msg.wParam);
}
