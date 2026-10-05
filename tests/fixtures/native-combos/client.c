/* Authored MIT PE32 acceptance: normal combos expose and use actual child HWNDs. */
#include <windows.h>
#define CHECK(x) do {if(!(x))ExitProcess(1000+__LINE__);} while(0)
static HWND root,combos[3],edits[3],lists[3];static WNDPROC original;static unsigned childTexts,childKeys,changes[3],editChanges[3],opens,closes;
static LRESULT CALLBACK editProc(HWND w,UINT msg,WPARAM wp,LPARAM lp){if(msg==WM_SETTEXT)childTexts++;if(msg==WM_KEYDOWN)childKeys++;return CallWindowProcW(original,w,msg,wp,lp);}
static void info(unsigned i){struct{COMBOBOXINFO value;DWORD tail;} out;out.value.cbSize=sizeof(out.value);out.tail=0xfeed;
 CHECK(GetComboBoxInfo(combos[i],&out.value)&&out.tail==0xfeed);CHECK(out.value.hwndCombo==combos[i]&&IsWindow(out.value.hwndList));lists[i]=out.value.hwndList;edits[i]=out.value.hwndItem;
 CHECK(GetParent(lists[i])==combos[i]);char name[24];CHECK(GetClassNameA(lists[i],name,24)==9&&name[0]=='C');CHECK((i==0&&!edits[i])||(i>0&&IsWindow(edits[i])&&GetParent(edits[i])==combos[i]));
 if(i>0){CHECK(GetClassNameA(edits[i],name,24)==4&&name[0]=='E');}
 CHECK(SendMessageW(combos[i],CB_GETCOMBOBOXINFO,0,(LPARAM)&out.value));CHECK(out.value.rcItem.right>out.value.rcItem.left);CHECK((i==2)==!!(out.value.stateButton&STATE_SYSTEM_INVISIBLE));
}
static LRESULT CALLBACK proc(HWND w,UINT msg,WPARAM wp,LPARAM lp){
 if(msg==WM_MEASUREITEM||msg==WM_DRAWITEM){CHECK(0);}
 if(msg==WM_COMMAND){unsigned id=LOWORD(wp),code=HIWORD(wp);if(id>=70&&id<=72){unsigned i=id-70;CHECK((HWND)lp==combos[i]);if(code==CBN_SELCHANGE){changes[i]++;SetWindowTextA(root,i==0?"Dropdown selected":i==1?"Editable selected":"Simple selected");}if(code==CBN_EDITCHANGE){editChanges[i]++;SetWindowTextA(root,i==1?"Native edit changed":"Simple edit changed");}if(code==CBN_DROPDOWN)opens++;if(code==CBN_CLOSEUP)closes++;return 0;}
 if(id==80&&code==BN_CLICKED){for(unsigned i=0;i<3;i++)info(i);CHECK(SendMessageW(combos[0],CB_GETCURSEL,0,0)==2);CHECK(SendMessageW(combos[1],CB_GETCURSEL,0,0)==CB_ERR);WCHAR text[24];CHECK(GetWindowTextW(edits[1],text,24)==5&&text[0]=='t');CHECK(SendMessageW(combos[2],CB_GETCURSEL,0,0)==1&&GetWindowTextW(edits[2],text,24)==7&&text[0]=='A');CHECK(changes[0]>=2&&editChanges[1]>0&&changes[2]>0&&childTexts>0&&childKeys>0&&opens>=2&&closes>=2);SetWindowTextA(root,"Native combo handles verified");return 0;}
 if(id==81&&code==BN_CLICKED){CHECK(SendMessageW(combos[1],CB_RESETCONTENT,0,0)==1&&SendMessageW(combos[1],CB_GETCOUNT,0,0)==0);WCHAR text[8];CHECK(GetWindowTextW(edits[1],text,8)==0);SetWindowTextA(root,"Native edit cleared on reset");return 0;}
 }
 if(msg==WM_DESTROY){PostQuitMessage(0);return 0;}return DefWindowProcW(w,msg,wp,lp);
}
void start(void){HINSTANCE instance=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.hInstance=instance;cls.lpfnWndProc=proc;cls.lpszClassName=L"NativeStringCombos";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);CHECK(RegisterClassW(&cls));
 root=CreateWindowW(cls.lpszClassName,L"Native combo starting",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,750,340,NULL,NULL,instance,NULL);CHECK(root);
 const WCHAR *names[3]={L"String dropdown",L"Native editable",L"Native simple"};unsigned styles[3]={CBS_DROPDOWNLIST|CBS_SORT,CBS_DROPDOWN|CBS_AUTOHSCROLL,CBS_SIMPLE|CBS_AUTOHSCROLL};
 for(unsigned i=0;i<3;i++){combos[i]=CreateWindowW(L"COMBOBOX",names[i],WS_CHILD|WS_VISIBLE|WS_BORDER|WS_TABSTOP|styles[i],20+i*240,40,220,180,root,(HMENU)(70+i),instance,NULL);CHECK(combos[i]);info(i);CHECK(SendMessageW(combos[i],CB_ADDSTRING,0,(LPARAM)L"Banana")==0);CHECK(SendMessageW(combos[i],CB_ADDSTRING,0,(LPARAM)L"Apricot")==((i==0)?0:1));CHECK(SendMessageW(combos[i],CB_ADDSTRING,0,(LPARAM)L"\x3a9" L"mega")==2);CHECK(SendMessageW(combos[i],CB_SETCURSEL,0,0)==0);CHECK(changes[i]==0&&editChanges[i]==0);}
 CHECK((HWND)SetFocus(combos[1])!=combos[1]&&GetFocus()==edits[1]);CHECK(SendMessageW(combos[1],CB_LIMITTEXT,5,0)==0&&SendMessageW(edits[1],EM_GETLIMITTEXT,0,0)==5);CHECK(SendMessageW(combos[1],CB_SETEDITSEL,0,MAKELPARAM(1,4))==0);DWORD first=99,last=99;CHECK(SendMessageW(edits[1],EM_GETSEL,(WPARAM)&first,(LPARAM)&last)==MAKELONG(1,4)&&first==1&&last==4);
 original=(WNDPROC)SetWindowLongW(edits[1],GWL_WNDPROC,(LONG)editProc);CHECK(original);
 CHECK(CreateWindowA("BUTTON","Verify native handles",WS_CHILD|WS_VISIBLE|WS_TABSTOP,20,240,230,32,root,(HMENU)80,instance,NULL));CHECK(CreateWindowA("BUTTON","Reset editable combo",WS_CHILD|WS_VISIBLE|WS_TABSTOP,270,240,230,32,root,(HMENU)81,instance,NULL));SetWindowTextA(root,"Native combos ready");MSG msg;while(GetMessageW(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}for(unsigned i=0;i<3;i++){CHECK(!IsWindow(lists[i])&&(!edits[i]||!IsWindow(edits[i])));}ExitProcess((UINT)msg.wParam);
}
