#include <windows.h>
#include <commdlg.h>
static UINT colorOK;
static int notices;
static CHOOSECOLORA *active;
static LRESULT CALLBACK proc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  if(msg == colorOK) {
    CHOOSECOLORA *cc=(CHOOSECOLORA*)lp;
    if(cc != active || IsWindowEnabled(hwnd)) ExitProcess(20);
    notices++;
    if(notices == 1) { if(cc->rgbResult != RGB(20,80,160)) ExitProcess(21);return 1; }
    if(cc->rgbResult != RGB(40,120,200)) ExitProcess(22);
    return 0;
  }
  return DefWindowProcA(hwnd,msg,wp,lp);
}
void start(void) {
  COLORREF palette[16];
  CHOOSECOLORA cc={0};
  WNDCLASSA wc={0};
  HWND owner;
  int i;
  wc.lpfnWndProc=proc;wc.hInstance=GetModuleHandleA(NULL);wc.lpszClassName="NativeColorOwner";
  if(!RegisterClassA(&wc)) ExitProcess(1);
  owner=CreateWindowExA(0,wc.lpszClassName,"Native color picker",WS_OVERLAPPEDWINDOW,20,20,250,100,NULL,NULL,wc.hInstance,NULL);
  if(!owner) ExitProcess(2);
  colorOK=RegisterWindowMessageA(COLOROKSTRINGA);
  for(i=0;i<16;i++)palette[i]=0xffffffff;
  cc.lStructSize=sizeof(cc);cc.hwndOwner=owner;cc.lpCustColors=palette;cc.rgbResult=RGB(1,2,3);cc.Flags=CC_RGBINIT|CC_FULLOPEN;
  active=&cc;
  if(ChooseColorA(&cc) || cc.rgbResult!=RGB(1,2,3) || CommDlgExtendedError() || !IsWindowEnabled(owner)) ExitProcess(3);
  for(i=0;i<16;i++)if(palette[i]!=0xffffffff)ExitProcess(4);
  if(!ChooseColorA(&cc) || cc.rgbResult!=RGB(40,120,200) || notices!=2 || !IsWindowEnabled(owner)) ExitProcess(5);
  if(palette[0]!=RGB(20,80,160) || palette[8]!=RGB(40,120,200))ExitProcess(6);
  cc.rgbResult=RGB(1,2,3);
  if(ChooseColorW((CHOOSECOLORW*)&cc) || cc.rgbResult!=RGB(1,2,3) || CommDlgExtendedError())ExitProcess(7);
  if(palette[0]!=RGB(200,100,50))ExitProcess(8);
  cc.Flags=CC_PREVENTFULLOPEN|CC_FULLOPEN;
  // Use no owner for the last choice so only the accepted A choices notify proc.
  cc.hwndOwner=NULL;
  if(!ChooseColorW((CHOOSECOLORW*)&cc) || cc.rgbResult!=RGB(200,100,50))ExitProcess(9);
  cc.Flags=CC_ENABLEHOOK;
  if(ChooseColorA(&cc) || !CommDlgExtendedError() || GetLastError()!=ERROR_CALL_NOT_IMPLEMENTED)ExitProcess(10);
  DestroyWindow(owner);
  ExitProcess(0);
}
