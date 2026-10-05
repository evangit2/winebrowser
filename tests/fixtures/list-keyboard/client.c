/* Project-authored MIT native PE32 GUI keyboard acceptance. */
#include <windows.h>
#define CHECK(x) do {if(!(x))ExitProcess(1000+__LINE__);} while(0)
static HWND root,lists[5],combo;static unsigned keys,chars,handled,changes[6];
static unsigned mask(HWND w){unsigned result=0;for(unsigned i=0;i<6;i++)if(SendMessageW(w,LB_GETSEL,i,0)>0)result|=1u<<i;return result;}
static LRESULT CALLBACK proc(HWND w,UINT msg,WPARAM wp,LPARAM lp){
  if(msg==WM_VKEYTOITEM || msg==WM_CHARTOITEM){
    HWND list=(HWND)lp;CHECK(list==lists[0]||list==lists[1]||list==lists[3]);CHECK(HIWORD(wp)==(unsigned)SendMessageW(list,LB_GETCARETINDEX,0,0));
    if(msg==WM_VKEYTOITEM){keys++;if(LOWORD(wp)==VK_F2)return 2;if(LOWORD(wp)==VK_F6)return 0;if(LOWORD(wp)==VK_F3){handled++;return -2;}if(LOWORD(wp)==VK_F5)return 99;}
    else {chars++;if(LOWORD(wp)=='#')return 1;if(LOWORD(wp)=='!'){handled++;return -2;}}
    return -1;
  }
  if(msg==WM_MEASUREITEM){MEASUREITEMSTRUCT *m=(void*)lp;CHECK(m->CtlID==71||m->CtlID==75);m->itemHeight=28;return TRUE;}
  if(msg==WM_CTLCOLORLISTBOX)return (LRESULT)GetStockObject(WHITE_BRUSH);
  if(msg==WM_DRAWITEM){DRAWITEMSTRUCT *d=(void*)lp;CHECK(wp==71||wp==75);if(d->itemID==(UINT)-1)return TRUE;CHECK(d->itemID<6);HBRUSH brush=CreateSolidBrush(d->itemState&ODS_SELECTED?RGB(180,30,70):RGB(20,110,170));CHECK(FillRect(d->hDC,&d->rcItem,brush)&&DeleteObject(brush));SetBkMode(d->hDC,TRANSPARENT);SetTextColor(d->hDC,RGB(255,255,255));if(wp==71){CHECK(d->itemData==0xfa000000u+d->itemID);CHECK(TextOutA(d->hDC,12,d->rcItem.top+4,"Callback item",13));}else{WCHAR text[20];int n=(int)SendMessageW(combo,CB_GETLBTEXT,d->itemID,(LPARAM)text);CHECK(n>0&&TextOutW(d->hDC,12,d->rcItem.top+4,text,n));}return TRUE;}
  if(msg==WM_COMMAND){unsigned id=LOWORD(wp),code=HIWORD(wp);if(id>=70&&id<=75&&code==1){CHECK((HWND)lp==(id==75?combo:lists[id-70]));changes[id-70]++;const char *titles[6]={"ANSI changed","Raw changed","Multiple changed","Extended changed","Tabbed changed","Combo changed"};SetWindowTextA(root,titles[id-70]);return 0;}
    if(id==80&&code==BN_CLICKED){SetWindowTextA(root,"Verify ANSI");CHECK(SendMessageW(lists[0],LB_GETCURSEL,0,0)==4);SetWindowTextA(root,"Verify raw");CHECK(SendMessageW(lists[1],LB_GETCURSEL,0,0)==1);SetWindowTextA(root,"Verify multiple");CHECK(SendMessageW(lists[2],LB_GETCARETINDEX,0,0)==5&&mask(lists[2])==5);SetWindowTextA(root,"Verify extended");CHECK(SendMessageW(lists[3],LB_GETCARETINDEX,0,0)==4&&SendMessageW(lists[3],LB_GETANCHORINDEX,0,0)==1&&mask(lists[3])==30);SetWindowTextA(root,"Verify tabbed");CHECK(SendMessageW(lists[4],LB_GETCURSEL,0,0)==2);SetWindowTextA(root,"Verify combo");CHECK(SendMessageW(combo,CB_GETCURSEL,0,0)==5&&!SendMessageW(combo,CB_GETDROPPEDSTATE,0,0));SetWindowTextA(root,"Verify counters");CHECK(keys>=5&&chars>=6&&handled>=2);SetWindowTextA(root,"Verify notifications");for(unsigned i=0;i<6;i++){CHECK(changes[i]>0);}SetWindowTextA(root,"Native keyboard verified");return 0;}
  }
  if(msg==WM_DESTROY){PostQuitMessage(0);return 0;}return DefWindowProcW(w,msg,wp,lp);
}
void start(void){HINSTANCE instance=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.hInstance=instance;cls.lpfnWndProc=proc;cls.lpszClassName=L"NativeListKeyboard";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);CHECK(RegisterClassW(&cls));
 root=CreateWindowW(cls.lpszClassName,L"Keyboard starting",WS_OVERLAPPEDWINDOW|WS_VISIBLE,30,30,960,430,NULL,NULL,instance,NULL);CHECK(root);
 const WCHAR *names[5]={L"ANSI callbacks",L"Raw callbacks",L"Multiple Unicode",L"Extended Unicode",L"Tabbed strings"};unsigned styles[5]={LBS_WANTKEYBOARDINPUT,LBS_WANTKEYBOARDINPUT|LBS_OWNERDRAWFIXED,LBS_MULTIPLESEL,LBS_EXTENDEDSEL|LBS_WANTKEYBOARDINPUT,LBS_USETABSTOPS};
 for(unsigned i=0;i<5;i++){lists[i]=i==0?CreateWindowA("LISTBOX","ANSI callbacks",WS_CHILD|WS_VISIBLE|WS_TABSTOP|WS_BORDER|LBS_NOTIFY|styles[i],20+i*184,35,170,175,root,(HMENU)(70+i),instance,NULL):CreateWindowW(L"LISTBOX",names[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP|WS_BORDER|LBS_NOTIFY|styles[i],20+i*184,35,170,175,root,(HMENU)(70+i),instance,NULL);CHECK(lists[i]);}
 combo=CreateWindowW(L"COMBOBOX",L"Owner Unicode combo",WS_CHILD|WS_VISIBLE|WS_TABSTOP|WS_BORDER|CBS_DROPDOWNLIST|CBS_OWNERDRAWFIXED|CBS_HASSTRINGS,20,250,200,160,root,(HMENU)75,instance,NULL);CHECK(combo);
 const WCHAR *texts[6]={L"Apple",L"Apricot",L"Banana",L"\xc9" L"clair",L"\x20ac" L"uro",L"\x3a9" L"mega"};const char *ansi[6]={"Apple","Apricot","Banana","\xc9" "clair","\x80" "uro","Last"};
 for(unsigned i=0;i<6;i++){for(unsigned j=0;j<5;j++)CHECK((unsigned)(j==0?SendMessageA(lists[j],LB_ADDSTRING,0,(LPARAM)ansi[i]):SendMessageW(lists[j],LB_ADDSTRING,0,j==1?(LPARAM)(0xfa000000u+i):(LPARAM)texts[i]))==i);CHECK((unsigned)SendMessageW(combo,CB_ADDSTRING,0,(LPARAM)texts[i])==i);}
 CHECK(SendMessageA(lists[0],WM_CHAR,0x80,0)==0&&SendMessageW(lists[0],LB_GETCURSEL,0,0)==4);CHECK(SendMessageW(lists[0],LB_SETCURSEL,0,0)==0);
 CHECK(SendMessageW(lists[1],LB_SETCURSEL,0,0)==0);CHECK(SendMessageW(lists[2],LB_SETSEL,TRUE,0)==0&&SendMessageW(lists[2],LB_SETSEL,TRUE,2)==0);CHECK(SendMessageW(lists[3],LB_SETSEL,TRUE,1)==0&&SendMessageW(lists[3],LB_SETANCHORINDEX,1,0)==0);CHECK(SendMessageW(lists[4],LB_SETCURSEL,0,0)==0&&SendMessageW(combo,CB_SETCURSEL,0,0)==0);
 for(unsigned i=0;i<6;i++){changes[i]=0;}keys=chars=handled=0;
 CHECK(CreateWindowA("BUTTON","Verify native keyboard",WS_CHILD|WS_VISIBLE|WS_TABSTOP,260,250,240,32,root,(HMENU)80,instance,NULL));SetWindowTextA(root,"Keyboard ready");MSG message;while(GetMessageW(&message,NULL,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}ExitProcess((UINT)message.wParam);
}
