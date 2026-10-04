/* Original MIT native EXE/DLL modeless Find and Replace acceptance. */
#include <windows.h>
#include <commdlg.h>
#define CHECK(x) do{if(!(x))ExitProcess(__LINE__);}while(0)
static HWND owner,dialog,status,editor;static HMODULE library;static UINT findMessage,helpMessage;
static int mode,finds,replaces,all,helps;static WNDPROC original;
static struct{char text[8];DWORD tail;} findA={{0},0xfeedbeef};
static struct{WCHAR text[16];DWORD tail;} findW={{0x03a9,0},0xfeedbeef};
static char findReplace[32]="alpha",replacement[32]="beta";
static FINDREPLACEA a,repl;static FINDREPLACEW w;
static FINDREPLACEW template_find;static WCHAR template_buffer[8];
static unsigned template_actions,template_terms,template_inits;
static void(WINAPI *expect)(LPARAM);static unsigned(WINAPI *initializations)(void);static LPFRHOOKPROC hook;
static void say(const WCHAR *text){SetWindowTextW(status,text);}
static INT_PTR CALLBACK template_proc(HWND window,UINT message,WPARAM wp,LPARAM lp){
  (void)wp;
  if(message==WM_INITDIALOG){
    template_inits++;CHECK(lp==0x1234||lp==0x1235);CHECK(IsWindowUnicode(window));
    HWND edit=GetDlgItem(window,1152);CHECK(edit&&IsWindowUnicode(edit));
    CHECK(SetDlgItemTextW(window,1152,L"\x03a9\x20ac"));
    WCHAR text[8]={0};CHECK(GetDlgItemTextW(window,1152,text,8)==2);CHECK(text[0]==0x03a9&&text[1]==0x20ac);
    if(lp==0x1235)CHECK(EndDialog(window,0x5566));
    return TRUE;
  }
  return FALSE;
}
static void arrange(void){CHECK(dialog);CHECK(IsWindowEnabled(owner));CHECK(GetWindow(dialog,GW_OWNER)==owner);CHECK(SetWindowPos(dialog,NULL,620,40,0,0,SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE));}
static LRESULT CALLBACK subclass(HWND window,UINT message,WPARAM wp,LPARAM lp){
  if(message==WM_COMMAND&&LOWORD(wp)==2000){say(L"Subclass W: native template button");return 0;}
  return CallWindowProcW(original,window,message,wp,lp);
}
static void begin(void){
  if(mode==1){
    a.lStructSize=sizeof(a);a.hwndOwner=owner;a.Flags=FR_DOWN|FR_SHOWHELP|FR_ENABLEHOOK;a.lpfnHook=hook;a.lpstrFindWhat=findA.text;a.wFindWhatLen=sizeof(findA.text);
    expect((LPARAM)&a);dialog=FindTextA(&a);arrange();CHECK(!IsWindowUnicode(GetDlgItem(dialog,1152)));CHECK(SendDlgItemMessageA(dialog,1152,EM_GETLIMITTEXT,0,0)==7);
  }else if(mode==2){
    w.lStructSize=sizeof(w);w.hwndOwner=owner;w.hInstance=library;w.Flags=FR_DOWN|FR_ENABLEHOOK|FR_ENABLETEMPLATE;w.lpfnHook=hook;w.lpTemplateName=MAKEINTRESOURCEW(201);w.lpstrFindWhat=findW.text;w.wFindWhatLen=16;
    expect((LPARAM)&w);dialog=FindTextW(&w);arrange();CHECK(IsWindowUnicode(GetDlgItem(dialog,1152)));
    original=(WNDPROC)GetWindowLongW(dialog,GWL_WNDPROC);CHECK(original);CHECK((WNDPROC)SetWindowLongW(dialog,GWL_WNDPROC,(LONG)subclass)==original);
  }else{
    repl.lStructSize=sizeof(repl);repl.hwndOwner=owner;repl.Flags=FR_DOWN;repl.lpstrFindWhat=findReplace;repl.wFindWhatLen=sizeof(findReplace);repl.lpstrReplaceWith=replacement;repl.wReplaceWithLen=sizeof(replacement);
    dialog=ReplaceTextA(&repl);arrange();
  }
}
static LRESULT CALLBACK proc(HWND window,UINT message,WPARAM wp,LPARAM lp){
  if(message==helpMessage){CHECK(mode==1&&lp==(LPARAM)&a&&wp==(WPARAM)dialog);helps++;say(L"Help A: native callback");return 0;}
  if(message==findMessage){
    if(mode==0){
      CHECK(lp==(LPARAM)&template_find);CHECK(template_find.Flags&FR_DOWN);
      if(template_find.Flags&FR_FINDNEXT){CHECK(template_buffer[0]==0x03a9&&template_buffer[1]==0x20ac&&template_buffer[2]==0);template_actions++;}
      if(template_find.Flags&FR_DIALOGTERM){CHECK(!(template_find.Flags&FR_FINDNEXT));template_terms++;}
      return 0;
    }
    FINDREPLACEA *fr=(FINDREPLACEA*)lp;CHECK(lp==(LPARAM)(mode==1?(void*)&a:mode==2?(void*)&w:(void*)&repl));
    CHECK((fr->Flags&FR_DOWN)!=0);CHECK(IsWindowEnabled(owner));
    if(fr->Flags&FR_DIALOGTERM){
      CHECK(!(fr->Flags&(FR_FINDNEXT|FR_REPLACE|FR_REPLACEALL)));
      if(mode==1){CHECK(finds==1&&helps==1&&findA.tail==0xfeedbeef);say(L"Find A closed");}
      else if(mode==2){CHECK(finds==2&&findW.tail==0xfeedbeef&&initializations()==2);say(L"Find W closed");}
      else{CHECK(replaces==1&&all==1);say(L"All native Find/Replace checks passed");return 0;}
      PostMessageW(owner,WM_APP+1,0,0);return 0;
    }
    if(fr->Flags&FR_FINDNEXT){
      CHECK(!(fr->Flags&(FR_REPLACE|FR_REPLACEALL)));finds++;
      if(mode==1){CHECK(findA.text[0]=='a'&&findA.text[4]=='a'&&findA.text[5]==0);CHECK(fr->Flags&FR_MATCHCASE);say(L"Find A: native notification");}
      else {CHECK(w.lpstrFindWhat[0]==0x03a9&&w.lpstrFindWhat[1]==0x20ac&&w.lpstrFindWhat[2]==0);CHECK(fr->Flags&FR_WHOLEWORD);say(L"Find W: Unicode native notification");}
      return 0;
    }
    CHECK(mode==3&&findReplace[0]=='a'&&replacement[0]=='b');
    if(fr->Flags&FR_REPLACE){CHECK(!(fr->Flags&(FR_FINDNEXT|FR_REPLACEALL)));replaces++;SendMessageW(editor,EM_SETSEL,0,5);SendMessageW(editor,EM_REPLACESEL,FALSE,(LPARAM)L"beta");say(L"Replace A: native edit changed");}
    if(fr->Flags&FR_REPLACEALL){CHECK(!(fr->Flags&(FR_FINDNEXT|FR_REPLACE)));all++;SetWindowTextW(editor,L"beta beta");say(L"Replace All A: native edit changed");}
    return 0;
  }
  if(message==WM_APP+1){mode++;begin();return 0;}
  if(message==WM_DESTROY){CHECK(mode==3&&replaces==1&&all==1);PostQuitMessage(0);return 0;}
  return DefWindowProcW(window,message,wp,lp);
}
void start(void){
  HINSTANCE instance=GetModuleHandleA(NULL);WNDCLASSW klass={0};klass.hInstance=instance;klass.lpfnWndProc=proc;klass.lpszClassName=L"NativeFindOwner";klass.hbrBackground=(HBRUSH)(COLOR_WINDOW+1);CHECK(RegisterClassW(&klass));
  RECT bounds={0,0,540,130};CHECK(AdjustWindowRect(&bounds,WS_OVERLAPPEDWINDOW,FALSE));
  owner=CreateWindowW(klass.lpszClassName,L"Native Find/Replace owner",WS_OVERLAPPEDWINDOW|WS_VISIBLE,20,30,bounds.right-bounds.left,bounds.bottom-bounds.top,NULL,NULL,instance,NULL);CHECK(owner);
  status=CreateWindowW(L"STATIC",L"Owner stays interactive",WS_CHILD|WS_VISIBLE,8,8,520,24,owner,(HMENU)10,instance,NULL);CHECK(status);
  editor=CreateWindowW(L"EDIT",L"alpha alpha",WS_CHILD|WS_VISIBLE|WS_BORDER|ES_MULTILINE,8,40,520,76,owner,(HMENU)11,instance,NULL);CHECK(editor);
  findMessage=RegisterWindowMessageW(FINDMSGSTRINGW);helpMessage=RegisterWindowMessageW(HELPMSGSTRINGW);CHECK(findMessage&&helpMessage);
  CHECK(!FindTextA(NULL)&&CommDlgExtendedError()==CDERR_INITIALIZATION);
  FINDREPLACEA invalid={0};invalid.lStructSize=sizeof(invalid);invalid.hwndOwner=owner;CHECK(!FindTextA(&invalid)&&CommDlgExtendedError()==FRERR_BUFFERLENGTHZERO);
  invalid.lpstrFindWhat=findA.text;invalid.wFindWhatLen=8;invalid.Flags=FR_ENABLEHOOK;CHECK(!FindTextA(&invalid)&&CommDlgExtendedError()==CDERR_NOHOOK);
  library=LoadLibraryA("find-resources.dll");CHECK(library);
  HRSRC named=FindResourceW(library,L"GUI\x03a9",MAKEINTRESOURCEW(5));CHECK(named);
  CHECK(SizeofResource(library,named)>0);HGLOBAL named_data=LoadResource(library,named);CHECK(named_data);CHECK(LockResource(named_data));
  CHECK(!FreeResource(named_data));CHECK(LockResource(named_data));
  HRSRC resource=FindResourceW(library,MAKEINTRESOURCEW(201),MAKEINTRESOURCEW(5));CHECK(resource);
  CHECK(FindResourceExA(library,MAKEINTRESOURCEA(5),MAKEINTRESOURCEA(201),0));
  DWORD bytes=SizeofResource(library,resource);CHECK(bytes);
  const BYTE *source=(const BYTE*)LockResource(LoadResource(library,resource));CHECK(source);
  HGLOBAL memory=GlobalAlloc(GMEM_MOVEABLE|GMEM_ZEROINIT,bytes);CHECK(memory);
  BYTE *copy=(BYTE*)GlobalLock(memory);CHECK(copy);for(DWORD k=0;k<bytes;k++)copy[k]=source[k];GlobalUnlock(memory);
  HWND normal=CreateDialogParamW(library,MAKEINTRESOURCEW(201),owner,template_proc,0x1234);CHECK(normal);CHECK(DestroyWindow(normal));
  normal=CreateDialogIndirectParamW(instance,(LPCDLGTEMPLATEW)copy,owner,template_proc,0x1234);CHECK(normal);CHECK(DestroyWindow(normal));
  CHECK(DialogBoxParamW(library,MAKEINTRESOURCEW(201),owner,template_proc,0x1235)==0x5566);
  CHECK(DialogBoxIndirectParamW(instance,(LPCDLGTEMPLATEW)copy,owner,template_proc,0x1235)==0x5566);
  CHECK(template_inits==4);
  template_find.lStructSize=sizeof(template_find);template_find.hwndOwner=owner;template_find.hInstance=(HINSTANCE)memory;
  template_find.Flags=FR_DOWN|FR_ENABLETEMPLATEHANDLE;template_find.lpstrFindWhat=template_buffer;template_find.wFindWhatLen=8;
  HWND from_handle=FindTextW(&template_find);CHECK(from_handle);CHECK(IsWindowUnicode(from_handle));
  CHECK(SetDlgItemTextW(from_handle,1152,L"\x03a9\x20ac"));SendMessageW(from_handle,WM_COMMAND,IDOK,0);SendMessageW(from_handle,WM_COMMAND,IDCANCEL,0);
  CHECK(template_actions==1&&template_terms==1);CHECK(!IsWindow(from_handle));CHECK(GlobalSize(memory)>=bytes);CHECK(!GlobalFree(memory));
  union{FARPROC raw;void(WINAPI *fn)(LPARAM);} e;e.raw=GetProcAddress(library,"Expect");expect=e.fn;
  union{FARPROC raw;unsigned(WINAPI *fn)(void);} i;i.raw=GetProcAddress(library,"Initializations");initializations=i.fn;
  union{FARPROC raw;LPFRHOOKPROC fn;} h;h.raw=GetProcAddress(library,"FindHook");hook=h.fn;CHECK(expect&&initializations&&hook);
  mode=1;begin();MSG message;while(GetMessageW(&message,NULL,0,0)>0){if(!IsDialogMessageW(dialog,&message)){TranslateMessage(&message);DispatchMessageW(&message);}}
  CHECK(FreeLibrary(library));ExitProcess((UINT)message.wParam);
}
