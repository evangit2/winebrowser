/* Original MIT native EXE/DLL bitmap resource acceptance fixture. */
#include <windows.h>
#include <commctrl.h>
#define CHECK(x) do{if(!(x))ExitProcess(__LINE__);}while(0)
static HBITMAP displayed[3];
static COLORMAP colors[5]={
  {RGB(0,0,0),RGB(220,20,30)}, {RGB(128,128,128),RGB(20,180,60)},
  {RGB(192,192,192),RGB(20,70,220)}, {RGB(255,255,255),RGB(240,180,20)},
  {RGB(0,0,0),RGB(99,99,99)}
};
static const COLORREF originals[]={RGB(0,0,0),RGB(128,128,128),RGB(192,192,192),RGB(255,255,255)};
static void validate(HBITMAP bitmap,int mapped){
  CHECK(bitmap);BITMAP info;CHECK(GetObjectA(bitmap,sizeof(info),&info)==sizeof(info));CHECK(info.bmWidth==8&&info.bmHeight==2);
  HDC dc=CreateCompatibleDC(NULL);CHECK(dc);HGDIOBJ old=SelectObject(dc,bitmap);CHECK(old);
  for(int i=0;i<4;i++)CHECK(GetPixel(dc,i,0)==(mapped?colors[i].to:originals[i]));
  CHECK(GetPixel(dc,0,1)==(mapped?colors[3].to:originals[3]));
  CHECK(SelectObject(dc,old)==bitmap);CHECK(DeleteDC(dc));
}
static LRESULT CALLBACK proc(HWND window,UINT message,WPARAM wp,LPARAM lp){
  if(message==WM_PAINT){PAINTSTRUCT ps;HDC dc=BeginPaint(window,&ps);CHECK(dc);
    HDC source=CreateCompatibleDC(dc);CHECK(source);
    for(int i=0;i<3;i++){
      HGDIOBJ old=SelectObject(source,displayed[i]);CHECK(old);
      CHECK(BitBlt(dc,20+i*100,50,8,2,source,0,0,SRCCOPY));CHECK(SelectObject(source,old)==displayed[i]);
    }
    CHECK(DeleteDC(source));EndPaint(window,&ps);return 0;
  }
  if(message==WM_DESTROY){PostQuitMessage(0);return 0;}
  return DefWindowProcA(window,message,wp,lp);
}
void start(void){
  HINSTANCE instance=GetModuleHandleA(NULL);HMODULE controls=LoadLibraryA("comctl32.dll"),library=LoadLibraryA("bitmap-resources.dll");CHECK(controls&&library);
  union {FARPROC raw;unsigned (WINAPI *fn)(void);} attached;attached.raw=GetProcAddress(library,"WasAttached");CHECK(attached.fn&&attached.fn());
  union {FARPROC raw;HBITMAP(WINAPI *fn)(HINSTANCE,INT_PTR,UINT,LPCOLORMAP,int);} create;
  create.raw=GetProcAddress(controls,(LPCSTR)8);CHECK(create.fn&&create.raw==GetProcAddress(controls,"CreateMappedBitmap"));
  for(int resource=101;resource<=103;resource++){
    HBITMAP mapped=create.fn(library,resource,0,colors,5);validate(mapped,1);CHECK(DeleteObject(mapped));
    HBITMAP raw=LoadBitmapA(instance,MAKEINTRESOURCEA(resource));validate(raw,0);CHECK(DeleteObject(raw));
  }
  displayed[0]=LoadBitmapW(library,L"NamedBitmap");validate(displayed[0],0);
  displayed[1]=create.fn(library,(INT_PTR)L"NamedBitmap",0,colors,5);validate(displayed[1],1);
  displayed[2]=CreateMappedBitmap(instance,102,0,NULL,0);validate(displayed[2],0);
  CHECK(!CreateMappedBitmap(instance,101,CMB_MASKED,NULL,0)&&GetLastError()==ERROR_CALL_NOT_IMPLEMENTED);
  CHECK(!CreateMappedBitmap(instance,101,0,colors,-1)&&GetLastError()==ERROR_INVALID_PARAMETER);
  CHECK(!LoadBitmapA(instance,MAKEINTRESOURCEA(999)));
  HDC dc=CreateCompatibleDC(NULL);CHECK(dc);
  for(int resource=104;resource<=107;resource++){
    HBITMAP bitmap=LoadBitmapW(library,MAKEINTRESOURCEW(resource));CHECK(bitmap);
    HGDIOBJ old=SelectObject(dc,bitmap);CHECK(old);
    CHECK(GetPixel(dc,0,0)==(resource==104?RGB(255,255,255):resource==106?RGB(255,0,0):RGB(10,20,30)));
    if(resource==106)CHECK(GetPixel(dc,1,0)==RGB(0,255,0)&&GetPixel(dc,2,0)==RGB(0,0,255));
    if(resource==107)CHECK(GetPixel(dc,0,1)==RGB(90,60,30));
    CHECK(SelectObject(dc,old)==bitmap);CHECK(DeleteObject(bitmap));
  }
  CHECK(DeleteDC(dc));CHECK(FreeLibrary(library));
  validate(displayed[0],0);validate(displayed[1],1); // Bitmaps own their pixels after DLL unload.
  WNDCLASSA klass={0};klass.hInstance=instance;klass.lpfnWndProc=proc;klass.lpszClassName="NativeResourceBitmaps";klass.hbrBackground=(HBRUSH)(COLOR_WINDOW+1);CHECK(RegisterClassA(&klass));
  RECT bounds={0,0,320,100};CHECK(AdjustWindowRect(&bounds,WS_OVERLAPPEDWINDOW,FALSE));
  HWND window=CreateWindowA(klass.lpszClassName,"EXE and DLL resource bitmaps",WS_OVERLAPPEDWINDOW|WS_VISIBLE,40,40,bounds.right-bounds.left,bounds.bottom-bounds.top,NULL,NULL,instance,NULL);CHECK(window);CHECK(UpdateWindow(window));
  MSG msg;while(GetMessageA(&msg,NULL,0,0)>0){TranslateMessage(&msg);DispatchMessageA(&msg);}
  for(int i=0;i<3;i++){CHECK(DeleteObject(displayed[i]));}
  ExitProcess((UINT)msg.wParam);
}
