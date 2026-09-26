/* Browser JIT texture regression: native PE32 COM calls, no application hooks. */
#define COBJMACROS
#include <windows.h>
#include <stdint.h>
#ifdef TEST_D3D8
#include <d3d8.h>
#define IDirect3D9 IDirect3D8
#define IDirect3DDevice9 IDirect3DDevice8
#define IDirect3DTexture9 IDirect3DTexture8
#define IDirect3DBaseTexture9 IDirect3DBaseTexture8
#define D3DVIEWPORT9 D3DVIEWPORT8
#define D3DMATERIAL9 D3DMATERIAL8
#define D3DLIGHT9 D3DLIGHT8
#define IDirect3DDevice9_SetMaterial IDirect3DDevice8_SetMaterial
#define IDirect3DDevice9_GetMaterial IDirect3DDevice8_GetMaterial
#define IDirect3DDevice9_SetLight IDirect3DDevice8_SetLight
#define IDirect3DDevice9_GetLight IDirect3DDevice8_GetLight
#define IDirect3DDevice9_LightEnable IDirect3DDevice8_LightEnable
#define IDirect3DDevice9_GetLightEnable IDirect3DDevice8_GetLightEnable
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
#else
#include <d3d9.h>
#endif
static volatile int running=1;
static LRESULT CALLBACK proc(HWND w,UINT m,WPARAM p,LPARAM l) {
    if(m==WM_CLOSE || (m==WM_KEYDOWN && p==VK_ESCAPE)) {running=0;return 0;}
    return DefWindowProcA(w,m,p,l);
}
struct vertex {float x,y,z,nx,ny,nz,u,v;};
static const struct vertex quad[] = {
    {-1,-1,.5f,0,0,-1,0,1},{1,-1,.5f,0,0,-1,1,1},{-1,1,.5f,0,0,-1,0,0},
    {-1,1,.5f,0,0,-1,0,0},{1,-1,.5f,0,0,-1,1,1},{1,1,.5f,0,0,-1,1,0}
};
static const DWORD colors[2][4]={{0xffff0000,0xff00ff00,0xff0000ff,0xffffffff},{0xffffff00,0xff00ffff,0xffff00ff,0xff808080}};
static int fill(IDirect3DTexture9*t,int phase) {
    for(unsigned y=0;y<2;y++) {
        D3DLOCKED_RECT locked;
        RECT row={0,(LONG)y,2,(LONG)y+1};
        if(FAILED(IDirect3DTexture9_LockRect(t,0,&locked,&row,0)) || locked.Pitch<8) return 0;
        for(unsigned x=0;x<2;x++) ((DWORD*)locked.pBits)[x]=colors[phase][y*2+x];
        if(FAILED(IDirect3DTexture9_UnlockRect(t,0))) return 0;
    }
    return 1;
}
static int run(void) {
    HINSTANCE instance=GetModuleHandleA(0); WNDCLASSA c={0}; c.hInstance=instance;c.lpfnWndProc=proc;c.lpszClassName="LightingTest";
    if(!RegisterClassA(&c))return 1;
    RECT rect={0,0,256,128};AdjustWindowRect(&rect,WS_OVERLAPPEDWINDOW,0);
    HWND window=CreateWindowExA(0,c.lpszClassName,"Native lighting and texture snapshots",WS_OVERLAPPEDWINDOW,20,20,rect.right-rect.left,rect.bottom-rect.top,0,0,instance,0);
    if(!window)return 2;
    ShowWindow(window,SW_SHOW);
    IDirect3D9*d3d=Direct3DCreate9(D3D_SDK_VERSION);if(!d3d)return 3;
    D3DPRESENT_PARAMETERS p={0};p.BackBufferWidth=256;p.BackBufferHeight=128;p.BackBufferFormat=D3DFMT_X8R8G8B8;
    p.SwapEffect=D3DSWAPEFFECT_DISCARD;p.Windowed=1;p.hDeviceWindow=window;
    IDirect3DDevice9*d=0;
    if(FAILED(IDirect3D9_CreateDevice(d3d,0,D3DDEVTYPE_HAL,window,D3DCREATE_SOFTWARE_VERTEXPROCESSING,&p,&d)))return 4;
    IDirect3DTexture9*t=0;
    if(FAILED(IDirect3DDevice9_CreateTexture(d,2,2,0,0,D3DFMT_A8R8G8B8,D3DPOOL_MANAGED,&t,0)))return 5;
    D3DSURFACE_DESC desc;
    if(IDirect3DTexture9_GetLevelCount(t)!=2 || FAILED(IDirect3DTexture9_GetLevelDesc(t,1,&desc)) || desc.Width!=1 || desc.Height!=1)return 6;
    if(FAILED(IDirect3DDevice9_SetTexture(d,0,(IDirect3DBaseTexture9*)t)))return 7;
    /* The binding keeps the texture alive; GetTexture revives a COM reference. */
    if(IDirect3DTexture9_Release(t)!=0)return 8;
    t=0;
    if(FAILED(IDirect3DDevice9_GetTexture(d,0,(IDirect3DBaseTexture9**)&t)) || !t)return 9;
    if(FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_LIGHTING,TRUE)) || FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_CULLMODE,D3DCULL_NONE)) ||
        FAILED(IDirect3DDevice9_SetFVF(d,D3DFVF_XYZ|D3DFVF_NORMAL|D3DFVF_TEX1)))return 10;
    if(FAILED(IDirect3DDevice9_SetTextureStageState(d,0,D3DTSS_COLOROP,D3DTOP_MODULATE)) ||
        FAILED(IDirect3DDevice9_SetSamplerState(d,0,D3DSAMP_MAGFILTER,D3DTEXF_POINT)) ||
        FAILED(IDirect3DDevice9_SetSamplerState(d,0,D3DSAMP_MINFILTER,D3DTEXF_POINT)))return 11;
    D3DMATERIAL9 material={0},result;
    material.Diffuse.r=material.Diffuse.g=material.Diffuse.b=material.Diffuse.a=1;
    if(FAILED(IDirect3DDevice9_SetMaterial(d,&material)) || FAILED(IDirect3DDevice9_GetMaterial(d,&result)) || result.Diffuse.g!=1) return 17;
    D3DLIGHT9 light={0},light_copy;light.Type=D3DLIGHT_DIRECTIONAL;light.Direction.z=1;
    if(FAILED(IDirect3DDevice9_LightEnable(d,71,TRUE)) || FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_SPECULARMATERIALSOURCE,D3DMCS_MATERIAL)))return 18;
    BOOL enabled=FALSE;
    if(FAILED(IDirect3DDevice9_GetLightEnable(d,71,&enabled)) || !enabled)return 19;
    while(running) {
        MSG msg;while(PeekMessageA(&msg,0,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageA(&msg);}
        if(!running)break;
        D3DVIEWPORT9 viewport={0,0,256,128,0,1};
        if(FAILED(IDirect3DDevice9_SetViewport(d,&viewport)) || FAILED(IDirect3DDevice9_Clear(d,0,0,D3DCLEAR_TARGET,0xff102030,1,0)) ||
            FAILED(IDirect3DDevice9_BeginScene(d)))return 12;
        viewport.Width=128;
        for(unsigned phase=0;phase<2;phase++) {
            viewport.X=phase*128;
            light.Diffuse.r=phase ? .25f : 1.0f;light.Diffuse.g=.5f;light.Diffuse.b=phase ? 1.0f : .25f;
            if(FAILED(IDirect3DDevice9_SetLight(d,71,&light)) || FAILED(IDirect3DDevice9_GetLight(d,71,&light_copy)) || light_copy.Diffuse.r!=light.Diffuse.r)return 20;
            if(!fill(t,phase) || FAILED(IDirect3DDevice9_SetViewport(d,&viewport)) ||
                FAILED(IDirect3DDevice9_DrawPrimitiveUP(d,D3DPT_TRIANGLELIST,2,quad,sizeof(*quad))))return 13;
        }
        if(FAILED(IDirect3DDevice9_EndScene(d)) || FAILED(IDirect3DDevice9_Present(d,0,0,0,0)))return 14;
        Sleep(16);
    }
    IDirect3DTexture9_Release(t);
    if(IDirect3DDevice9_Release(d)!=0)return 15;
    if(IDirect3D9_Release(d3d)!=0)return 16;
    DestroyWindow(window);return 0;
}
void mainCRTStartup(void){ExitProcess(run());}
