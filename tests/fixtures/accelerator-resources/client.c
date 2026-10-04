// Authored MIT fixture: real compiler-generated accelerator resource.
#include <windows.h>
static int seen;
static LRESULT CALLBACK proc(HWND w,UINT m,WPARAM wp,LPARAM lp) {
 if (m==WM_COMMAND && HIWORD(wp)==1) {
  if(LOWORD(wp)==10){seen|=1;SetDlgItemTextA(w,10,"Character accelerator received");}
  else if(LOWORD(wp)==11){seen|=2;SetDlgItemTextA(w,10,"Control accelerator received");}
  else if(LOWORD(wp)==12){seen|=4;SetDlgItemTextA(w,10,"Final accelerator received");}
  return 0;
 }
 if(m==WM_DESTROY){PostQuitMessage(0);return 0;}
 return DefWindowProcA(w,m,wp,lp);
}
void start(void) {
 HINSTANCE i=GetModuleHandleA(0);HACCEL a=LoadAcceleratorsA(i,MAKEINTRESOURCEA(201));
 if(!a || LoadAcceleratorsW(i,MAKEINTRESOURCEW(201))!=a) ExitProcess(90);
 WNDCLASSA c={0};c.lpfnWndProc=proc;c.hInstance=i;c.lpszClassName="AcceleratorResources";RegisterClassA(&c);
 HWND w=CreateWindowExA(0,c.lpszClassName,"Native accelerator resources",WS_VISIBLE|WS_OVERLAPPEDWINDOW,20,20,540,200,0,0,i,0);
 CreateWindowExA(0,"STATIC","Native keyboard shortcuts ready",WS_CHILD|WS_VISIBLE,10,10,500,28,w,(HMENU)10,i,0);
 MSG m;while(GetMessageA(&m,0,0,0)>0){if(!TranslateAcceleratorA(w,a,&m)){TranslateMessage(&m);DispatchMessageA(&m);}}
 ExitProcess(seen==7?0:91);
}
