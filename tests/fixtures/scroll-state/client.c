/* Original WineBrowser contributors, MIT. Native SDK scrollbar state inspector. */
#define UNICODE
#include <windows.h>
#define CHECK(x) do{if(!(x))ExitProcess(1000+__LINE__);}while(0)
void *memset(void *target,int value,size_t count){BYTE *p=target;while(count--)*p++=(BYTE)value;return target;}
static HWND root,stateWindow,labels[5];
static unsigned stage;
static const WCHAR *titles[]={L"Native scroll state - Normal",L"Native scroll state - Range",L"Native scroll state - Move",L"Native scroll state - Page",L"Native scroll state - Reverse",L"Native scroll state - Limits",L"Native scroll state - Legacy",L"Native scroll state - Callback",L"Native scroll state - Normal"};
static WCHAR *text(WCHAR *out,const WCHAR *in){while(*in)*out++=*in++;return out;}
static WCHAR *number(WCHAR *out,DWORD value,BOOL negative){WCHAR digits[10];unsigned count=0;if(negative)*out++=L'-';do{digits[count++]=(WCHAR)(L'0'+value%10);value/=10;}while(value);while(count)*out++=digits[--count];return out;}
static void show(HWND label,const WCHAR *prefix,LONG value,BOOL unsignedValue){WCHAR buf[96],*end=text(buf,prefix);BOOL negative=!unsignedValue&&value<0;end=number(end,negative?0-(DWORD)value:(DWORD)value,negative);*end=0;CHECK(SetWindowTextW(label,buf));}
static void inspect(unsigned next){
    stage=next;SCROLLINFO input={sizeof(input),SIF_ALL,0,100,0,0,999};
    SetLastError(777);CHECK(SetScrollInfo(stateWindow,SB_HORZ,&input,FALSE)==0&&GetLastError()==777);
    LONG min=0,max=100,pos=0,track=0;UINT page=0;
    if(stage>=1&&stage<=4){input.nMin=10;input.nMax=40;input.nPage=8;input.nPos=50;SetLastError(777);CHECK(SetScrollInfo(stateWindow,SB_HORZ,&input,FALSE)==33&&GetLastError()==777);min=10;max=40;page=8;pos=track=33;}
    if(stage==2){SetLastError(777);CHECK(SetScrollPos(stateWindow,SB_HORZ,31,FALSE)==33&&GetLastError()==777);pos=track=31;}
    if(stage==3){input.fMask=SIF_PAGE;input.nPage=100;SetLastError(777);CHECK(SetScrollInfo(stateWindow,SB_HORZ,&input,FALSE)==10&&GetLastError()==777);page=31;pos=track=10;}
    if(stage==4){SetLastError(777);CHECK(SetScrollRange(stateWindow,SB_HORZ,40,10,FALSE)&&GetLastError()==777);min=max=pos=track=0;page=1;}
    if(stage==5){input.nMin=(-2147483647-1);input.nMax=2147483647;input.nPos=2147483647;SetLastError(777);CHECK(SetScrollInfo(stateWindow,SB_HORZ,&input,FALSE)==2147483647&&GetLastError()==777);min=input.nMin;max=pos=track=input.nMax;}
    if(stage==6){input.cbSize=24;input.fMask=SIF_RANGE|SIF_POS;input.nMin=-20;input.nMax=200;input.nPos=42;SetLastError(777);CHECK(SetScrollInfo(stateWindow,SB_HORZ,&input,FALSE)==42&&GetLastError()==777);min=-20;max=200;pos=track=42;}
    int bar=stage==7?SB_CTL:SB_HORZ;
    if(stage==7){SetLastError(777);CHECK(SetScrollInfo(stateWindow,bar,&input,FALSE)==-5&&GetLastError()==777);CHECK(SetScrollPos(stateWindow,bar,-12,TRUE)==-5);CHECK(SetScrollRange(stateWindow,bar,-20,60,FALSE));min=-7;max=33;page=4;pos=15;track=9;}
    SCROLLINFO out={sizeof(out),SIF_ALL,1,2,3,4,5};SetLastError(777);
    CHECK(GetScrollInfo(stateWindow,bar,&out)&&GetLastError()==777);
    CHECK(out.cbSize==28&&out.fMask==SIF_ALL&&out.nMin==min&&out.nMax==max&&out.nPage==page&&out.nPos==pos&&out.nTrackPos==track);
    int a=1,b=2;SetLastError(777);CHECK(GetScrollRange(stateWindow,bar,&a,&b)&&GetLastError()==777&&a==min&&b==max);
    SetLastError(777);CHECK(GetScrollPos(stateWindow,bar)==(stage==7?-15:pos)&&GetLastError()==777);
    SCROLLINFO old={24,SIF_ALL,1,2,3,4,0x12345678};if(stage!=7){CHECK(GetScrollInfo(stateWindow,bar,&old)&&old.nTrackPos==0x12345678&&old.nPos==pos);}
    show(labels[0],L"Minimum: ",out.nMin,FALSE);show(labels[1],L"Maximum: ",out.nMax,FALSE);show(labels[2],L"Page: ",out.nPage,TRUE);show(labels[3],L"Position: ",out.nPos,FALSE);show(labels[4],L"Track position: ",out.nTrackPos,FALSE);
    CHECK(SetWindowTextW(root,titles[stage]));
}
static LRESULT CALLBACK procedure(HWND window,UINT msg,WPARAM wp,LPARAM lp){
    if(window==stateWindow){
        if(msg==SBM_SETSCROLLINFO){SCROLLINFO *in=(SCROLLINFO *)lp;CHECK(in&&in->cbSize==28);if(in->fMask==SIF_POS)CHECK(in->nPos==-12&&wp==TRUE);if(in->fMask==SIF_RANGE)CHECK(in->nMin==-20&&in->nMax==60&&wp==FALSE);return -5;}
        if(msg==SBM_GETSCROLLINFO){SCROLLINFO *out=(SCROLLINFO *)lp;CHECK(out);out->nMin=-7;out->nMax=33;out->nPage=4;out->nPos=15;out->nTrackPos=9;return 0;}
        if(msg==SBM_GETRANGE){*(int *)wp=-7;*(int *)lp=33;return 0;}
        if(msg==SBM_GETPOS)return -15;
    }
    if(window==root&&msg==WM_COMMAND&&HIWORD(wp)==BN_CLICKED&&LOWORD(wp)>=101&&LOWORD(wp)<=109){inspect(LOWORD(wp)-101);return 0;}
    if(window==root&&msg==WM_PAINT){PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);RECT rect={0,0,640,320};CHECK(FillRect(dc,&rect,(HBRUSH)GetStockObject(WHITE_BRUSH))&&EndPaint(window,&ps));return 0;}
    if(window==root&&(msg==WM_CLOSE||(msg==WM_KEYDOWN&&wp==VK_ESCAPE))){PostQuitMessage(0);return 0;}
    return DefWindowProcW(window,msg,wp,lp);
}
void start(void){
    CHECK(!lstrcmpW(L"scroll",L"scroll"));WNDCLASSW cls={0};cls.lpfnWndProc=procedure;cls.hInstance=GetModuleHandleW(NULL);cls.hCursor=LoadCursorW(NULL,IDC_ARROW);cls.lpszClassName=L"NativeScrollStateInspector";CHECK(RegisterClassW(&cls));
    root=CreateWindowExW(0,cls.lpszClassName,L"Native scroll state",WS_POPUP|WS_CAPTION|WS_SYSMENU|WS_VISIBLE,40,60,642,350,NULL,NULL,cls.hInstance,NULL);CHECK(root);
    stateWindow=CreateWindowExW(0,cls.lpszClassName,L"Hidden scrollbar state",WS_POPUP,0,0,100,100,NULL,NULL,cls.hInstance,NULL);CHECK(stateWindow);
    const WCHAR *buttons[]={L"Normal",L"Range",L"Move",L"Page",L"Reverse",L"Limits",L"Legacy",L"Callback",L"Reset"};
    for(int i=0;i<9;i++)CHECK(CreateWindowExW(0,L"BUTTON",buttons[i],WS_CHILD|WS_VISIBLE|BS_PUSHBUTTON,12+(i%5)*124,8+(i/5)*36,116,28,root,(HMENU)(INT_PTR)(101+i),cls.hInstance,NULL));
    CHECK(CreateWindowExW(0,L"STATIC",L"Inspect native range, page and position rules.",WS_CHILD|WS_VISIBLE|SS_CENTER,8,74,624,22,root,NULL,cls.hInstance,NULL));
    for(int i=0;i<5;i++){labels[i]=CreateWindowExW(0,L"STATIC",L"",WS_CHILD|WS_VISIBLE|SS_LEFT,28,112+i*36,590,30,root,(HMENU)(INT_PTR)(201+i),cls.hInstance,NULL);CHECK(labels[i]);}
    inspect(0);ShowWindow(root,SW_SHOW);CHECK(UpdateWindow(root));MSG msg;while(GetMessageW(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}
    CHECK(DestroyWindow(stateWindow)&&DestroyWindow(root));const char output[]="NATIVE SCROLL STATE GUI PASS\n";DWORD wrote=0;CHECK(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),output,sizeof(output)-1,&wrote,NULL)&&wrote==sizeof(output)-1);ExitProcess(0);
}
