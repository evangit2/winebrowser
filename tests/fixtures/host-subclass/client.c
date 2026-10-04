/* Original MIT PE32 EXE + companion DLL, translated inside the browser. */
#include "hook.h"
static HWND edit,sibling,wide_edit,button,list;
static HOOK contexts[4];
static WNDPROC dll_proc;
static unsigned layered,forwarded;
static LRESULT CALLBACK outer(HWND window,UINT message,WPARAM wp,LPARAM lp) {
  if(message==HOOK_MESSAGE){layered++;return CallWindowProcA(dll_proc,window,message,wp,lp)+1;}
  return CallWindowProcA(dll_proc,window,message,wp,lp);
}
static LRESULT CALLBACK proc(HWND root,UINT message,WPARAM wp,LPARAM lp) {
  if(message==WM_COMMAND && LOWORD(wp)==90) {
    contexts[2].veto=0;SetWindowTextA(root,"Button allowed");return 0;
  }
  if(message==WM_COMMAND && LOWORD(wp)==80 && HIWORD(wp)==EN_CHANGE) {
    char value[32];CHECK(GetWindowTextA(edit,value,sizeof(value))>0);
    SetWindowTextA(root,value[0]=='t'?"Typed through subclass":"Text forwarded");return 0;
  }
  if(message==WM_COMMAND && LOWORD(wp)==83) {
    CHECK(IsDlgButtonChecked(root,83)==BST_CHECKED);forwarded++;
    SetWindowTextA(root,"Click forwarded");return 0;
  }
  if(message==WM_CLOSE) {
    CHECK(contexts[0].texts>=3 && contexts[0].keys>=2 && contexts[2].clicks==2 && forwarded==1 && layered==1);
    CHECK((WNDPROC)SetWindowLongA(edit,GWL_WNDPROC,(LONG)dll_proc)==outer);
    CHECK((WNDPROC)SetWindowLongA(edit,GWL_WNDPROC,(LONG)contexts[0].previous)==dll_proc);
    CHECK(RemovePropA(edit,"NativeHookContext")==&contexts[0]);
    CHECK(SendMessageA(edit,HOOK_MESSAGE,3,0)==0);
    CHECK(SetWindowTextA(edit,"restored"));
    char value[32];CHECK(GetWindowTextA(edit,value,sizeof(value))==8 && value[0]=='r');
  }
  if(message==WM_DESTROY){PostQuitMessage(0);return 0;}
  return DefWindowProcA(root,message,wp,lp);
}
void start(void) {
  HINSTANCE instance=GetModuleHandleA(NULL);WNDCLASSA cls={0};cls.hInstance=instance;
  cls.lpfnWndProc=proc;cls.lpszClassName="NativeHostSubclass";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);CHECK(RegisterClassA(&cls));
  RECT rect={0,0,420,290};CHECK(AdjustWindowRect(&rect,WS_OVERLAPPEDWINDOW,FALSE));
  HWND root=CreateWindowA(cls.lpszClassName,"Subclass starting",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,rect.right-rect.left,rect.bottom-rect.top,NULL,NULL,instance,NULL);CHECK(root);
  edit=CreateWindowExA(WS_EX_CLIENTEDGE,"EDIT","old",WS_CHILD|WS_VISIBLE|WS_TABSTOP|ES_AUTOHSCROLL,20,20,380,28,root,(HMENU)80,instance,NULL);CHECK(edit);
  sibling=CreateWindowExA(WS_EX_CLIENTEDGE,"EDIT","sibling",WS_CHILD|WS_VISIBLE|WS_TABSTOP,20,60,380,28,root,(HMENU)81,instance,NULL);CHECK(sibling);
  wide_edit=CreateWindowExW(WS_EX_CLIENTEDGE,L"EDIT",L"wide",WS_CHILD|WS_VISIBLE|WS_TABSTOP,20,100,380,28,root,(HMENU)82,instance,NULL);CHECK(wide_edit);
  button=CreateWindowA("BUTTON","Hooked checkbox",WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_AUTOCHECKBOX,20,144,200,28,root,(HMENU)83,instance,NULL);CHECK(button);
  list=CreateWindowExA(WS_EX_CLIENTEDGE,"LISTBOX","Hooked items",WS_CHILD|WS_VISIBLE|LBS_HASSTRINGS,240,142,160,114,root,(HMENU)84,instance,NULL);CHECK(list);
  CHECK(CreateWindowA("BUTTON","Allow button",WS_CHILD|WS_VISIBLE|WS_TABSTOP,20,200,180,28,root,(HMENU)90,instance,NULL));
  for(int i=0;i<4;i++)contexts[i].root=root;
  contexts[1].wide=1;contexts[2].veto=1;
  CHECK(InstallHook(edit,&contexts[0]));CHECK(InstallHook(wide_edit,&contexts[1]));CHECK(InstallHook(button,&contexts[2]));CHECK(InstallHook(list,&contexts[3]));
  CHECK((WNDPROC)GetWindowLongA(sibling,GWL_WNDPROC)==contexts[0].previous);
  CHECK((WNDPROC)GetClassLongA(edit,GCL_WNDPROC)==contexts[0].previous);
  WNDCLASSA original;CHECK(GetClassInfoA(NULL,"EDIT",&original));CHECK(original.lpfnWndProc==contexts[0].previous);
  CHECK(contexts[0].previous!=contexts[1].previous && contexts[0].previous!=contexts[2].previous && contexts[2].previous!=contexts[3].previous);
  char value[32];CHECK(contexts[0].previous(sibling,WM_GETTEXT,sizeof(value),(LPARAM)value)==7);
  CHECK(value[0]=='s' && value[6]=='g');
  dll_proc=(WNDPROC)GetWindowLongA(edit,GWL_WNDPROC);CHECK(dll_proc);
  CHECK((WNDPROC)SetWindowLongA(edit,GWL_WNDPROC,(LONG)outer)==dll_proc);
  CHECK(SendMessageA(edit,HOOK_MESSAGE,7,0)==0x77000008);CHECK(SendMessageA(sibling,HOOK_MESSAGE,7,0)==0);
  CHECK(SetWindowTextA(edit,"native"));CHECK(GetWindowTextA(edit,value,sizeof(value))==6 && value[0]=='n');
  CHECK(SetWindowTextW(wide_edit,L"Unicode \x03bb"));WCHAR wide[16];CHECK(GetWindowTextW(wide_edit,wide,16)==9 && wide[8]==0x03bb && wide[9]==0);
  CHECK(SendMessageA(list,LB_ADDSTRING,0,(LPARAM)"Alpha")==0);
  CHECK(SendMessageA(list,LB_ADDSTRING,0,(LPARAM)"Beta")==1);
  CHECK(contexts[3].previous(list,LB_GETCOUNT,0,0)==2);
  SetWindowTextA(root,"Subclass ready");
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){if(!IsDialogMessageA(root,&msg)){TranslateMessage(&msg);DispatchMessageA(&msg);}}
  CHECK(contexts[0].destroyed==0 && contexts[1].destroyed==1 && contexts[2].destroyed==1 && contexts[3].destroyed==1);
  CHECK(!IsWindow(edit) && !IsWindow(button));
  SetLastError(0);CHECK(contexts[0].previous(edit,WM_GETTEXT,sizeof(value),(LPARAM)value)==0 && GetLastError()==ERROR_INVALID_WINDOW_HANDLE);
  ExitProcess((UINT)msg.wParam);
}
