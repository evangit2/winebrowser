/* MIT licensed native DirectDraw/Direct3D7 contract fixture. */
#define COBJMACROS
#define INITGUID
#include <windows.h>
#include <ddraw.h>
#include <d3d.h>
#include <stdint.h>
#ifdef TEST_DDRAW1
#define DRAW IDirectDraw
#define SURF IDirectDrawSurface
#define DESC DDSURFACEDESC
#define CAPS DDSCAPS
#define CREATE(d) DirectDrawCreate(0,d,0)
#define MODE(d) IDirectDraw_SetDisplayMode(d,640,480,16)
#define CALL(d,m,...) IDirectDraw_##m(d,##__VA_ARGS__)
#define SCALL(d,m,...) IDirectDrawSurface_##m(d,##__VA_ARGS__)
#define DROP(d) IDirectDraw_Release(d)
#define SDROP(d) IDirectDrawSurface_Release(d)
#else
#define DRAW IDirectDraw7
#define SURF IDirectDrawSurface7
#define DESC DDSURFACEDESC2
#define CAPS DDSCAPS2
#define CREATE(d) DirectDrawCreateEx(0,(void**)d,&IID_IDirectDraw7,0)
#ifdef TEST_D3D7
#define MODE(d) IDirectDraw7_SetDisplayMode(d,640,480,32,0,0)
#else
#define MODE(d) IDirectDraw7_SetDisplayMode(d,640,480,16,0,0)
#endif
#define CALL(d,m,...) IDirectDraw7_##m(d,##__VA_ARGS__)
#define SCALL(d,m,...) IDirectDrawSurface7_##m(d,##__VA_ARGS__)
#define DROP(d) IDirectDraw7_Release(d)
#define SDROP(d) IDirectDrawSurface7_Release(d)
#endif
#define OK(x,n) do { if(FAILED(x))return n; } while(0)
static volatile int running=1;
static LRESULT CALLBACK proc(HWND w,UINT m,WPARAM p,LPARAM l){if(m==WM_CLOSE){running=0;return 0;}return DefWindowProcA(w,m,p,l);}
#ifndef TEST_D3D7
static HRESULT fill(SURF*s,DWORD color){DDBLTFX f={0};f.dwSize=sizeof(f);f.dwFillColor=color;return SCALL(s,Blt,0,0,0,DDBLT_COLORFILL|DDBLT_WAIT,&f);}
#endif
static HRESULT CALLBACK mode(DESC*d,void*c){if(d->dwSize!=sizeof(*d)||!d->dwWidth||!d->dwHeight)return DDENUMRET_CANCEL;(*(unsigned*)c)++;return DDENUMRET_OK;}
static HRESULT CALLBACK attached(SURF*s,DESC*d,void*c){if(d->dwSize==sizeof(*d))(*(unsigned*)c)++;SDROP(s);return DDENUMRET_OK;}
#ifndef TEST_D3D7
static int cpuTests(DRAW*d){
 DESC desc={0};desc.dwSize=sizeof(desc);desc.dwFlags=DDSD_WIDTH|DDSD_HEIGHT|DDSD_PIXELFORMAT|DDSD_CAPS;desc.dwWidth=8;desc.dwHeight=1;
 desc.ddsCaps.dwCaps=DDSCAPS_OFFSCREENPLAIN|DDSCAPS_SYSTEMMEMORY;
 desc.ddpfPixelFormat.dwSize=sizeof(DDPIXELFORMAT);desc.ddpfPixelFormat.dwFlags=DDPF_RGB;desc.ddpfPixelFormat.dwRGBBitCount=16;desc.ddpfPixelFormat.dwRBitMask=0xf800;desc.ddpfPixelFormat.dwGBitMask=0x7e0;desc.ddpfPixelFormat.dwBBitMask=0x1f;
 SURF*s=0;OK(CALL(d,CreateSurface,&desc,&s,0),20);
 struct{CAPS caps;DWORD guard;} cap={{0},0x12345678};OK(SCALL(s,GetCaps,&cap.caps),21);if(cap.guard!=0x12345678)return 22;
 DESC locked={0};locked.dwSize=sizeof(locked);OK(SCALL(s,Lock,0,&locked,DDLOCK_WAIT,0),23);
 for(unsigned i=0;i<8;i++)((WORD*)locked.lpSurface)[i]=(WORD)(i+1);
 OK(SCALL(s,Unlock,0),24);
 RECT source={0,0,6,1};OK(SCALL(s,BltFast,2,0,s,&source,DDBLTFAST_WAIT),25);
 locked.dwSize=sizeof(locked);OK(SCALL(s,Lock,0,&locked,DDLOCK_READONLY,0),26);
 static const WORD expected[8]={1,2,1,2,3,4,5,6};for(unsigned i=0;i<8;i++)if(((WORD*)locked.lpSurface)[i]!=expected[i])return 27;
 if(SCALL(s,Blt,0,0,0,DDBLT_COLORFILL,0)!=DDERR_SURFACEBUSY)return 28;
 OK(SCALL(s,Unlock,0),29);
 DDCOLORKEY key={1,1};OK(SCALL(s,SetColorKey,DDCKEY_SRCBLT,&key),30);
 SURF*t=0;OK(CALL(d,CreateSurface,&desc,&t,0),31);OK(fill(t,0x1f),32);OK(SCALL(t,Blt,0,s,0,DDBLT_KEYSRC|DDBLT_WAIT,0),33);
 locked.dwSize=sizeof(locked);OK(SCALL(t,Lock,0,&locked,DDLOCK_READONLY,0),34);
 if(((WORD*)locked.lpSurface)[0]!=0x1f||((WORD*)locked.lpSurface)[1]!=2||((WORD*)locked.lpSurface)[2]!=0x1f)return 35;
 OK(SCALL(t,Unlock,0),36);SDROP(t);SDROP(s);return 0;
}
#else
struct vertex {float x,y,z;DWORD color;float u,v;};
static struct vertex quad[6]={{-1,-1,.25f,0xffffffff,0,1},{1,-1,.25f,0xffffffff,1,1},{1,1,.25f,0xffffffff,1,0},{-1,-1,.25f,0xffffffff,0,1},{1,1,.25f,0xffffffff,1,0},{-1,1,.25f,0xffffffff,0,0}};
static struct vertex farQuad[6];
static WORD indices[6]={0,1,2,3,4,5};
static HRESULT CALLBACK devices(char*a,char*b,D3DDEVICEDESC7*d,void*c){(void)a;(void)b;if(d->dwMaxTextureWidth>=2)(*(unsigned*)c)++;return D3DENUMRET_OK;}
static HRESULT CALLBACK zformat(DDPIXELFORMAT*f,void*c){if(f->dwFlags==DDPF_ZBUFFER&&f->dwZBufferBitDepth==16)(*(unsigned*)c)++;return D3DENUMRET_OK;}
#endif
static int run(void){
 HINSTANCE instance=GetModuleHandleA(0);WNDCLASSA c={0},queried={0};c.hInstance=instance;c.lpfnWndProc=proc;c.lpszClassName="DirectDrawContracts";
 if(!RegisterClassA(&c)||!GetClassInfoA(instance,c.lpszClassName,&queried)||queried.lpfnWndProc!=proc)return 1;
 HWND window=CreateWindowExA(0,c.lpszClassName,"Native DirectDraw contracts",WS_POPUP,0,0,640,480,0,0,instance,0);if(!window)return 2;ShowWindow(window,SW_SHOW);
 DRAW*d=0;OK(CREATE(&d),3);OK(CALL(d,SetCooperativeLevel,window,DDSCL_EXCLUSIVE|DDSCL_FULLSCREEN),4);OK(MODE(d),5);
 unsigned modes=0,count=0;OK(CALL(d,EnumDisplayModes,0,0,&modes,mode),6);if(modes!=6)return 7;
 DESC desc={0};desc.dwSize=sizeof(desc);desc.dwFlags=DDSD_CAPS|DDSD_BACKBUFFERCOUNT;desc.dwBackBufferCount=1;desc.ddsCaps.dwCaps=DDSCAPS_PRIMARYSURFACE|DDSCAPS_FLIP|DDSCAPS_COMPLEX;
#ifdef TEST_D3D7
 desc.ddsCaps.dwCaps|=DDSCAPS_3DDEVICE;
#endif
 SURF*primary=0,*back=0;OK(CALL(d,CreateSurface,&desc,&primary,0),8);CAPS caps={0};caps.dwCaps=DDSCAPS_BACKBUFFER;OK(SCALL(primary,GetAttachedSurface,&caps,&back),9);
 OK(SCALL(primary,EnumAttachedSurfaces,&count,attached),10);if(count!=1)return 11;
#ifndef TEST_D3D7
 int status=cpuTests(d);if(status)return status;
#else
 IDirect3D7*f=0;IDirect3DDevice7*gpu=0;SURF*depth=0,*tex=0;
 OK(CALL(d,QueryInterface,&IID_IDirect3D7,(void**)&f),40);count=0;OK(IDirect3D7_EnumDevices(f,devices,&count),41);if(count!=1)return 42;
 count=0;OK(IDirect3D7_EnumZBufferFormats(f,&IID_IDirect3DHALDevice,zformat,&count),43);if(count!=1)return 44;
 DESC z={0};z.dwSize=sizeof(z);z.dwFlags=DDSD_CAPS|DDSD_WIDTH|DDSD_HEIGHT|DDSD_PIXELFORMAT;z.dwWidth=640;z.dwHeight=480;z.ddsCaps.dwCaps=DDSCAPS_ZBUFFER;z.ddpfPixelFormat.dwSize=32;z.ddpfPixelFormat.dwFlags=DDPF_ZBUFFER;z.ddpfPixelFormat.dwZBufferBitDepth=16;z.ddpfPixelFormat.dwZBitMask=0xffff;
 OK(CALL(d,CreateSurface,&z,&depth,0),45);OK(SCALL(back,AddAttachedSurface,depth),46);OK(IDirect3D7_CreateDevice(f,&IID_IDirect3DHALDevice,back,&gpu),47);
 z.dwWidth=z.dwHeight=2;z.ddsCaps.dwCaps=DDSCAPS_TEXTURE|DDSCAPS_SYSTEMMEMORY;z.ddpfPixelFormat.dwFlags=DDPF_RGB|DDPF_ALPHAPIXELS;z.ddpfPixelFormat.dwRGBBitCount=32;z.ddpfPixelFormat.dwRBitMask=0xff0000;z.ddpfPixelFormat.dwGBitMask=0xff00;z.ddpfPixelFormat.dwBBitMask=0xff;z.ddpfPixelFormat.dwRGBAlphaBitMask=0xff000000;
 OK(CALL(d,CreateSurface,&z,&tex,0),48);DESC locked={0};locked.dwSize=sizeof(locked);OK(SCALL(tex,Lock,0,&locked,DDLOCK_WRITEONLY,0),49);
 DWORD colors[4]={0xffff0000,0xff00ff00,0xff0000ff,0xffffff00};for(int y=0;y<2;y++)for(int x=0;x<2;x++)*(DWORD*)((BYTE*)locked.lpSurface+y*locked.lPitch+x*4)=colors[y*2+x];
 OK(SCALL(tex,Unlock,0),50);OK(IDirect3DDevice7_SetTexture(gpu,0,tex),51);OK(IDirect3DDevice7_SetRenderState(gpu,D3DRENDERSTATE_LIGHTING,FALSE),52);OK(IDirect3DDevice7_SetRenderState(gpu,D3DRENDERSTATE_CULLMODE,D3DCULL_NONE),53);
 OK(IDirect3DDevice7_SetTextureStageState(gpu,0,D3DTSS_COLOROP,D3DTOP_SELECTARG1),54);OK(IDirect3DDevice7_SetTextureStageState(gpu,0,D3DTSS_COLORARG1,D3DTA_TEXTURE),55);
 OK(IDirect3DDevice7_SetTextureStageState(gpu,0,D3DTSS_MAGFILTER,D3DTFG_POINT),56);OK(IDirect3DDevice7_SetTextureStageState(gpu,0,D3DTSS_MINFILTER,D3DTFN_POINT),57);OK(IDirect3DDevice7_SetTextureStageState(gpu,0,D3DTSS_MIPFILTER,D3DTFP_NONE),58);
 DWORD mip=0;OK(IDirect3DDevice7_GetTextureStageState(gpu,0,D3DTSS_MIPFILTER,&mip),59);if(mip!=D3DTFP_NONE)return 60;
 for(int i=0;i<6;i++){farQuad[i]=quad[i];farQuad[i].z=.75f;farQuad[i].color=0xffff00ff;}
 D3DMATRIX matrix={0};matrix._11=matrix._22=matrix._33=matrix._44=1;OK(IDirect3DDevice7_SetTransform(gpu,D3DTRANSFORMSTATE_WORLD,&matrix),61);D3DVIEWPORT7 viewport={0,0,640,480,0,1};OK(IDirect3DDevice7_SetViewport(gpu,&viewport),62);
#endif
 unsigned frame=0;
 while(running){MSG msg;while(PeekMessageA(&msg,0,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageA(&msg);}if(!running)break;
#ifndef TEST_D3D7
 OK(fill(back,frame++%2?0x7e0:0xf800),12);RECT area={32,32,96,64};DDBLTFX fx={0};fx.dwSize=sizeof(fx);fx.dwFillColor=0x1f;OK(SCALL(back,Blt,&area,0,0,DDBLT_COLORFILL|DDBLT_WAIT,&fx),13);
#else
 OK(IDirect3DDevice7_Clear(gpu,0,0,D3DCLEAR_TARGET|D3DCLEAR_ZBUFFER,0xff000000,1,0),63);OK(IDirect3DDevice7_BeginScene(gpu),64);
 locked.dwSize=sizeof(locked);OK(SCALL(tex,Lock,0,&locked,DDLOCK_WRITEONLY,0),65);for(int y=0;y<2;y++)for(int x=0;x<2;x++)*(DWORD*)((BYTE*)locked.lpSurface+y*locked.lPitch+x*4)=colors[(y*2+x+frame%2)%4];OK(SCALL(tex,Unlock,0),74);
 OK(IDirect3DDevice7_SetTextureStageState(gpu,0,D3DTSS_COLORARG1,D3DTA_TEXTURE),66);
 OK(IDirect3DDevice7_DrawIndexedPrimitive(gpu,D3DPT_TRIANGLELIST,D3DFVF_XYZ|D3DFVF_DIFFUSE|D3DFVF_TEX1,quad,6,indices,6,0),67);
 OK(IDirect3DDevice7_SetTextureStageState(gpu,0,D3DTSS_COLORARG1,D3DTA_DIFFUSE),68);OK(IDirect3DDevice7_DrawPrimitive(gpu,D3DPT_TRIANGLELIST,D3DFVF_XYZ|D3DFVF_DIFFUSE|D3DFVF_TEX1,farQuad,6,0),69);OK(IDirect3DDevice7_EndScene(gpu),70);
 if(frame++==0){locked.dwSize=sizeof(locked);OK(SCALL(back,Lock,0,&locked,DDLOCK_READONLY,0),71);for(int y=0;y<2;y++)for(int x=0;x<2;x++)if((*(DWORD*)((BYTE*)locked.lpSurface+(120+y*240)*locked.lPitch+(160+x*320)*4)&0xffffff)!=(colors[y*2+x]&0xffffff))return 72;OK(SCALL(back,Unlock,0),73);}
#endif
 OK(SCALL(primary,Flip,0,DDFLIP_WAIT),14);
#ifdef TEST_D3D7
 if(frame==1){locked.dwSize=sizeof(locked);OK(SCALL(primary,Lock,0,&locked,DDLOCK_READONLY,0),75);if((*(DWORD*)((BYTE*)locked.lpSurface+120*locked.lPitch+160*4)&0xffffff)!=(colors[0]&0xffffff))return 76;OK(SCALL(primary,Unlock,0),77);}
#endif
 }
#ifdef TEST_D3D7
 IDirect3DDevice7_Release(gpu);SDROP(tex);SDROP(depth);IDirect3D7_Release(f);
#endif
 SDROP(back);SDROP(primary);OK(CALL(d,RestoreDisplayMode),15);if(DROP(d)!=0)return 16;
 DestroyWindow(window);if(!UnregisterClassA(c.lpszClassName,instance))return 17;
 const char message[]="DIRECTDRAW CONTRACTS PASS\n";DWORD written;WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),message,sizeof(message)-1,&written,0);return 0;
}
void mainCRTStartup(void){ExitProcess((UINT)run());}
