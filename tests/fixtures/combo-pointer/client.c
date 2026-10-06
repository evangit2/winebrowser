/* Authored MIT PE32 acceptance: actual combo/list/edit procedures and capture. */
#include <windows.h>
#define CHECK(x) do { if (!(x)) ExitProcess(1000+__LINE__); } while (0)
static HWND root, combos[3], lists[3], edits[3];
static WNDPROC originals[9];
static unsigned stage, events[3][16], counts[3], downs[9], moves[9], ups[9], changes[9], cancels[9];
static LPARAM listDown;
static unsigned indexOf(HWND w) { for (unsigned i=0;i<3;i++) { if(w==combos[i])return i; if(w==lists[i])return i+3; if(w==edits[i]&&w)return i+6; } CHECK(0); return 0; }
static void sequence(unsigned i, const unsigned *want, unsigned n) { if(counts[i]!=n)ExitProcess(2000+stage*100+counts[i]); for(unsigned j=0;j<n;j++)if(events[i][j]!=want[j])ExitProcess(4000+stage*100+events[i][j]); }
static void verify(void) {
 COMBOBOXINFO info={0};info.cbSize=sizeof(info);CHECK(GetComboBoxInfo(combos[0],&info));
 const unsigned opened[]={7},cancelled[]={7,10,8},committed[]={7,1,9,8};
 if(stage==0){CHECK(GetCapture()==lists[0]&&SendMessageW(combos[0],CB_GETDROPPEDSTATE,0,0));CHECK(SendMessageW(combos[0],CB_GETCURSEL,0,0)==2&&SendMessageW(lists[0],LB_GETCARETINDEX,0,0)==2);CHECK(moves[3]>0&&downs[3]==0&&ups[3]==0);sequence(0,opened,1);}
 if(stage==1){CHECK(GetCapture()==NULL&&!SendMessageW(combos[0],CB_GETDROPPEDSTATE,0,0));CHECK(SendMessageW(combos[0],CB_GETCURSEL,0,0)==0);sequence(0,cancelled,3);counts[0]=0;}
 if(stage==2){CHECK(GetCapture()==combos[0]&&info.stateButton==STATE_SYSTEM_PRESSED&&downs[0]==1);sequence(0,opened,1);}
 if(stage==3){CHECK(GetCapture()==lists[0]&&info.stateButton==0);CHECK(moves[0]>0&&changes[0]>0&&downs[3]==1&&moves[3]>1);CHECK((SHORT)LOWORD(listDown)>=0&&(SHORT)HIWORD(listDown)>=0);RECT item;CHECK(SendMessageW(lists[0],LB_GETITEMRECT,1,(LPARAM)&item)==0);CHECK((SHORT)HIWORD(listDown)>=item.top&&(SHORT)HIWORD(listDown)<item.bottom);CHECK(SendMessageW(combos[0],CB_GETCURSEL,0,0)==2);sequence(0,opened,1);}
 if(stage==4){CHECK(GetCapture()==NULL&&!SendMessageW(combos[0],CB_GETDROPPEDSTATE,0,0)&&info.stateButton==0);CHECK(SendMessageW(combos[0],CB_GETCURSEL,0,0)==2&&ups[3]>0&&changes[3]>0);sequence(0,committed,4);CHECK(SendMessageW(combos[0],CB_SETCURSEL,0,0)==0);counts[0]=0;}
 if(stage==5){CHECK(GetCapture()==lists[0]&&SendMessageW(combos[0],CB_GETDROPPEDSTATE,0,0)&&info.stateButton==0);CHECK(downs[0]==2&&ups[0]==1);sequence(0,opened,1);}
 if(stage==6){CHECK(GetCapture()==NULL&&!SendMessageW(combos[0],CB_GETDROPPEDSTATE,0,0)&&cancels[3]==1);sequence(0,cancelled,3);counts[1]=0;}
 if(stage==7){CHECK(GetCapture()==lists[1]&&SendMessageW(combos[1],CB_GETCURSEL,0,0)==2);CHECK(moves[4]>0);sequence(1,opened,1);}
 if(stage==8){WCHAR text[32];CHECK(GetCapture()==NULL&&!SendMessageW(combos[1],CB_GETDROPPEDSTATE,0,0)&&SendMessageW(combos[1],CB_GETCURSEL,0,0)==CB_ERR);CHECK(GetWindowTextW(edits[1],text,32)==7);const WCHAR want[]=L"Typed \x03a9";for(unsigned i=0;i<8;i++)CHECK(text[i]==want[i]);sequence(1,cancelled,3);}
 if(stage==9){CHECK(GetCapture()==NULL&&SendMessageW(combos[2],CB_GETCURSEL,0,0)==0&&!SendMessageW(combos[2],CB_GETDROPPEDSTATE,0,0));CHECK(moves[5]>0&&downs[5]==0&&counts[2]==0);}
 if(stage==10){const unsigned selected[]={1};CHECK(GetCapture()==NULL&&SendMessageW(combos[2],CB_GETCURSEL,0,0)==1);CHECK(downs[5]==1&&ups[5]==1);sequence(2,selected,1);counts[0]=0;CHECK(SendMessageW(combos[0],CB_SETCURSEL,0,0)==0);}
 if(stage==11){
  CHECK(GetCapture()==NULL);
  CHECK(!SendMessageW(combos[0],CB_GETDROPPEDSTATE,0,0)&&info.stateButton==0);
  CHECK(SendMessageW(combos[0],CB_GETCURSEL,0,0)==2);
  CHECK(downs[0]==3&&downs[3]==2);
  /* One fake outside-dismissal up and two actual committed drag releases. */
  CHECK(ups[3]==3);
  sequence(0,committed,4);
 }
 const char *titles[]={"Popup hover verified","Outside dismissal verified","Arrow press verified","Capture handoff verified","Popup release verified","Arrow release verified","Native cancel verified","Editable hover verified","Editable dismissal verified","Simple hover verified","Simple pointer verified","Native popup checks complete"};CHECK(stage<12);SetWindowTextA(root,titles[stage++]);
}
static LRESULT CALLBACK subclass(HWND w,UINT msg,WPARAM wp,LPARAM lp){
 unsigned i=indexOf(w);if(msg==WM_KEYDOWN&&wp==VK_F6){verify();return 0;}if(msg==WM_KEYDOWN&&wp==VK_F7){CHECK(stage==6);SendMessageW(lists[0],WM_CANCELMODE,0,0);verify();return 0;}
 if(msg==WM_LBUTTONDOWN){downs[i]++;if(i==3)listDown=lp;}if(msg==WM_MOUSEMOVE)moves[i]++;if(msg==WM_LBUTTONUP)ups[i]++;if(msg==WM_CAPTURECHANGED)changes[i]++;if(msg==WM_CANCELMODE)cancels[i]++;
 LRESULT result=CallWindowProcW(originals[i],w,msg,wp,lp);if(i<2&&(msg==WM_LBUTTONDOWN||msg==WM_LBUTTONUP))CHECK(result==1);return result;
}
static LRESULT CALLBACK proc(HWND w,UINT msg,WPARAM wp,LPARAM lp){
 if(msg==WM_COMMAND){unsigned id=LOWORD(wp),code=HIWORD(wp);if(id>=70&&id<73){unsigned i=id-70;CHECK((HWND)lp==combos[i]);if(code==CBN_SELCHANGE||code==CBN_EDITCHANGE||code==CBN_EDITUPDATE||code==CBN_DROPDOWN||code==CBN_CLOSEUP||code==CBN_SELENDOK||code==CBN_SELENDCANCEL){if(i==1&&code==CBN_DROPDOWN){const unsigned typed[]={6,5};sequence(1,typed,2);counts[1]=0;}CHECK(counts[i]<16);events[i][counts[i]++]=code;if(code==CBN_SELCHANGE)CHECK(GetCapture()==NULL);}return 0;}}
 if(msg==WM_CLOSE){CHECK(stage==12);}
 if(msg==WM_DESTROY){PostQuitMessage(0);return 0;}return DefWindowProcW(w,msg,wp,lp);
}
void start(void){
 HINSTANCE instance=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.hInstance=instance;cls.lpfnWndProc=proc;cls.lpszClassName=L"NativeComboPointer";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);CHECK(RegisterClassW(&cls));root=CreateWindowW(cls.lpszClassName,L"Native popup starting",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,760,420,NULL,NULL,instance,NULL);CHECK(root);
 const WCHAR *names[]={L"Pointer dropdown",L"Pointer edit",L"Pointer simple"};const unsigned styles[]={CBS_DROPDOWNLIST,CBS_DROPDOWN,CBS_SIMPLE};
 for(unsigned i=0;i<3;i++){combos[i]=CreateWindowW(L"COMBOBOX",names[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP|WS_BORDER|styles[i],20+i*240,40,210,150,root,(HMENU)(70+i),instance,NULL);CHECK(combos[i]);const WCHAR *items[]={L"Apple",L"Banana",L"Cherry"};for(unsigned j=0;j<3;j++)CHECK((unsigned)SendMessageW(combos[i],CB_ADDSTRING,0,(LPARAM)items[j])==j);CHECK(SendMessageW(combos[i],CB_SETCURSEL,0,0)==0);COMBOBOXINFO info={0};info.cbSize=sizeof(info);CHECK(GetComboBoxInfo(combos[i],&info));lists[i]=info.hwndList;edits[i]=info.hwndItem;CHECK(lists[i]);originals[i]=(WNDPROC)SetWindowLongW(combos[i],GWL_WNDPROC,(LONG)subclass);originals[i+3]=(WNDPROC)SetWindowLongW(lists[i],GWL_WNDPROC,(LONG)subclass);CHECK(originals[i]&&originals[i+3]);if(edits[i]){originals[i+6]=(WNDPROC)SetWindowLongW(edits[i],GWL_WNDPROC,(LONG)subclass);CHECK(originals[i+6]);}}
 SetWindowTextA(root,"Native popup ready");MSG msg;while(GetMessageW(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}ExitProcess((UINT)msg.wParam);
}
