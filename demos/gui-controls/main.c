/* Copyright (c) 2026 WineBrowser contributors. MIT license: see LICENSE. */
#include <windows.h>
#include <commctrl.h>
#include <commdlg.h>
static HWND tree, items, combo, status, canvas, priorities, pages, notes;
static HWND toolbar, main_owner;
static HTREEITEM root, first;
static HFONT font;
static COLORREF font_color=RGB(30,30,30);
static HMENU notes_menu;
static HWND search_dialog;
static UINT search_message;
static BOOL notes_locked;
static FINDREPLACEA search;
static char search_text[128]="notes",replace_text[128]="text";
static UINT drag_message;
static int drag_source=-1;
static const char *priority_names[]={"Paint window", "Handle input", "Update controls", "Save settings"};
static void say(const char *text) { SendMessageA(status,SB_SETTEXTA,SBT_NOBORDERS,(LPARAM)text); }
static void note_mode(HWND window,BOOL locked) {
  notes_locked=locked;
  if(toolbar)SendMessageA(toolbar,TB_CHECKBUTTON,115,MAKELONG(locked,0));
  SendMessageA(notes,EM_SETREADONLY,locked,0);
  CheckMenuRadioItem(notes_menu,110,111,locked?111:110,MF_BYCOMMAND);
  MENUITEMINFOA info={0};info.cbSize=sizeof(info);info.fMask=MIIM_STRING;
  info.dwTypeData=locked?"&Notes (read-only)":"&Notes (editable)";
  SetMenuItemInfoA(GetMenu(window),1,TRUE,&info);
  DrawMenuBar(window);
}
static INT_PTR CALLBACK settings_proc(HWND window,UINT message,WPARAM wp,LPARAM lp){
  if(message==WM_INITDIALOG){
    PROPSHEETPAGEA *page=(PROPSHEETPAGEA*)lp;
    SetWindowLongA(window,DWL_USER,page->lParam);
    CheckDlgButton(window,10,page->lParam==1?notes_locked:GetWindowLongA(canvas,GWL_USERDATA)!=0);
    return TRUE;
  }
  if(message==WM_COMMAND&&LOWORD(wp)==10){PropSheet_Changed(GetParent(window),window);return TRUE;}
  if(message==WM_NOTIFY&&((NMHDR*)lp)->code==PSN_APPLY){
    BOOL checked=IsDlgButtonChecked(window,10)==BST_CHECKED;
    if(GetWindowLongA(window,DWL_USER)==1)note_mode(main_owner,checked);
    else{SetWindowLongA(canvas,GWL_USERDATA,checked);InvalidateRect(canvas,NULL,TRUE);}
    SetWindowLongA(window,DWL_MSGRESULT,PSNRET_NOERROR);return TRUE;
  }
  return FALSE;
}
static void open_settings(HWND owner){
  PROPSHEETPAGEA settings[2]={0};PROPSHEETHEADERA header={0};
  for(int i=0;i<2;i++){
    settings[i].dwSize=sizeof(settings[i]);settings[i].hInstance=GetModuleHandleA(NULL);
    settings[i].pszTemplate=MAKEINTRESOURCEA(201+i);settings[i].pfnDlgProc=settings_proc;settings[i].lParam=i+1;
  }
  header.dwSize=sizeof(header);header.dwFlags=PSH_PROPSHEETPAGE;
  header.hwndParent=owner;header.pszCaption="GUI settings";header.nPages=2;header.ppsp=settings;
  INT_PTR result=PropertySheetA(&header);
  say(result>0?"Settings saved: notes and native canvas updated.":result==0?"Settings cancelled; applied changes are preserved.":"Settings could not open.");
}
static unsigned text_length(const char *text){unsigned n=0;while(text[n])n++;return n;}
static BOOL word_char(char c){return (c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='_';}
static BOOL match_at(const char *text,unsigned n,unsigned at,const char *query,unsigned q,DWORD flags){
  if(!q||at+q>n)return FALSE;
  for(unsigned i=0;i<q;i++){
    char a=text[at+i],b=query[i];
    if(!(flags&FR_MATCHCASE)){if(a>='A'&&a<='Z')a+=32;if(b>='A'&&b<='Z')b+=32;}
    if(a!=b)return FALSE;
  }
  return !(flags&FR_WHOLEWORD)||((!at||!word_char(text[at-1]))&&(at+q==n||!word_char(text[at+q])));
}
static void find_note(FINDREPLACEA *fr){
  char text[4096];unsigned n=(unsigned)GetWindowTextA(notes,text,sizeof(text)),q=text_length(fr->lpstrFindWhat);
  DWORD start=0,end=0;SendMessageA(notes,EM_GETSEL,(WPARAM)&start,(LPARAM)&end);
  if(!q||q>n){say("Find: no matching text in notes.");return;}
  unsigned count=n-q+1,from=(fr->Flags&FR_DOWN)?end:(start?start-1:count-1);
  if(from>=count)from=(fr->Flags&FR_DOWN)?0:count-1;
  for(unsigned i=0;i<count;i++){
    unsigned at=(fr->Flags&FR_DOWN)?(from+i)%count:(from+count-i)%count;
    if(match_at(text,n,at,fr->lpstrFindWhat,q,fr->Flags)){
      SendMessageA(notes,EM_SETSEL,at,at+q);SetFocus(notes);say("Find: matching notes text selected.");return;
    }
  }
  say("Find: no matching text in notes.");
}
static void replace_note(FINDREPLACEA *fr,BOOL all){
  if(notes_locked){say("Replace: unlock notes with Editable first.");return;}
  char text[4096],output[4096];unsigned n=(unsigned)GetWindowTextA(notes,text,sizeof(text));
  unsigned q=text_length(fr->lpstrFindWhat),replacement=text_length(fr->lpstrReplaceWith);
  if(!q)return;
  if(!all){
    DWORD start=0,end=0;SendMessageA(notes,EM_GETSEL,(WPARAM)&start,(LPARAM)&end);
    if(end-start!=q||!match_at(text,n,start,fr->lpstrFindWhat,q,fr->Flags)){find_note(fr);return;}
    SendMessageA(notes,EM_REPLACESEL,TRUE,(LPARAM)fr->lpstrReplaceWith);
    say("Replace: selected notes text changed. Undo restores it.");return;
  }
  unsigned out=0,count=0;
  for(unsigned at=0;at<n;){
    if(match_at(text,n,at,fr->lpstrFindWhat,q,fr->Flags)){
      if(out+replacement>=sizeof(output)){say("Replace All: result exceeds the notes text limit.");return;}
      for(unsigned i=0;i<replacement;i++)output[out++]=fr->lpstrReplaceWith[i];
      at+=q;count++;
    }else{if(out+1>=sizeof(output)){say("Replace All: result exceeds the notes text limit.");return;}output[out++]=text[at++];}
  }
  if(!count){say("Replace All: no matching text in notes.");return;}
  output[out]=0;SendMessageA(notes,EM_SETSEL,0,-1);SendMessageA(notes,EM_REPLACESEL,TRUE,(LPARAM)output);
  say("Replace All: matching notes text changed. Undo restores it.");
}
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
    HGDIOBJ old_font=SelectObject(dc,font);SetBkMode(dc,TRANSPARENT);SetTextColor(dc,font_color);
    static const char label[]="Application-painted child window";
    TextOutA(dc,8,26,label,sizeof(label)-1);SelectObject(dc,old_font);EndPaint(window,&ps);return 0;
  }
  return DefWindowProcA(window,message,wp,lp);
}
static void reset(HWND window) {
  SendMessageA(items,LB_SETCURSEL,0,0);SendMessageA(combo,CB_SETCURSEL,0,0);
  CheckDlgButton(window,30,BST_UNCHECKED);CheckRadioButton(window,31,32,31);
  SetWindowLongA(canvas,GWL_USERDATA,0);InvalidateRect(canvas,NULL,TRUE);
  reset_priorities();
  note_mode(window,FALSE);
  TabCtrl_SetCurSel(pages,0);ShowWindow(priorities,SW_SHOW);ShowWindow(notes,SW_HIDE);
  TreeView_SelectItem(tree,first);say("Choose a category, list item or option.");
}
static LRESULT CALLBACK proc(HWND window,UINT message,WPARAM wp,LPARAM lp) {
  if(message==search_message&&search_message){
    FINDREPLACEA *fr=(FINDREPLACEA*)lp;
    if(fr->Flags&FR_DIALOGTERM){search_dialog=NULL;say("Find/Replace closed; notes stay editable.");return 0;}
    if(fr->Flags&FR_FINDNEXT)find_note(fr);
    if(fr->Flags&FR_REPLACE)replace_note(fr,FALSE);
    if(fr->Flags&FR_REPLACEALL)replace_note(fr,TRUE);
    return 0;
  }
  if(message==WM_SIZE&&status){SendMessageA(status,WM_SIZE,wp,lp);if(toolbar)SendMessageA(toolbar,TB_AUTOSIZE,0,0);return 0;}
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
    if(id==121){open_settings(window);return 0;}
    if(id==112||id==113){
      if(id==113&&notes_locked){say("Replace: unlock notes with Editable first.");return 0;}
      if(search_dialog&&IsWindow(search_dialog))DestroyWindow(search_dialog);
      TabCtrl_SetCurSel(pages,1);ShowWindow(priorities,SW_HIDE);ShowWindow(notes,SW_SHOW);
      search.lStructSize=sizeof(search);search.hwndOwner=window;search.Flags=FR_DOWN;
      search.lpstrFindWhat=search_text;search.wFindWhatLen=sizeof(search_text);
      search.lpstrReplaceWith=replace_text;search.wReplaceWithLen=sizeof(replace_text);
      search_dialog=id==112?FindTextA(&search):ReplaceTextA(&search);
      if(!search_dialog)say("Find/Replace could not open.");
      else{SetWindowPos(search_dialog,NULL,600,60,0,0,SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE);say("Find/Replace: the notes remain interactive while this window is open.");}
      return 0;
    }
    if(id==114){SendMessageA(notes,EM_UNDO,0,0);say("Undo: restored the previous notes edit.");return 0;}
    if(id==120){
      LOGFONTA logical={0};if(GetObjectA(font,sizeof(logical),&logical)!=sizeof(logical))ExitProcess(7);
      CHOOSEFONTA choose={0};choose.lStructSize=sizeof(choose);choose.hwndOwner=window;choose.lpLogFont=&logical;
      choose.Flags=CF_SCREENFONTS|CF_INITTOLOGFONTSTRUCT|CF_EFFECTS|CF_LIMITSIZE;choose.rgbColors=font_color;choose.nSizeMin=6;choose.nSizeMax=18;
      if(ChooseFontA(&choose)){
        HFONT selected=CreateFontIndirectA(&logical);if(!selected)ExitProcess(8);
        HFONT previous=font;font=selected;font_color=choose.rgbColors;
        const int ids[]={10,11,20,21,22,30,31,32,40,50,60,61,62,63};
        for(unsigned i=0;i<sizeof(ids)/sizeof(ids[0]);i++)SendDlgItemMessageA(window,ids[i],WM_SETFONT,(WPARAM)font,TRUE);
        SendDlgItemMessageA(canvas,51,WM_SETFONT,(WPARAM)font,TRUE);InvalidateRect(canvas,NULL,TRUE);
        if(!DeleteObject(previous))ExitProcess(9);
        say("Font selection: native controls and GDI text use your chosen font.");
      }else if(CommDlgExtendedError())say("Font selection is unavailable for these options.");
      else say("Font selection cancelled; the current font is unchanged.");
      return 0;
    }
    if(id==110||id==111||id==115){
      MENUITEMINFOA choice={0};choice.cbSize=sizeof(choice);choice.fMask=MIIM_DATA;
      if(id!=115&&!GetMenuItemInfoA(notes_menu,id,FALSE,&choice))ExitProcess(6);
      BOOL locked=id==115?SendMessageA(toolbar,TB_ISBUTTONCHECKED,115,0)!=0:choice.dwItemData==2;note_mode(window,locked);
      TabCtrl_SetCurSel(pages,1);ShowWindow(priorities,SW_HIDE);ShowWindow(notes,SW_SHOW);SetFocus(notes);
      say(locked?"Notes are read-only. Select Editable to unlock them.":"Notes are editable. Your text is preserved.");return 0;
    }
    if(id==20 && code==LBN_SELCHANGE){char text[128];LRESULT index=SendMessageA(items,LB_GETCURSEL,0,0);if(index>=0){SendMessageA(items,LB_GETTEXT,index,(LPARAM)text);say(text);}return 0;}
    if(id==21 && (code==CBN_SELCHANGE||code==CBN_EDITCHANGE)){char text[128];GetWindowTextA(combo,text,sizeof(text));say(text);return 0;}
    if(id==30){say(IsDlgButtonChecked(window,30)==BST_CHECKED?"Checkbox is checked.":"Checkbox is unchecked.");return 0;}
    if(id==31||id==32){say(id==31?"First radio selected; its group remains exclusive.":"Second radio selected; its group remains exclusive.");return 0;}
  }
  if(message==WM_DESTROY){if(search_dialog&&IsWindow(search_dialog))DestroyWindow(search_dialog);PostQuitMessage(0);return 0;}
  return DefWindowProcA(window,message,wp,lp);
}
static HWND child(HWND window,HINSTANCE instance,const char *className,const char *title,DWORD style,int x,int y,int width,int height,UINT id) {
  if(window==main_owner)y+=30;
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
  INITCOMMONCONTROLSEX init={sizeof(init),ICC_TREEVIEW_CLASSES|ICC_TAB_CLASSES|ICC_BAR_CLASSES};InitCommonControlsEx(&init);
  WNDCLASSA cls={0};cls.hInstance=instance;cls.lpfnWndProc=proc;cls.lpszClassName="GuiControlsDemo";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);cls.hCursor=LoadCursorA(NULL,IDC_ARROW);
  if(!RegisterClassA(&cls))ExitProcess(1);
  WNDCLASSA custom={0};custom.hInstance=instance;custom.lpfnWndProc=canvas_proc;
  custom.lpszClassName="GuiPaintedChild";custom.hCursor=LoadCursorA(NULL,IDC_ARROW);
  if(!RegisterClassA(&custom))ExitProcess(1);
  font=CreateFontA(-14,0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,OUT_DEFAULT_PRECIS,CLIP_DEFAULT_PRECIS,DEFAULT_QUALITY,DEFAULT_PITCH,"Arial");
  HMENU menu=CreateMenu(),popup=CreatePopupMenu();AppendMenuA(popup,MF_STRING,121,"&Settings...");AppendMenuA(popup,MF_STRING,100,"&Reset");AppendMenuA(popup,MF_STRING,101,"E&xit");AppendMenuA(menu,MF_POPUP,(UINT_PTR)popup,"&Demo");
  notes_menu=CreatePopupMenu();
  MENUITEMINFOA item={0};item.cbSize=sizeof(item);item.fMask=MIIM_FTYPE|MIIM_ID|MIIM_STRING|MIIM_DATA|MIIM_STATE;
  item.fType=MFT_RADIOCHECK;item.wID=110;item.dwTypeData="&Editable";item.dwItemData=1;item.fState=MFS_DEFAULT;
  if(!InsertMenuItemA(notes_menu,0,TRUE,&item))ExitProcess(5);
  item.wID=111;item.dwTypeData="&Read-only";item.dwItemData=2;item.fState=0;
  if(!InsertMenuItemA(notes_menu,1,TRUE,&item))ExitProcess(5);
  AppendMenuA(notes_menu,MF_SEPARATOR,0,NULL);
  AppendMenuA(notes_menu,MF_STRING,112,"&Find...");AppendMenuA(notes_menu,MF_STRING,113,"&Replace...");AppendMenuA(notes_menu,MF_STRING,114,"&Undo");
  AppendMenuA(menu,MF_POPUP,(UINT_PTR)notes_menu,"&Notes (editable)");
  HMENU appearance=CreatePopupMenu();AppendMenuA(appearance,MF_STRING,120,"&Font...");AppendMenuA(menu,MF_POPUP,(UINT_PTR)appearance,"&Appearance");
  drag_message=RegisterWindowMessageA(DRAGLISTMSGSTRING);
  search_message=RegisterWindowMessageA(FINDMSGSTRINGA);
  RECT rect={0,0,500,468};AdjustWindowRect(&rect,WS_OVERLAPPEDWINDOW,TRUE);
  HWND window=CreateWindowA(cls.lpszClassName,"Native GUI controls",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,rect.right-rect.left,rect.bottom-rect.top,NULL,menu,instance,NULL);if(!window)ExitProcess(2);
  main_owner=window;
  TBBUTTON tools[]={{STD_FIND,112,TBSTATE_ENABLED,BTNS_BUTTON,{0},0,-1},
    {STD_REPLACE,113,TBSTATE_ENABLED,BTNS_BUTTON,{0},0,-1},
    {STD_UNDO,114,TBSTATE_ENABLED,BTNS_BUTTON,{0},0,-1},
    {8,0,TBSTATE_ENABLED,BTNS_SEP,{0},0,-1},
    {STD_PROPERTIES,115,TBSTATE_ENABLED,BTNS_CHECK|BTNS_AUTOSIZE,{0},0,(INT_PTR)"Lock notes"}};
  toolbar=CreateToolbarEx(window,WS_CHILD|WS_VISIBLE|TBSTYLE_FLAT|TBSTYLE_TOOLTIPS,63,15,HINST_COMMCTRL,IDB_STD_SMALL_COLOR,tools,sizeof(tools)/sizeof(tools[0]),24,24,16,16,sizeof(TBBUTTON));
  if(!toolbar)ExitProcess(10);
  SendMessageA(toolbar,WM_SETFONT,(WPARAM)font,TRUE);
  child(window,instance,"STATIC","Native Windows controls, running in your browser",SS_LEFTNOWORDWRAP,12,12,476,20,10);
  tree=child(window,instance,WC_TREEVIEWA,"Categories",WS_BORDER|TVS_HASBUTTONS|TVS_HASLINES|TVS_SHOWSELALWAYS,12,42,144,348,11);
  items=child(window,instance,"LISTBOX","Items",WS_BORDER|LBS_NOTIFY|LBS_SORT|LBS_HASSTRINGS|LBS_NOINTEGRALHEIGHT,172,42,152,108,20);
  combo=child(window,instance,"COMBOBOX","Value",WS_BORDER|CBS_DROPDOWN|CBS_AUTOHSCROLL,172,168,152,120,21);
  status=CreateStatusWindowA(WS_CHILD|WS_VISIBLE|CCS_BOTTOM,"",window,22);
  if(status){SendMessageA(status,WM_SETFONT,(WPARAM)font,TRUE);SendMessageA(status,SB_SETMINHEIGHT,32,0);SendMessageA(status,WM_SIZE,0,0);}
  child(window,instance,"BUTTON","Enable option",BS_AUTOCHECKBOX,344,46,144,24,30);
  child(window,instance,"BUTTON","First radio",BS_AUTORADIOBUTTON|WS_GROUP,344,86,144,24,31);
  child(window,instance,"BUTTON","Second radio",BS_AUTORADIOBUTTON,344,116,144,24,32);
  child(window,instance,"BUTTON","Reset controls",BS_PUSHBUTTON,344,168,144,28,40);
  canvas=child(window,instance,custom.lpszClassName,"Custom canvas",WS_BORDER,172,210,316,50,50);
  child(canvas,instance,"BUTTON","Change",BS_PUSHBUTTON,224,8,80,28,51);
  pages=child(window,instance,WC_TABCONTROLA,"Priority pages",TCS_FIXEDWIDTH,172,270,316,30,60);
  priorities=child(window,instance,"LISTBOX","Priorities",WS_BORDER|LBS_NOTIFY|LBS_HASSTRINGS|LBS_NOINTEGRALHEIGHT,172,306,316,84,61);
  notes=child(window,instance,"EDIT","Type notes here. Switching tabs preserves your text.",WS_BORDER|ES_MULTILINE|ES_AUTOVSCROLL|ES_WANTRETURN,172,306,316,84,62);
  SendMessageA(notes,EM_SETLIMITTEXT,4095,0);
  if(!tree||!items||!combo||!status||!canvas||!priorities||!pages||!notes)ExitProcess(3);
  TCITEMA tab={0};tab.mask=TCIF_TEXT;tab.pszText="Priorities";TabCtrl_InsertItem(pages,0,&tab);
  tab.pszText="Notes";TabCtrl_InsertItem(pages,1,&tab);
  if(!MakeDragList(priorities))ExitProcess(4);
  root=category(TVI_ROOT,"Controls",0);first=category(root,"Tree view",1);category(root,"List box",2);category(root,"Combo box",3);TreeView_Expand(tree,root,TVE_EXPAND);
  SendMessageA(items,LB_ADDSTRING,0,(LPARAM)"Alpha");SendMessageA(items,LB_ADDSTRING,0,(LPARAM)"Beta");SendMessageA(items,LB_ADDSTRING,0,(LPARAM)"Gamma");
  SendMessageA(combo,CB_ADDSTRING,0,(LPARAM)"Choice One");SendMessageA(combo,CB_ADDSTRING,0,(LPARAM)"Choice Two");
  reset(window);
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){if(!search_dialog||!IsDialogMessageA(search_dialog,&msg)){TranslateMessage(&msg);DispatchMessageA(&msg);}}DestroyMenu(menu);if(font)DeleteObject(font);ExitProcess((UINT)msg.wParam);
}
