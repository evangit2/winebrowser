/* MIT license: see README.md. Native list-control contract fixture. */
#include <windows.h>
#include <winspool.h>
#define CHECK(x) do { if (!(x)) ExitProcess(__LINE__); } while (0)
static unsigned notifications;
static LRESULT CALLBACK proc(HWND w,UINT msg,WPARAM wp,LPARAM lp) {
  if(msg==WM_COMMAND) {
    UINT id=LOWORD(wp),code=HIWORD(wp);HWND child=(HWND)lp;
    CHECK(child==GetDlgItem(w,id));notifications++;
    if(id==80&&code==LBN_SELCHANGE){
      CHECK(SendDlgItemMessageA(w,80,LB_GETCURSEL,0,0)==1);
      CHECK(SendDlgItemMessageA(w,80,LB_GETITEMDATA,1,0)==88);
      CHECK(SetWindowTextA(w,"List selected Beta"));
    }
    if(id==81&&code==CBN_SELCHANGE){
      CHECK(SendDlgItemMessageA(w,81,CB_GETCURSEL,0,0)==1);
      CHECK(SendDlgItemMessageA(w,81,CB_GETITEMDATA,1,0)==77);
      CHECK(SetWindowTextA(w,"Combo selected Second"));
    }
    if(id==82&&code==CBN_EDITCHANGE){
      char text[64];CHECK(GetWindowTextA(child,text,sizeof(text))>0);
      if(text[0]=='t'&&text[1]=='y'&&text[2]=='p')CHECK(SetWindowTextA(w,"Typed native text"));
    }
    if(id==83&&code==CBN_SELCHANGE){
      CHECK(SendDlgItemMessageA(w,83,CB_GETCURSEL,0,0)==0);
      CHECK(SetWindowTextA(w,"Simple selected One"));
    }
    if(id==84){CHECK(SendMessageA(child,BM_GETCHECK,0,0)==BST_CHECKED);CHECK(SetWindowTextA(w,"Checkbox checked"));}
    if(id==85){CHECK(SendMessageA(child,BM_GETCHECK,0,0)==BST_CHECKED);CHECK(SendDlgItemMessageA(w,86,BM_GETCHECK,0,0)==BST_UNCHECKED);CHECK(SetWindowTextA(w,"First radio checked"));}
    if(id==86){CHECK(SendMessageA(child,BM_GETCHECK,0,0)==BST_CHECKED);CHECK(SendDlgItemMessageA(w,85,BM_GETCHECK,0,0)==BST_UNCHECKED);CHECK(SetWindowTextA(w,"Second radio checked"));}
    return 0;
  }
  if(msg==WM_DESTROY){PostQuitMessage(0);return 0;}
  return DefWindowProcA(w,msg,wp,lp);
}
static void printers(void) {
  HMODULE module=LoadLibraryA("C:\\Windows\\System32\\winspool.drv");CHECK(module);
  typedef BOOL (WINAPI *EnumFn)(DWORD,LPSTR,DWORD,LPBYTE,DWORD,LPDWORD,LPDWORD);
  EnumFn enumerate=(EnumFn)(void*)GetProcAddress(module,"EnumPrintersA");CHECK(enumerate);
  DWORD needed=999,count=999;BYTE buffer[16]={0x71};
  CHECK(enumerate(PRINTER_ENUM_LOCAL|PRINTER_ENUM_CONNECTIONS,NULL,4,buffer,sizeof(buffer),&needed,&count));
  CHECK(needed==0&&count==0&&buffer[0]==0x71);
  CHECK(!enumerate(PRINTER_ENUM_LOCAL,NULL,3,NULL,0,&needed,&count));CHECK(GetLastError()==ERROR_INVALID_LEVEL);
  CHECK(FreeLibrary(module));
}
void start(void) {
  printers();
  HINSTANCE instance=GetModuleHandleA(NULL);
  WNDCLASSA cls={0};cls.hInstance=instance;cls.lpfnWndProc=proc;cls.lpszClassName="NativeLists";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);CHECK(RegisterClassA(&cls));
  RECT r={0,0,330,240};CHECK(AdjustWindowRect(&r,WS_OVERLAPPEDWINDOW,FALSE));
  HWND w=CreateWindowA(cls.lpszClassName,"Native Lists",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,r.right-r.left,r.bottom-r.top,NULL,NULL,instance,NULL);CHECK(w);
  CHECK(CreateWindowExA(WS_EX_CLIENTEDGE,"LISTBOX","Items",WS_CHILD|WS_VISIBLE|WS_TABSTOP|LBS_NOTIFY|LBS_SORT|LBS_HASSTRINGS|LBS_NOINTEGRALHEIGHT,10,10,150,120,w,(HMENU)80,instance,NULL));
  CHECK(CreateWindowExA(WS_EX_CLIENTEDGE,"COMBOBOX","Choices",WS_CHILD|WS_VISIBLE|WS_TABSTOP|CBS_DROPDOWNLIST|CBS_HASSTRINGS,180,10,140,120,w,(HMENU)81,instance,NULL));
  CHECK(CreateWindowExA(WS_EX_CLIENTEDGE,"COMBOBOX","Value",WS_CHILD|WS_VISIBLE|WS_TABSTOP|CBS_DROPDOWN|CBS_AUTOHSCROLL,180,50,140,120,w,(HMENU)82,instance,NULL));
  CHECK(CreateWindowExA(WS_EX_CLIENTEDGE,"COMBOBOX","Simple",WS_CHILD|WS_VISIBLE|WS_TABSTOP|CBS_SIMPLE|CBS_AUTOHSCROLL,180,90,140,120,w,(HMENU)83,instance,NULL));
  CHECK(SendDlgItemMessageA(w,80,LB_ADDSTRING,0,(LPARAM)"Beta")==0);
  CHECK(SendDlgItemMessageA(w,80,LB_SETITEMDATA,0,88)==0);
  CHECK(SendDlgItemMessageA(w,80,LB_ADDSTRING,0,(LPARAM)"Alpha")==0);
  CHECK(SendDlgItemMessageA(w,80,LB_GETITEMDATA,1,0)==88);
  CHECK(SendDlgItemMessageA(w,80,LB_SETCURSEL,0,0)==0);
  CHECK(SendDlgItemMessageA(w,80,LB_FINDSTRINGEXACT,(WPARAM)-1,(LPARAM)"BETA")==1);
  CHECK(SendDlgItemMessageA(w,81,CB_ADDSTRING,0,(LPARAM)"First")==0);
  CHECK(SendDlgItemMessageA(w,81,CB_ADDSTRING,0,(LPARAM)"Second")==1);
  CHECK(SendDlgItemMessageA(w,81,CB_SETITEMDATA,1,77)==0);
  CHECK(SendDlgItemMessageA(w,81,CB_SETCURSEL,0,0)==0);
  CHECK(SendDlgItemMessageW(w,82,CB_ADDSTRING,0,(LPARAM)L"Unicode \x03bb")==0);
  CHECK(SendDlgItemMessageA(w,82,CB_ADDSTRING,0,(LPARAM)"Other")==1);
  WCHAR out[32];CHECK(SendDlgItemMessageW(w,82,CB_GETLBTEXTLEN,0,0)==9);
  CHECK(SendDlgItemMessageW(w,82,CB_GETLBTEXT,0,(LPARAM)out)==9);CHECK(out[8]==0x03bb&&out[9]==0);
  CHECK(SetDlgItemTextA(w,82,"initial"));CHECK(GetDlgItemTextA(w,82,(char*)out,sizeof(out))==7);
  CHECK(SendDlgItemMessageA(w,83,CB_ADDSTRING,0,(LPARAM)"One")==0);
  CHECK(SendDlgItemMessageA(w,83,CB_ADDSTRING,0,(LPARAM)"Two")==1);
  CHECK(SendDlgItemMessageA(w,83,CB_SETCURSEL,1,0)==1);
  CHECK(CreateWindowA("BUTTON","Enable option",WS_CHILD|WS_VISIBLE|BS_AUTOCHECKBOX|WS_TABSTOP,10,150,150,20,w,(HMENU)84,instance,NULL));
  CHECK(CreateWindowA("BUTTON","First radio",WS_CHILD|WS_VISIBLE|BS_AUTORADIOBUTTON|WS_GROUP|WS_TABSTOP,10,180,150,20,w,(HMENU)85,instance,NULL));
  CHECK(CreateWindowA("BUTTON","Second radio",WS_CHILD|WS_VISIBLE|BS_AUTORADIOBUTTON,10,205,150,20,w,(HMENU)86,instance,NULL));
  CHECK(notifications==0);
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}
  CHECK(notifications>=9);ExitProcess((UINT)msg.wParam);
}
