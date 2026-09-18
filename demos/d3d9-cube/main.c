/* Native PE32 Direct3D 9 cube. No C runtime or application-specific host API. */
#define COBJMACROS
#include <windows.h>
#include <d3d9.h>
#include <stdint.h>

#define WIDTH 640
#define HEIGHT 480
#define ONE 0x3f800000u

struct vertex { float x, y, z; D3DCOLOR color; };
#define V(x, y, z, color) {x, y, z, color}

/* Six distinct face colors make depth and rotation visible. Cull mode is NONE. */
static const struct vertex cube[] = {
    V(-1,-1,-1,0xffe86554), V(-1, 1,-1,0xffe86554), V( 1, 1,-1,0xffe86554),
    V(-1,-1,-1,0xffe86554), V( 1, 1,-1,0xffe86554), V( 1,-1,-1,0xffe86554),
    V( 1,-1, 1,0xff5dc5ef), V( 1, 1, 1,0xff5dc5ef), V(-1, 1, 1,0xff5dc5ef),
    V( 1,-1, 1,0xff5dc5ef), V(-1, 1, 1,0xff5dc5ef), V(-1,-1, 1,0xff5dc5ef),
    V(-1,-1, 1,0xfff2cf5b), V(-1, 1, 1,0xfff2cf5b), V(-1, 1,-1,0xfff2cf5b),
    V(-1,-1, 1,0xfff2cf5b), V(-1, 1,-1,0xfff2cf5b), V(-1,-1,-1,0xfff2cf5b),
    V( 1,-1,-1,0xff79d875), V( 1, 1,-1,0xff79d875), V( 1, 1, 1,0xff79d875),
    V( 1,-1,-1,0xff79d875), V( 1, 1, 1,0xff79d875), V( 1,-1, 1,0xff79d875),
    V(-1, 1,-1,0xffbf8fe9), V(-1, 1, 1,0xffbf8fe9), V( 1, 1, 1,0xffbf8fe9),
    V(-1, 1,-1,0xffbf8fe9), V( 1, 1, 1,0xffbf8fe9), V( 1, 1,-1,0xffbf8fe9),
    V(-1,-1, 1,0xffec9d56), V(-1,-1,-1,0xffec9d56), V( 1,-1,-1,0xffec9d56),
    V(-1,-1, 1,0xffec9d56), V( 1,-1,-1,0xffec9d56), V( 1,-1, 1,0xffec9d56),
};

/* IEEE-754 cos/sin of 0, 22.5, ..., 337.5 degrees. No runtime x87 math. */
struct rotation { uint32_t cosine, sine; };
static const struct rotation rotations[16] = {
    {0x3f800000u, 0x00000000u}, {0x3f6c835eu, 0x3ec3ef15u},
    {0x3f3504f3u, 0x3f3504f3u}, {0x3ec3ef15u, 0x3f6c835eu},
    {0x00000000u, 0x3f800000u}, {0xbec3ef15u, 0x3f6c835eu},
    {0xbf3504f3u, 0x3f3504f3u}, {0xbf6c835eu, 0x3ec3ef15u},
    {0xbf800000u, 0x00000000u}, {0xbf6c835eu, 0xbec3ef15u},
    {0xbf3504f3u, 0xbf3504f3u}, {0xbec3ef15u, 0xbf6c835eu},
    {0x00000000u, 0xbf800000u}, {0x3ec3ef15u, 0xbf6c835eu},
    {0x3f3504f3u, 0xbf3504f3u}, {0x3f6c835eu, 0xbec3ef15u},
};

/* D3D uses row-vector matrices. Camera at z=-4, near=1, far=10, FOV=60. */
static const uint32_t view[16] = {
    ONE,0,0,0, 0,ONE,0,0, 0,0,ONE,0, 0,0,0x40800000u,ONE,
};
static const uint32_t projection[16] = {
    0x3fa646e1u,0,0,0, 0,0x3fddb3d7u,0,0,
    0,0,0x3f8e38e4u,ONE, 0,0,0xbf8e38e4u,0,
};
static uint32_t world[16] = {
    ONE,0,0,0, 0,ONE,0,0, 0,0,ONE,0, 0,0,0,ONE,
};

static volatile int running = 1;

static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
{
    if (message == WM_CLOSE) { running = 0; return 0; }
    return DefWindowProcA(window, message, wparam, lparam);
}

static int run(void)
{
    const HINSTANCE instance = GetModuleHandleA(0);
    WNDCLASSA cls = {0};
    cls.lpfnWndProc = window_proc;
    cls.hInstance = instance;
    cls.lpszClassName = "WineBrowserD3D9Cube";
    if (!RegisterClassA(&cls)) return 1;

    RECT bounds = {0, 0, WIDTH, HEIGHT};
    if (!AdjustWindowRect(&bounds, WS_OVERLAPPEDWINDOW, FALSE)) return 2;
    HWND window = CreateWindowExA(0, cls.lpszClassName, "WineBrowser Direct3D 9 cube",
            WS_OVERLAPPEDWINDOW, 20, 20, bounds.right - bounds.left,
            bounds.bottom - bounds.top, 0, 0, instance, 0);
    if (!window) return 3;
    ShowWindow(window, SW_SHOW);

    IDirect3D9 *d3d = Direct3DCreate9(D3D_SDK_VERSION);
    if (!d3d) return 4;
    D3DPRESENT_PARAMETERS params = {0};
    params.BackBufferWidth = WIDTH;
    params.BackBufferHeight = HEIGHT;
    params.BackBufferFormat = D3DFMT_X8R8G8B8;
    params.BackBufferCount = 1;
    params.MultiSampleType = D3DMULTISAMPLE_NONE;
    params.SwapEffect = D3DSWAPEFFECT_DISCARD;
    params.hDeviceWindow = window;
    params.Windowed = TRUE;
    params.EnableAutoDepthStencil = TRUE;
    params.AutoDepthStencilFormat = D3DFMT_D16;
    params.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;

    IDirect3DDevice9 *device = 0;
    HRESULT status = IDirect3D9_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            window, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &params, &device);
    if (FAILED(status) || !device) return 5;
    if (FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_LIGHTING, FALSE))) return 6;
    if (FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_CULLMODE, D3DCULL_NONE))) return 7;
    if (FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_ZENABLE, D3DZB_TRUE))) return 8;
    if (FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_ZWRITEENABLE, TRUE))) return 9;
    if (FAILED(IDirect3DDevice9_SetFVF(device, D3DFVF_XYZ | D3DFVF_DIFFUSE))) return 10;
    if (FAILED(IDirect3DDevice9_SetTransform(device, D3DTS_VIEW, (const D3DMATRIX *)view))) return 11;
    if (FAILED(IDirect3DDevice9_SetTransform(device, D3DTS_PROJECTION, (const D3DMATRIX *)projection))) return 12;

    while (running) {
        MSG message;
        while (PeekMessageA(&message, 0, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) running = 0;
            else DispatchMessageA(&message);
        }
        if (!running) break;

        const struct rotation *angle = &rotations[(GetTickCount() / 80u) & 15u];
        world[0] = world[10] = angle->cosine;
        world[2] = angle->sine ^ 0x80000000u;
        world[8] = angle->sine;
        if (FAILED(IDirect3DDevice9_SetTransform(device, D3DTS_WORLD, (const D3DMATRIX *)world))) return 13;
        if (FAILED(IDirect3DDevice9_Clear(device, 0, 0, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER,
                0x00171d31u, 1.0f, 0))) return 14;
        if (FAILED(IDirect3DDevice9_BeginScene(device))) return 15;
        status = IDirect3DDevice9_DrawPrimitiveUP(device, D3DPT_TRIANGLELIST, 12,
                cube, sizeof(cube[0]));
        if (FAILED(status)) return 16;
        if (FAILED(IDirect3DDevice9_EndScene(device))) return 17;
        if (FAILED(IDirect3DDevice9_Present(device, 0, 0, 0, 0))) return 18;
        Sleep(16);
    }

    IDirect3DDevice9_Release(device);
    IDirect3D9_Release(d3d);
    DestroyWindow(window);
    return 0;
}

void mainCRTStartup(void)
{
    ExitProcess((UINT)run());
}
