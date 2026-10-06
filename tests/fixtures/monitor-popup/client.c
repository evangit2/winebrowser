/* Authored MIT PE32 acceptance: monitor ABI, display modes and upward popups. */
#define COBJMACROS
#include <windows.h>
#include <d3d9.h>
#include <dxgi.h>
#include <stddef.h>
#define CHECK(x) do { if (!(x)) ExitProcess(1000+__LINE__); } while (0)
_Static_assert(sizeof(DXGI_OUTPUT_DESC)==92,"PE32 DXGI output size");
_Static_assert(offsetof(DXGI_OUTPUT_DESC,DesktopCoordinates)==64,"DXGI RECT offset");
_Static_assert(offsetof(DXGI_OUTPUT_DESC,AttachedToDesktop)==80,"DXGI attached offset");
_Static_assert(offsetof(DXGI_OUTPUT_DESC,Rotation)==84,"DXGI rotation offset");
_Static_assert(offsetof(DXGI_OUTPUT_DESC,Monitor)==88,"DXGI HMONITOR offset");
static HWND root,combos[3],lists[3],edits[3];
static WNDPROC originals[9];
static unsigned stage,displayChanges,settingChanges,events[3][16],counts[3],listDowns[3],listMoves[3],listUps[3],listCancels[3];
static LPARAM lastDown[3];
static HMONITOR monitor;
static IDXGIFactory1 *factory;static IDXGIAdapter *adapter;static IDXGIOutput *output;
/* D3D8 and D3D9 headers declare conflicting shared names; this calls the actual
   D3D8 import and its SDK-defined PE32 vtable slots without including both. */
typedef struct { void **lpVtbl; } D3D8Object;
__declspec(dllimport) D3D8Object *WINAPI Direct3DCreate8(UINT);
typedef HMONITOR (WINAPI *AdapterMonitor8)(D3D8Object*,UINT);
typedef ULONG (WINAPI *Release8)(D3D8Object*);
static D3D8Object *d3d8;static IDirect3D9 *d3d9;
static const GUID factoryIID={0x770aae78,0xf26f,0x4dba,{0xa8,0x29,0x25,0x3c,0x83,0xd1,0xb3,0x87}};
static BOOL sameRect(const RECT *a,const RECT *b){return a->left==b->left&&a->top==b->top&&a->right==b->right&&a->bottom==b->bottom;}
static void checkParameters(void){
 const UINT actions[]={SPI_GETBEEP,SPI_GETBORDER,SPI_GETKEYBOARDSPEED,SPI_GETSCREENSAVETIMEOUT,SPI_GETKEYBOARDDELAY,SPI_GETICONTITLEWRAP,SPI_GETDRAGFULLWINDOWS,SPI_GETKEYBOARDPREF,SPI_GETSCREENREADER,SPI_GETMOUSETRAILS,SPI_GETMOUSEHOVERHEIGHT,SPI_GETWHEELSCROLLLINES,SPI_GETMENUSHOWDELAY,SPI_GETMENUANIMATION};
 const DWORD values[]={1,1,31,600,1,1,1,0,0,0,4,3,400,0};
 for(unsigned i=0;i<sizeof(actions)/sizeof(actions[0]);i++){struct{DWORD value,tail;} out;out.value=0xcccccccc;out.tail=0xfeed1234;CHECK(SystemParametersInfoA(actions[i],0,&out.value,0)&&out.value==values[i]&&out.tail==0xfeed1234);out.value=0xcccccccc;CHECK(SystemParametersInfoW(actions[i],0,&out.value,0)&&out.value==values[i]&&out.tail==0xfeed1234);}
 struct{int values[3];DWORD tail;} mouse={{8,12,2},0xfeed1234};CHECK(SystemParametersInfoW(SPI_SETMOUSE,0,mouse.values,0));mouse.values[0]=mouse.values[1]=mouse.values[2]=0;CHECK(SystemParametersInfoA(SPI_GETMOUSE,0,mouse.values,0)&&mouse.values[0]==8&&mouse.values[1]==12&&mouse.values[2]==2&&mouse.tail==0xfeed1234);mouse.values[0]=6;mouse.values[1]=10;mouse.values[2]=1;CHECK(SystemParametersInfoW(SPI_SETMOUSE,0,mouse.values,0));
 struct{NONCLIENTMETRICSA value;DWORD tail;} na;struct{NONCLIENTMETRICSW value;DWORD tail;} nw;na.value.cbSize=sizeof(na.value);na.tail=0xfeed1234;nw.value.cbSize=sizeof(nw.value);nw.tail=0xfeed5678;CHECK(SystemParametersInfoA(SPI_GETNONCLIENTMETRICS,sizeof(na.value),&na.value,0)&&SystemParametersInfoW(SPI_GETNONCLIENTMETRICS,sizeof(nw.value),&nw.value,0));CHECK(na.tail==0xfeed1234&&nw.tail==0xfeed5678&&na.value.iBorderWidth==1&&nw.value.iBorderWidth==1&&na.value.lfMessageFont.lfHeight==-12&&nw.value.lfMessageFont.lfHeight==-12);
 na.value.cbSize=sizeof(na.value)-4;na.value.iPaddedBorderWidth=0xbeef;nw.value.cbSize=sizeof(nw.value)-4;nw.value.iPaddedBorderWidth=0xbeef;CHECK(SystemParametersInfoA(SPI_GETNONCLIENTMETRICS,sizeof(na.value)-4,&na.value,0)&&SystemParametersInfoW(SPI_GETNONCLIENTMETRICS,sizeof(nw.value)-4,&nw.value,0));CHECK(na.value.iPaddedBorderWidth==0xbeef&&nw.value.iPaddedBorderWidth==0xbeef&&na.tail==0xfeed1234&&nw.tail==0xfeed5678);
 struct{LOGFONTA value;DWORD tail;} fa;struct{LOGFONTW value;DWORD tail;} fw;fa.tail=0xfeed1234;fw.tail=0xfeed5678;CHECK(SystemParametersInfoA(SPI_GETICONTITLELOGFONT,0,&fa.value,0)&&SystemParametersInfoW(SPI_GETICONTITLELOGFONT,0,&fw.value,0)&&fa.value.lfHeight==-12&&fw.value.lfHeight==-12&&fa.tail==0xfeed1234&&fw.tail==0xfeed5678);
}
static void checkDisplay(unsigned width,unsigned height){
 CHECK((unsigned)GetSystemMetrics(SM_CXSCREEN)==width&&(unsigned)GetSystemMetrics(SM_CYSCREEN)==height);
 struct {MONITORINFOEXA value;DWORD tail;} a;struct {MONITORINFOEXW value;DWORD tail;} w;
 a.value.cbSize=sizeof(a.value);a.tail=0xfeed1234;w.value.cbSize=sizeof(w.value);w.tail=0xfeed5678;
 CHECK(GetMonitorInfoA(monitor,(MONITORINFO*)&a.value)&&GetMonitorInfoW(monitor,(MONITORINFO*)&w.value));
 CHECK(a.tail==0xfeed1234&&w.tail==0xfeed5678&&a.value.cbSize==sizeof(a.value)&&w.value.cbSize==sizeof(w.value));
 const char *device="\\\\.\\DISPLAY1";for(unsigned i=0;i<13;i++)CHECK(a.value.szDevice[i]==device[i]&&w.value.szDevice[i]==(WCHAR)device[i]);
 RECT area;CHECK(SystemParametersInfoW(SPI_GETWORKAREA,0,&area,0)&&sameRect(&area,&a.value.rcMonitor)&&sameRect(&area,&a.value.rcWork)&&sameRect(&area,&w.value.rcMonitor)&&sameRect(&area,&w.value.rcWork));
 CHECK(area.left==0&&area.top==0&&(unsigned)area.right==width&&(unsigned)area.bottom==height&&a.value.dwFlags==MONITORINFOF_PRIMARY&&w.value.dwFlags==MONITORINFOF_PRIMARY);
 struct {DXGI_OUTPUT_DESC value;DWORD tail;} desc;desc.tail=0xface5678;
 CHECK(IDXGIOutput_GetDesc(output,&desc.value)==S_OK&&desc.tail==0xface5678);
 CHECK(sameRect(&desc.value.DesktopCoordinates,&area)&&desc.value.AttachedToDesktop&&desc.value.Rotation==DXGI_MODE_ROTATION_IDENTITY&&desc.value.Monitor==monitor);
 for(unsigned i=0;i<13;i++)CHECK(desc.value.DeviceName[i]==w.value.szDevice[i]);
 CHECK(IDirect3D9_GetAdapterMonitor(d3d9,0)==monitor&&IDirect3D9_GetAdapterMonitor(d3d9,1)==NULL);
 CHECK(((AdapterMonitor8)d3d8->lpVtbl[14])(d3d8,0)==monitor&&((AdapterMonitor8)d3d8->lpVtbl[14])(d3d8,1)==NULL);
 POINT point={(LONG)width-1,(LONG)height-1};CHECK(MonitorFromPoint(point,MONITOR_DEFAULTTONULL)==monitor);point.x=(LONG)width;CHECK(MonitorFromPoint(point,MONITOR_DEFAULTTONULL)==NULL);point.x=-1;point.y=-1;CHECK(MonitorFromPoint(point,0)==NULL&&MonitorFromPoint(point,MONITOR_DEFAULTTOPRIMARY)==monitor);
 RECT outside={(LONG)width+5,10,(LONG)width+20,20};CHECK(MonitorFromRect(&outside,0)==NULL&&MonitorFromRect(&outside,MONITOR_DEFAULTTONEAREST)==monitor);
 if(root)CHECK(MonitorFromWindow(root,MONITOR_DEFAULTTONEAREST)==monitor);
}
static void mode(unsigned width,unsigned height){DEVMODEA dm;BOOL found=FALSE;for(unsigned i=0;i<16&&EnumDisplaySettingsA(NULL,i,&dm);i++)if(dm.dmPelsWidth==width&&dm.dmPelsHeight==height&&dm.dmBitsPerPel==32){found=TRUE;break;}CHECK(found);CHECK(ChangeDisplaySettingsA(&dm,CDS_TEST)==DISP_CHANGE_SUCCESSFUL);CHECK(ChangeDisplaySettingsA(&dm,0)==DISP_CHANGE_SUCCESSFUL);checkDisplay(width,height);CHECK(SetWindowPos(root,HWND_TOP,30,(int)height-145,600,136,SWP_NOACTIVATE));for(unsigned i=0;i<3;i++)CHECK(SendMessageW(combos[i],CB_SETCURSEL,0,0)==0);}
static void popup(unsigned i,unsigned width,unsigned height,BOOL oversized){
 checkDisplay(width,height);RECT host,list,work;CHECK(GetWindowRect(combos[i],&host)&&GetWindowRect(lists[i],&list)&&SystemParametersInfoA(SPI_GETWORKAREA,0,&work,0));
 CHECK(list.top>=work.top&&list.bottom<=work.bottom&&list.left>=work.left&&list.right<=work.right&&SendMessageW(combos[i],CB_GETDROPPEDSTATE,0,0));
 if(oversized){CHECK(list.top==work.top&&list.bottom==work.bottom);}else{CHECK(list.bottom==host.top);}
}
static void sequence(unsigned i,const unsigned *want,unsigned n){CHECK(counts[i]==n);for(unsigned j=0;j<n;j++)CHECK(events[i][j]==want[j]);}
static void verify(void){
 const unsigned opened[]={7},committed[]={7,1,9,8},canceled[]={7,10,8};
 if(stage==0){popup(0,1024,768,FALSE);CHECK(GetCapture()==lists[0]&&SendMessageW(combos[0],CB_GETCURSEL,0,0)==3);sequence(0,opened,1);}
 if(stage==1){CHECK(GetCapture()==NULL&&SendMessageW(combos[0],CB_GETCURSEL,0,0)==5&&displayChanges==0);sequence(0,committed,4);counts[0]=0;CHECK(SystemParametersInfoW(SPI_SETKEYBOARDSPEED,9,NULL,SPIF_SENDCHANGE));DWORD speed;CHECK(SystemParametersInfoA(SPI_GETKEYBOARDSPEED,0,&speed,0)&&speed==9);CHECK(SystemParametersInfoW(SPI_SETKEYBOARDSPEED,31,NULL,0));mode(800,600);}
 if(stage==2){popup(0,800,600,FALSE);CHECK(GetCapture()==lists[0]&&SendMessageW(combos[0],CB_GETCURSEL,0,0)==1&&displayChanges>=1&&settingChanges==1);sequence(0,opened,1);}
 if(stage==3){CHECK(GetCapture()==NULL&&!SendMessageW(combos[0],CB_GETDROPPEDSTATE,0,0));sequence(0,canceled,3);counts[0]=0;mode(640,480);}
 if(stage==4){popup(0,640,480,FALSE);COMBOBOXINFO info={0};info.cbSize=sizeof(info);CHECK(GetComboBoxInfo(combos[0],&info)&&info.stateButton==STATE_SYSTEM_PRESSED&&GetCapture()==combos[0]&&displayChanges>=2);sequence(0,opened,1);}
 if(stage==5){CHECK(GetCapture()==NULL&&!SendMessageW(combos[0],CB_GETDROPPEDSTATE,0,0)&&SendMessageW(combos[0],CB_GETCURSEL,0,0)==3&&listDowns[0]>=2&&listMoves[0]>0&&listUps[0]>=2);RECT row;CHECK(SendMessageW(lists[0],LB_GETITEMRECT,3,(LPARAM)&row)==0);CHECK((SHORT)LOWORD(lastDown[0])>=0&&(SHORT)HIWORD(lastDown[0])>=row.top&&(SHORT)HIWORD(lastDown[0])<row.bottom);sequence(0,committed,4);}
 if(stage==6){popup(2,640,480,TRUE);CHECK(GetCapture()==lists[2]);}
 if(stage==7){popup(1,640,480,FALSE);CHECK(GetCapture()==lists[1]&&SendMessageW(combos[1],CB_GETCURSEL,0,0)==3&&listCancels[2]==1);sequence(1,opened,1);}
 if(stage==8){WCHAR text[32];CHECK(GetCapture()==NULL&&!SendMessageW(combos[1],CB_GETDROPPEDSTATE,0,0)&&SendMessageW(combos[1],CB_GETCURSEL,0,0)==CB_ERR);CHECK(GetWindowTextW(edits[1],text,32)==7);const WCHAR typed[]=L"Typed \x03a9";for(unsigned i=0;i<8;i++)CHECK(text[i]==typed[i]);sequence(1,canceled,3);CHECK(ChangeDisplaySettingsA(NULL,0)==DISP_CHANGE_SUCCESSFUL);checkDisplay(1024,768);CHECK(SetWindowPos(root,HWND_TOP,30,80,600,136,SWP_NOACTIVATE));}
 const char *titles[]={"1024 popup verified","800x600 popup ready","800 popup verified","640x480 popup ready","640 arrow verified","640 drag verified","Oversized popup verified","Editable upward popup verified","Monitor popup checks complete"};CHECK(stage<9);SetWindowTextA(root,titles[stage++]);
}
static unsigned indexOf(HWND hwnd){for(unsigned i=0;i<3;i++){if(hwnd==combos[i])return i;if(hwnd==lists[i])return i+3;if(edits[i]&&hwnd==edits[i])return i+6;}CHECK(0);return 0;}
static LRESULT CALLBACK subclass(HWND hwnd,UINT msg,WPARAM wp,LPARAM lp){unsigned i=indexOf(hwnd);if(msg==WM_KEYDOWN&&wp==VK_F6){verify();return 0;}if(msg==WM_KEYDOWN&&wp==VK_F7){CHECK(stage==7);SendMessageW(lists[2],WM_CANCELMODE,0,0);CHECK(GetCapture()==NULL&&!SendMessageW(combos[2],CB_GETDROPPEDSTATE,0,0));return 0;}if(i>=3&&i<6){unsigned j=i-3;if(msg==WM_LBUTTONDOWN){listDowns[j]++;lastDown[j]=lp;}if(msg==WM_MOUSEMOVE)listMoves[j]++;if(msg==WM_LBUTTONUP)listUps[j]++;if(msg==WM_CANCELMODE)listCancels[j]++;}return CallWindowProcW(originals[i],hwnd,msg,wp,lp);}
static LRESULT CALLBACK proc(HWND hwnd,UINT msg,WPARAM wp,LPARAM lp){
 if(msg==WM_SETTINGCHANGE){CHECK(wp==SPI_SETKEYBOARDSPEED);settingChanges++;return 0;}
 if(msg==WM_DISPLAYCHANGE){CHECK((wp==32||wp==16)&&LOWORD(lp)==GetSystemMetrics(SM_CXSCREEN)&&HIWORD(lp)==GetSystemMetrics(SM_CYSCREEN));displayChanges++;return 0;}
 if(msg==WM_COMMAND){unsigned id=LOWORD(wp),code=HIWORD(wp);if(id>=70&&id<73){unsigned i=id-70;CHECK((HWND)lp==combos[i]);if(code==CBN_DROPDOWN||code==CBN_SELCHANGE||code==CBN_SELENDOK||code==CBN_SELENDCANCEL||code==CBN_CLOSEUP){CHECK(counts[i]<16);events[i][counts[i]++]=code;if(code==CBN_SELCHANGE)CHECK(GetCapture()==NULL);}return 0;}}
 if(msg==WM_CLOSE){CHECK(stage==9&&displayChanges>=3&&GetCapture()==NULL);CHECK(IDXGIOutput_Release(output)==0);IDXGIAdapter_Release(adapter);IDXGIFactory1_Release(factory);CHECK(IDirect3D9_Release(d3d9)==0&&((Release8)d3d8->lpVtbl[2])(d3d8)==0);}
 if(msg==WM_DESTROY){PostQuitMessage(0);return 0;}return DefWindowProcW(hwnd,msg,wp,lp);
}
void start(void){
 POINT origin={0,0};monitor=MonitorFromPoint(origin,0);CHECK(monitor);CHECK(CreateDXGIFactory1(&factoryIID,(void**)&factory)==S_OK&&IDXGIFactory1_EnumAdapters(factory,0,&adapter)==S_OK&&IDXGIAdapter_EnumOutputs(adapter,0,&output)==S_OK);d3d8=Direct3DCreate8(220);d3d9=Direct3DCreate9(D3D_SDK_VERSION);CHECK(d3d8&&d3d9);checkDisplay(1024,768);checkParameters();
 MONITORINFO invalid={0};invalid.cbSize=sizeof(invalid);SetLastError(0);CHECK(!GetMonitorInfoW(NULL,&invalid)&&GetLastError()==ERROR_INVALID_MONITOR_HANDLE&&invalid.cbSize==sizeof(invalid));
 HINSTANCE instance=GetModuleHandleW(NULL);WNDCLASSW cls={0};cls.hInstance=instance;cls.lpfnWndProc=proc;cls.lpszClassName=L"MonitorPopup";cls.hbrBackground=(HBRUSH)(COLOR_BTNFACE+1);CHECK(RegisterClassW(&cls));root=CreateWindowW(cls.lpszClassName,L"Monitor popup starting",WS_OVERLAPPEDWINDOW|WS_VISIBLE,30,623,600,136,NULL,NULL,instance,NULL);CHECK(root);
 const WCHAR *names[]={L"Monitor dropdown",L"Monitor edit",L"Monitor oversized"};const WCHAR *items[]={L"Apple",L"Banana",L"Cherry",L"Date",L"Elderberry",L"Fig",L"Grape",L"Honeydew"};
 for(unsigned i=0;i<3;i++){combos[i]=CreateWindowW(L"COMBOBOX",names[i],WS_CHILD|WS_VISIBLE|WS_TABSTOP|WS_BORDER|(i==1?CBS_DROPDOWN:CBS_DROPDOWNLIST),20+i*210,35,i==2?140:180,i==2?1400:170,root,(HMENU)(70+i),instance,NULL);CHECK(combos[i]);for(unsigned j=0;j<8;j++)CHECK((unsigned)SendMessageW(combos[i],CB_ADDSTRING,0,(LPARAM)items[j])==j);CHECK(SendMessageW(combos[i],CB_SETCURSEL,0,0)==0);COMBOBOXINFO info={0};info.cbSize=sizeof(info);CHECK(GetComboBoxInfo(combos[i],&info));lists[i]=info.hwndList;edits[i]=info.hwndItem;originals[i]=(WNDPROC)SetWindowLongW(combos[i],GWL_WNDPROC,(LONG)subclass);originals[i+3]=(WNDPROC)SetWindowLongW(lists[i],GWL_WNDPROC,(LONG)subclass);CHECK(originals[i]&&originals[i+3]);if(edits[i]){originals[i+6]=(WNDPROC)SetWindowLongW(edits[i],GWL_WNDPROC,(LONG)subclass);CHECK(originals[i+6]);}}
 SetWindowTextA(root,"Monitor popup ready");MSG msg;while(GetMessageW(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageW(&msg);}ExitProcess((UINT)msg.wParam);
}
