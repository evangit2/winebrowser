/* Browser JIT blending regression: native PE32 COM calls, no application hooks. */
#define COBJMACROS
#include <windows.h>
#include <stdint.h>
#ifdef TEST_D3D8
#include <d3d8.h>
#define IDirect3D9 IDirect3D8
#define IDirect3DDevice9 IDirect3DDevice8
#define D3DVIEWPORT9 D3DVIEWPORT8
#define Direct3DCreate9 Direct3DCreate8
#define IDirect3D9_CreateDevice IDirect3D8_CreateDevice
#define IDirect3D9_Release IDirect3D8_Release
#define IDirect3DDevice9_CreateTexture(d,w,h,l,u,f,p,t,s) IDirect3DDevice8_CreateTexture(d,w,h,l,u,f,p,t)
#define IDirect3DDevice9_SetRenderState IDirect3DDevice8_SetRenderState
#define IDirect3DDevice9_GetRenderState IDirect3DDevice8_GetRenderState
#define IDirect3DDevice9_SetFVF IDirect3DDevice8_SetVertexShader
#define IDirect3DDevice9_SetViewport IDirect3DDevice8_SetViewport
#define IDirect3DDevice9_Clear IDirect3DDevice8_Clear
#define IDirect3DDevice9_BeginScene IDirect3DDevice8_BeginScene
#define IDirect3DDevice9_EndScene IDirect3DDevice8_EndScene
#define IDirect3DDevice9_DrawPrimitiveUP IDirect3DDevice8_DrawPrimitiveUP
#define IDirect3DDevice9_Present IDirect3DDevice8_Present
#define IDirect3DDevice9_Release IDirect3DDevice8_Release
#else
#include <d3d9.h>
#endif
static volatile int running=1;
static LRESULT CALLBACK proc(HWND w,UINT m,WPARAM p,LPARAM l) {
    if(m==WM_CLOSE || (m==WM_KEYDOWN && p==VK_ESCAPE)) {running=0;return 0;}
    return DefWindowProcA(w,m,p,l);
}
struct vertex {float x,y,z;DWORD color;};
static struct vertex triangles[6];
static int run(void) {
    HINSTANCE instance=GetModuleHandleA(0); WNDCLASSA c={0}; c.hInstance=instance;c.lpfnWndProc=proc;c.lpszClassName="BlendTest";
    if(!RegisterClassA(&c))return 1;
    RECT rect={0,0,256,128};AdjustWindowRect(&rect,WS_OVERLAPPEDWINDOW,0);
    HWND window=CreateWindowExA(0,c.lpszClassName,"Native RGB565 alpha blending",WS_OVERLAPPEDWINDOW,20,20,rect.right-rect.left,rect.bottom-rect.top,0,0,instance,0);
    if(!window)return 2;
    ShowWindow(window,SW_SHOW);
    IDirect3D9*d3d=Direct3DCreate9(D3D_SDK_VERSION);if(!d3d)return 3;
    D3DPRESENT_PARAMETERS p={0};p.BackBufferWidth=256;p.BackBufferHeight=128;p.BackBufferFormat=D3DFMT_R5G6B5;
    p.SwapEffect=D3DSWAPEFFECT_COPY;p.Windowed=1;p.hDeviceWindow=window;
    p.EnableAutoDepthStencil=TRUE;p.AutoDepthStencilFormat=D3DFMT_D16;
    IDirect3DDevice9*d=0;
    if(FAILED(IDirect3D9_CreateDevice(d3d,0,D3DDEVTYPE_HAL,window,D3DCREATE_SOFTWARE_VERTEXPROCESSING,&p,&d)))return 4;
    if(FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_LIGHTING,FALSE)) ||
        FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_CULLMODE,D3DCULL_NONE)) ||
        FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_ALPHABLENDENABLE,TRUE)) ||
        FAILED(IDirect3DDevice9_SetFVF(d,D3DFVF_XYZ|D3DFVF_DIFFUSE)))return 5;
    for(unsigned i=0;i<6;i++) {
        triangles[i].x=i%3==1?3:-1;triangles[i].y=i%3==2?3:-1;triangles[i].z=.5f;
        triangles[i].color=i<3?0x63b34371:0x7b25d547;
    }
    while(running) {
        MSG msg;while(PeekMessageA(&msg,0,0,0,PM_REMOVE)){TranslateMessage(&msg);DispatchMessageA(&msg);}
        if(!running)break;
        D3DVIEWPORT9 viewport={0,0,256,128,0,1};
        if(FAILED(IDirect3DDevice9_SetViewport(d,&viewport)) ||
            FAILED(IDirect3DDevice9_Clear(d,0,0,D3DCLEAR_TARGET|D3DCLEAR_ZBUFFER,0x97358bc5,1,0)) ||
            FAILED(IDirect3DDevice9_BeginScene(d)))return 6;
        viewport.Width=64;
        for(unsigned phase=0;phase<4;phase++) {
            viewport.X=phase*64;
            DWORD source=phase==2?D3DBLEND_ONE:D3DBLEND_SRCALPHA;
            DWORD dest=phase==2?D3DBLEND_ONE:D3DBLEND_INVSRCALPHA;
            DWORD mask=phase==3?D3DCOLORWRITEENABLE_RED|D3DCOLORWRITEENABLE_BLUE:15,read=0;
            if(FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_SRCBLEND,source)) ||
                FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_DESTBLEND,dest)) ||
                FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_COLORWRITEENABLE,mask)) ||
                FAILED(IDirect3DDevice9_SetRenderState(d,D3DRS_DITHERENABLE,phase==1)) ||
                FAILED(IDirect3DDevice9_GetRenderState(d,D3DRS_SRCBLEND,&read)) || read!=source ||
                FAILED(IDirect3DDevice9_SetViewport(d,&viewport)) ||
                FAILED(IDirect3DDevice9_DrawPrimitiveUP(d,D3DPT_TRIANGLELIST,2,triangles,sizeof(*triangles))))return 7;
        }
        if(FAILED(IDirect3DDevice9_EndScene(d)) || FAILED(IDirect3DDevice9_Present(d,0,0,0,0)))return 8;
        Sleep(16);
    }
    if(IDirect3DDevice9_Release(d)!=0)return 9;
    if(IDirect3D9_Release(d3d)!=0)return 10;
    DestroyWindow(window);return 0;
}
void mainCRTStartup(void){ExitProcess(run());}
