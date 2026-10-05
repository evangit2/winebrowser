/* Authored MIT PE32 acceptance: native pointer tracking, capture and timers. */
#include <windows.h>
#define WM_SYSTIMER 0x118
#define WM_LBTRACKPOINT 0x131
#define CHECK(x) do { if (!(x)) ExitProcess(1000+__LINE__); } while (0)
static HWND root,lists[4],combo,comboList;static WNDPROC originals[4];static unsigned downs[4],moves[4],ups[4],systemTicks[4],notifications[4],tracks[4],userTicks,stage,canceled,captureTransfers;
static unsigned mask(HWND w){unsigned result=0;for(unsigned i=0;i<12;i++)if(SendMessageW(w,LB_GETSEL,i,0)>0)result|=1u<<i;return result;}
static LRESULT CALLBACK subclass(HWND w,UINT msg,WPARAM wp,LPARAM lp){unsigned i=0;while(i<4&&w!=lists[i])i++;CHECK(i<4);if(msg==WM_KEYDOWN&&wp==VK_F6){SendMessageW(w,WM_CANCELMODE,0,0);CHECK(GetCapture()==NULL);canceled++;return 0;}if(msg==WM_KEYDOWN&&wp==VK_F7){CHECK((HWND)SetCapture(root)==w&&GetCapture()==root);CHECK(ReleaseCapture()&&GetCapture()==NULL);captureTransfers++;return 0;}if(msg==WM_LBUTTONDOWN)downs[i]++;if(msg==WM_MOUSEMOVE)moves[i]++;if(msg==WM_LBUTTONUP)ups[i]++;if(msg==WM_SYSTIMER)systemTicks[i]++;if(i==3&&msg==WM_TIMER&&wp==2){userTicks++;return 0;}return CallWindowProcW(originals[i],w,msg,wp,lp);}
static void verify(unsigned step){
 CHECK(GetCapture()==NULL);
 if(step==0){CHECK(SendMessageW(lists[0],LB_GETCURSEL,0,0)==2&&downs[0]>=1&&moves[0]>=1&&ups[0]>=1&&tracks[0]>=1&&notifications[0]>=1);}
 if(step==1){CHECK(mask(lists[1])==6&&SendMessageW(lists[1],LB_GETANCHORINDEX,0,0)==1&&SendMessageW(lists[1],LB_GETCARETINDEX,0,0)==2);}
 if(step==2){CHECK(mask(lists[2])==2&&SendMessageW(lists[2],LB_GETCARETINDEX,0,0)==3);}
 if(step==3){CHECK(mask(lists[3])==15&&SendMessageW(lists[3],LB_GETCARETINDEX,0,0)==3);}
 if(step==4){CHECK(SendMessageW(lists[3],LB_GETTOPINDEX,0,0)>1&&SendMessageW(lists[3],LB_GETCARETINDEX,0,0)>=7&&systemTicks[3]>0&&userTicks>0);}
 if(step==5){CHECK(mask(lists[1])==56);}
 if(step==6){CHECK(mask(lists[1])==120&&SendMessageW(lists[1],LB_GETANCHORINDEX,0,0)==3);}
 if(step==7){CHECK(SendMessageW(combo,CB_GETCURSEL,0,0)==2&&!SendMessageW(combo,CB_GETDROPPEDSTATE,0,0));}
 const char *titles[10]={"Single pointer verified","Extended shrink verified","Multiple caret verified","Variable pointer verified","Stationary autoscroll verified","Control pointer verified","Shift pointer verified","Combo pointer verified","Native cancel mode verified","Native pointer checks complete"};if(step==8){CHECK(canceled==1);}if(step==9){CHECK(captureTransfers==1);}stage=step+1;SetWindowTextA(root,titles[step]);
}
static LRESULT CALLBACK proc(HWND w,UINT msg,WPARAM wp,LPARAM lp){
 if(msg==WM_MEASUREITEM){MEASUREITEMSTRUCT *m=(MEASUREITEMSTRUCT*)lp;CHECK(m->CtlID==73&&m->CtlType==ODT_LISTBOX);m->itemHeight=18+(m->itemID%3)*8;return TRUE;}
 if(msg==WM_DRAWITEM){DRAWITEMSTRUCT *d=(DRAWITEMSTRUCT*)lp;CHECK(d->CtlID==73&&d->hwndItem==lists[3]);HBRUSH brush=CreateSolidBrush((d->itemState&ODS_SELECTED)?RGB(24,100,200):RGB(90,140,90));CHECK(brush&&FillRect(d->hDC,&d->rcItem,brush)&&DeleteObject(brush));CHECK(SetBkMode(d->hDC,TRANSPARENT));SetTextColor(d->hDC,RGB(255,255,255));WCHAR text[16];CHECK(SendMessageW(d->hwndItem,LB_GETTEXT,d->itemID,(LPARAM)text)>0);CHECK(TextOutW(d->hDC,6,d->rcItem.top+2,text,5));return TRUE;}
 if(msg==WM_LBTRACKPOINT){unsigned i=0;HWND focus=GetFocus();while(i<4&&lists[i]!=focus)i++;CHECK(i<4);tracks[i]++;return 0;}
 if(msg==WM_COMMAND){unsigned id=LOWORD(wp),code=HIWORD(wp);if(id>=70&&id<74&&code==LBN_SELCHANGE){CHECK((HWND)lp==lists[id-70]&&GetCapture()!=lists[id-70]);notifications[id-70]++;return 0;}if(code==BN_CLICKED&&id>=80&&id<90){CHECK(id-80==stage);verify(stage);return 0;}}
 if(msg==WM_CLOSE){CHECK(stage==10);for(unsigned i=0;i<4;i++){CHECK(downs[i]>0&&moves[i]>0&&ups[i]>0&&notifications[i]>0&&tracks[i]>0);}CHECK(KillTimer(lists[3],2));}
 if(msg==WM_DESTROY){PostQuitMessage(0);return 0;}return DefWindowProcW(w,msg,wp,lp);
}
void start(void){HINSTANCE instance=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.hInstance=instance;cls.lpfnWndProc=proc;cls.lpszClassName=L"NativeListPointer";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);CHECK(RegisterClassW(&cls));root=CreateWindowW(cls.lpszClassName,L"Native pointer starting",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,950,520,NULL,NULL,instance,NULL);CHECK(root);
 const WCHAR *names[4]={L"Native single",L"Native extended",L"Native multiple",L"Variable pointer"};unsigned styles[4]={0,LBS_EXTENDEDSEL,LBS_MULTIPLESEL,LBS_EXTENDEDSEL|LBS_OWNERDRAWVARIABLE|LBS_HASSTRINGS};
 HFONT font=(HFONT)GetStockObject(SYSTEM_FONT);CHECK(font);
 for(unsigned i=0;i<4;i++){lists[i]=CreateWindowW(L"LISTBOX",names[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP|WS_BORDER|LBS_NOTIFY|styles[i],20+i*230,30,210,180,root,(HMENU)(70+i),instance,NULL);CHECK(lists[i]);SendMessageW(lists[i],WM_SETFONT,(WPARAM)font,TRUE);for(unsigned j=0;j<12;j++){WCHAR text[16]={L'R',L'o',L'w',L' ',(WCHAR)(L'A'+j),0};CHECK((unsigned)SendMessageW(lists[i],LB_ADDSTRING,0,(LPARAM)text)==j);}originals[i]=(WNDPROC)SetWindowLongW(lists[i],GWL_WNDPROC,(LONG)subclass);CHECK(originals[i]);}
 CHECK(SetTimer(lists[3],2,30,NULL)==2);
 combo=CreateWindowW(L"COMBOBOX",L"Pointer combo",WS_CHILD|WS_VISIBLE|WS_TABSTOP|WS_BORDER|CBS_DROPDOWNLIST,20,240,210,150,root,(HMENU)74,instance,NULL);CHECK(combo);for(unsigned j=0;j<3;j++){const WCHAR *text[3]={L"Apple",L"Banana",L"Cherry"};CHECK((unsigned)SendMessageW(combo,CB_ADDSTRING,0,(LPARAM)text[j])==j);}CHECK(SendMessageW(combo,CB_SETCURSEL,0,0)==0);COMBOBOXINFO info={0};info.cbSize=sizeof(info);CHECK(GetComboBoxInfo(combo,&info));comboList=info.hwndList;CHECK(comboList);
 const char *labels[10]={"Verify single drag","Verify extended shrink","Verify multiple caret","Verify variable rows","Verify stationary autoscroll","Verify Control drag","Verify Shift drag","Verify combo drag","Verify cancel mode","Verify capture transfer"};for(unsigned i=0;i<10;i++)CHECK(CreateWindowA("BUTTON",labels[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP,20+(i%4)*230,300+(i/4)*42,215,32,root,(HMENU)(80+i),instance,NULL));SetWindowTextA(root,"Native pointer ready");MSG msg;while(GetMessageW(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}ExitProcess((UINT)msg.wParam);
}
