/* Native PE32 offscreen/cube rendering regression. MIT licensed project fixture. */
#define COBJMACROS
#include <windows.h>
#include <stdint.h>
#ifdef TEST_D3D8
#include <d3d8.h>
#define IDirect3D9 IDirect3D8
#define IDirect3DDevice9 IDirect3DDevice8
#define IDirect3DTexture9 IDirect3DTexture8
#define IDirect3DBaseTexture9 IDirect3DBaseTexture8
#define IDirect3DSurface9 IDirect3DSurface8
#define D3DVIEWPORT9 D3DVIEWPORT8
#define Direct3DCreate9 Direct3DCreate8
#define IDirect3D9_CreateDevice IDirect3D8_CreateDevice
#define IDirect3D9_Release IDirect3D8_Release
#define IDirect3DDevice9_CreateTexture(d,w,h,l,u,f,p,t,s) IDirect3DDevice8_CreateTexture(d,w,h,l,u,f,p,t)
#define IDirect3DDevice9_SetTexture IDirect3DDevice8_SetTexture
#define IDirect3DDevice9_GetTexture IDirect3DDevice8_GetTexture
#define IDirect3DDevice9_SetTextureStageState IDirect3DDevice8_SetTextureStageState
#define IDirect3DDevice9_SetSamplerState IDirect3DDevice8_SetTextureStageState
#define D3DSAMP_MAGFILTER D3DTSS_MAGFILTER
#define D3DSAMP_MINFILTER D3DTSS_MINFILTER
#define IDirect3DDevice9_SetRenderState IDirect3DDevice8_SetRenderState
#define IDirect3DDevice9_SetFVF IDirect3DDevice8_SetVertexShader
#define IDirect3DDevice9_SetViewport IDirect3DDevice8_SetViewport
#define IDirect3DDevice9_Clear IDirect3DDevice8_Clear
#define IDirect3DDevice9_BeginScene IDirect3DDevice8_BeginScene
#define IDirect3DDevice9_EndScene IDirect3DDevice8_EndScene
#define IDirect3DDevice9_DrawPrimitiveUP IDirect3DDevice8_DrawPrimitiveUP
#define IDirect3DDevice9_Present IDirect3DDevice8_Present
#define IDirect3DDevice9_Release IDirect3DDevice8_Release
#define IDirect3DTexture9_GetLevelCount IDirect3DTexture8_GetLevelCount
#define IDirect3DTexture9_GetLevelDesc IDirect3DTexture8_GetLevelDesc
#define IDirect3DTexture9_LockRect IDirect3DTexture8_LockRect
#define IDirect3DTexture9_UnlockRect IDirect3DTexture8_UnlockRect
#define IDirect3DTexture9_Release IDirect3DTexture8_Release
#define IDirect3DTexture9_GetSurfaceLevel IDirect3DTexture8_GetSurfaceLevel
#define IDirect3DSurface9_LockRect IDirect3DSurface8_LockRect
#define IDirect3DSurface9_UnlockRect IDirect3DSurface8_UnlockRect
#define IDirect3DSurface9_Release IDirect3DSurface8_Release
#else
#include <d3d9.h>
#endif

#ifdef TEST_D3D8
#define IDirect3DCubeTexture9 IDirect3DCubeTexture8
#define IDirect3DDevice9_CreateCubeTexture(d,w,l,u,f,p,t,s) IDirect3DDevice8_CreateCubeTexture(d,w,l,u,f,p,t)
#define IDirect3DDevice9_CreateRenderTarget(d,w,h,f,m,q,l,s,z) IDirect3DDevice8_CreateRenderTarget(d,w,h,f,m,l,s)
#define IDirect3DDevice9_CreateDepthStencilSurface(d,w,h,f,m,q,x,s,z) IDirect3DDevice8_CreateDepthStencilSurface(d,w,h,f,m,s)
#define IDirect3DDevice9_GetBackBuffer(d,s,i,t,p) IDirect3DDevice8_GetBackBuffer(d,i,t,p)
#define IDirect3DCubeTexture9_GetCubeMapSurface IDirect3DCubeTexture8_GetCubeMapSurface
#define IDirect3DCubeTexture9_Release IDirect3DCubeTexture8_Release
static HRESULT selectTarget(IDirect3DDevice9*d,IDirect3DSurface9*c,IDirect3DSurface9*z){return IDirect3DDevice8_SetRenderTarget(d,c,z);}
static HRESULT image(IDirect3DDevice9*d,D3DFORMAT format,IDirect3DSurface9**s){return IDirect3DDevice8_CreateImageSurface(d,16,16,format,s);}
static HRESULT readTarget(IDirect3DDevice9*d,IDirect3DSurface9*s,IDirect3DSurface9*t){return IDirect3DDevice8_CopyRects(d,s,0,1,t,0);}
#else
static HRESULT selectTarget(IDirect3DDevice9*d,IDirect3DSurface9*c,IDirect3DSurface9*z){HRESULT h=IDirect3DDevice9_SetRenderTarget(d,0,c);return FAILED(h)?h:IDirect3DDevice9_SetDepthStencilSurface(d,z);}
static HRESULT image(IDirect3DDevice9*d,D3DFORMAT format,IDirect3DSurface9**s){return IDirect3DDevice9_CreateOffscreenPlainSurface(d,16,16,format,D3DPOOL_SYSTEMMEM,s,0);}
static HRESULT readTarget(IDirect3DDevice9*d,IDirect3DSurface9*s,IDirect3DSurface9*t){return IDirect3DDevice9_GetRenderTargetData(d,s,t);}
#endif
static volatile int running=1;
static LRESULT CALLBACK proc(HWND w,UINT m,WPARAM p,LPARAM l){if(m==WM_CLOSE){running=0;return 0;}return DefWindowProcA(w,m,p,l);}
struct vertex{float x,y,z;DWORD color;float u,v,w;};
static const DWORD colors[6]={0xffff0000,0xff00ff00,0xff0000ff,0xffffff00,0xffff00ff,0xff00ffff};
static const float directions[6][3]={{1,0,0},{-1,0,0},{0,1,0},{0,-1,0},{0,0,1},{0,0,-1}};
static void quad(struct vertex*v,float left,float right,float extent,DWORD color,const float*direction){
  const float positions[6][2]={{0,-1},{1,-1},{1,1},{0,-1},{1,1},{0,1}};
  for(int i=0;i<6;i++){v[i].x=positions[i][0]?right:left;v[i].y=positions[i][1]*extent;v[i].z=.25f;v[i].color=color;v[i].u=direction[0];v[i].v=direction[1];v[i].w=direction[2];}
}
static int run(void){
 HINSTANCE instance=GetModuleHandleA(0);WNDCLASSA c={0};c.hInstance=instance;c.lpfnWndProc=proc;c.lpszClassName="TargetTest";
 if(!RegisterClassA(&c))return 1;
 RECT rect={0,0,192,64};AdjustWindowRect(&rect,WS_OVERLAPPEDWINDOW,0);
 HWND window=CreateWindowExA(0,c.lpszClassName,"Native cube render targets",WS_OVERLAPPEDWINDOW,20,20,rect.right-rect.left,rect.bottom-rect.top,0,0,instance,0);
 if(!window)return 2;
 ShowWindow(window,SW_SHOW);
 IDirect3D9*f=Direct3DCreate9(D3D_SDK_VERSION);if(!f)return 3;
 D3DPRESENT_PARAMETERS p={0};p.BackBufferWidth=192;p.BackBufferHeight=64;p.BackBufferFormat=D3DFMT_X8R8G8B8;p.SwapEffect=D3DSWAPEFFECT_DISCARD;p.Windowed=1;p.hDeviceWindow=window;
 IDirect3DDevice9*d=0;if(FAILED(IDirect3D9_CreateDevice(f,0,D3DDEVTYPE_HAL,window,D3DCREATE_SOFTWARE_VERTEXPROCESSING,&p,&d)))return 4;
 IDirect3DCubeTexture9*cube=0;IDirect3DSurface9*back=0,*depth=0,*cpu=0,*target565=0,*cpu565=0;
 if(FAILED(IDirect3DDevice9_CreateCubeTexture(d,16,1,D3DUSAGE_RENDERTARGET,D3DFMT_A8R8G8B8,D3DPOOL_DEFAULT,&cube,0)))return 5;
 if(FAILED(IDirect3DDevice9_CreateDepthStencilSurface(d,16,16,D3DFMT_D16,D3DMULTISAMPLE_NONE,0,0,&depth,0)))return 6;
 if(FAILED(IDirect3DDevice9_GetBackBuffer(d,0,0,D3DBACKBUFFER_TYPE_MONO,&back))||FAILED(image(d,D3DFMT_A8R8G8B8,&cpu)))return 7;
 if(FAILED(IDirect3DDevice9_CreateRenderTarget(d,16,16,D3DFMT_R5G6B5,D3DMULTISAMPLE_NONE,0,FALSE,&target565,0))||FAILED(image(d,D3DFMT_R5G6B5,&cpu565)))return 26;
 if(FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_LIGHTING,FALSE))||FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_CULLMODE,D3DCULL_NONE)))return 8;
 if(FAILED(IDirect3DDevice9_SetFVF(d,D3DFVF_XYZ|D3DFVF_DIFFUSE|D3DFVF_TEX1|D3DFVF_TEXCOORDSIZE3(0))))return 9;
 unsigned frame=0;
 while(running){
  MSG msg;while(PeekMessageA(&msg,0,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageA(&msg);}if(!running)break;
  unsigned phase=frame++%2;
  if(FAILED(IDirect3DDevice9_SetTexture(d,0,0)))return 10;
  for(int face=0;face<6;face++){
   IDirect3DSurface9*s=0;DWORD color=colors[(face+phase)%6];struct vertex vertices[6];quad(vertices,-.75f,.75f,.75f,color,directions[face]);
   if(FAILED(IDirect3DCubeTexture9_GetCubeMapSurface(cube,(D3DCUBEMAP_FACES)face,0,&s)))return 11;
   if(FAILED(selectTarget(d,s,depth))||FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_ZENABLE,TRUE))||FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_ZWRITEENABLE,TRUE)))return 12;
   if(FAILED(IDirect3DDevice9_Clear(d,0,0,D3DCLEAR_TARGET|D3DCLEAR_ZBUFFER,0xff000000,1,0))||FAILED(IDirect3DDevice9_BeginScene(d)))return 13;
   if(FAILED(IDirect3DDevice9_DrawPrimitiveUP(d,D3DPT_TRIANGLELIST,2,vertices,sizeof(*vertices)))||FAILED(IDirect3DDevice9_EndScene(d)))return 14;
   if(FAILED(selectTarget(d,back,0))||FAILED(readTarget(d,s,cpu)))return 15;
   D3DLOCKED_RECT locked;if(FAILED(IDirect3DSurface9_LockRect(cpu,&locked,0,D3DLOCK_READONLY)))return 16;
   if(*(DWORD*)((BYTE*)locked.pBits+8*locked.Pitch+8*4)!=color)return 17;
   if(*(DWORD*)locked.pBits!=0xff000000)return 18;
   if(FAILED(IDirect3DSurface9_UnlockRect(cpu)))return 19;
   IDirect3DSurface9_Release(s);
  }
  if(!phase){
   D3DVIEWPORT9 half={0,0,8,16,0,1};
   if(FAILED(selectTarget(d,target565,0))||FAILED(IDirect3DDevice9_Clear(d,0,0,D3DCLEAR_TARGET,0xff7f3f1f,1,0))||FAILED(IDirect3DDevice9_SetViewport(d,&half))||FAILED(IDirect3DDevice9_Clear(d,0,0,D3DCLEAR_TARGET,0xffff0000,1,0)))return 27;
   if(FAILED(selectTarget(d,back,0))||FAILED(readTarget(d,target565,cpu565)))return 28;
   D3DLOCKED_RECT locked;if(FAILED(IDirect3DSurface9_LockRect(cpu565,&locked,0,D3DLOCK_READONLY)))return 29;
   if(*(WORD*)locked.pBits!=0xf800||*(WORD*)((BYTE*)locked.pBits+16)!=0x7a04)return 30;
   if(FAILED(IDirect3DSurface9_UnlockRect(cpu565)))return 31;
  }
  if(FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_ZENABLE,FALSE))||FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_ZWRITEENABLE,FALSE))||FAILED(IDirect3DDevice9_SetTexture(d,0,(IDirect3DBaseTexture9*)cube)))return 20;
  if(FAILED(IDirect3DDevice9_Clear(d,0,0,D3DCLEAR_TARGET,0xff102030,1,0))||FAILED(IDirect3DDevice9_BeginScene(d)))return 21;
  for(int face=0;face<6;face++){struct vertex vertices[6];quad(vertices,-1+face/3.0f,-1+(face+1)/3.0f,1,0xffffffff,directions[face]);if(FAILED(IDirect3DDevice9_DrawPrimitiveUP(d,D3DPT_TRIANGLELIST,2,vertices,sizeof(*vertices))))return 22;}
  if(FAILED(IDirect3DDevice9_EndScene(d))||FAILED(IDirect3DDevice9_Present(d,0,0,0,0)))return 23;
  Sleep(16);
 }
 IDirect3DDevice9_SetTexture(d,0,0);IDirect3DCubeTexture9_Release(cube);IDirect3DSurface9_Release(depth);IDirect3DSurface9_Release(cpu);IDirect3DSurface9_Release(back);IDirect3DSurface9_Release(target565);IDirect3DSurface9_Release(cpu565);
 if(IDirect3DDevice9_Release(d)!=0)return 24;
 if(IDirect3D9_Release(f)!=0)return 25;
 DestroyWindow(window);return 0;
}
void mainCRTStartup(void){ExitProcess(run());}
