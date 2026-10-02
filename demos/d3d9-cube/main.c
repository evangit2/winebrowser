/* Native PE32 Direct3D 9 cube. No C runtime or application-specific host API. */
#define COBJMACROS
#include <windows.h>
#ifndef WINEBROWSER_D3D8
#include <d3d9.h>
#endif
#include <stdint.h>

#ifndef D3D_VERSION_TEXT
#define D3D_VERSION_TEXT "9"
#endif

#ifndef WIDTH
#define WIDTH 640
#define HEIGHT 480
#endif
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

/* Buffer pools are independent of texture pool restrictions. These real COM
 * calls retain DYNAMIC usage in managed/system-memory descriptors, lock and
 * fill exact bytes, and feed the same cube to indexed draws. */
static int create_dynamic_cube(IDirect3DDevice9 *device, D3DPOOL pool,
        IDirect3DVertexBuffer9 **vb, IDirect3DIndexBuffer9 **ib)
{
    D3DVERTEXBUFFER_DESC vd;
    D3DINDEXBUFFER_DESC id;
    void *data = 0;
    const DWORD usage = D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY;
    if (FAILED(IDirect3DDevice9_CreateVertexBuffer(device, sizeof(cube), usage,
            D3DFVF_XYZ | D3DFVF_DIFFUSE, pool, vb, 0)) || !*vb) return 45;
    if (FAILED(IDirect3DVertexBuffer9_GetDesc(*vb, &vd)) || vd.Usage != usage ||
            vd.Pool != pool || vd.Size != sizeof(cube) || vd.FVF != (D3DFVF_XYZ | D3DFVF_DIFFUSE)) return 46;
    if (FAILED(IDirect3DVertexBuffer9_Lock(*vb, 0, 0, &data, D3DLOCK_DISCARD)) || !data) return 47;
    for (UINT i = 0; i < sizeof(cube); i++) ((BYTE *)data)[i] = ((const BYTE *)cube)[i];
    if (FAILED(IDirect3DVertexBuffer9_Unlock(*vb))) return 48;
    if (FAILED(IDirect3DDevice9_CreateIndexBuffer(device, 72, usage, D3DFMT_INDEX16, pool, ib, 0)) || !*ib) return 49;
    if (FAILED(IDirect3DIndexBuffer9_GetDesc(*ib, &id)) || id.Usage != usage || id.Pool != pool ||
            id.Size != 72 || id.Format != D3DFMT_INDEX16) return 50;
    if (FAILED(IDirect3DIndexBuffer9_Lock(*ib, 0, 0, &data, D3DLOCK_DISCARD)) || !data) return 51;
    for (UINT i = 0; i < 36; i++) ((WORD *)data)[i] = (WORD)i;
    return FAILED(IDirect3DIndexBuffer9_Unlock(*ib)) ? 52 : 0;
}

static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
{
    if (message == WM_KEYDOWN && wparam == VK_ESCAPE) { running = 0; return 0; }
    if (message == WM_CLOSE) { running = 0; return 0; }
    return DefWindowProcA(window, message, wparam, lparam);
}

static int run(void)
{
    const HINSTANCE instance = GetModuleHandleA(0);
    WNDCLASSA cls = {0};
    cls.lpfnWndProc = window_proc;
    cls.hInstance = instance;
    cls.lpszClassName = "WineBrowserD3D" D3D_VERSION_TEXT "Cube";
    if (!RegisterClassA(&cls)) return 1;

    RECT bounds = {0, 0, WIDTH, HEIGHT};
    if (!AdjustWindowRect(&bounds, WS_OVERLAPPEDWINDOW, FALSE)) return 2;
    HWND window = CreateWindowExA(0, cls.lpszClassName, "WineBrowser Direct3D " D3D_VERSION_TEXT " cube",
            WS_OVERLAPPEDWINDOW, 20, 20, bounds.right - bounds.left,
            bounds.bottom - bounds.top, 0, 0, instance, 0);
    if (!window) return 3;
    ShowWindow(window, SW_SHOW);

    IDirect3D9 *d3d = Direct3DCreate9(D3D_SDK_VERSION);
    if (!d3d) return 4;
    D3DCAPS9 caps, device_caps;
    if (FAILED(IDirect3D9_GetDeviceCaps(d3d, 0, D3DDEVTYPE_HAL, &caps)) ||
        caps.DeviceType != D3DDEVTYPE_HAL || caps.AdapterOrdinal != 0 ||
        (caps.PrimitiveMiscCaps & (D3DPMISCCAPS_CULLNONE | D3DPMISCCAPS_CULLCW | D3DPMISCCAPS_CULLCCW)) !=
            (D3DPMISCCAPS_CULLNONE | D3DPMISCCAPS_CULLCW | D3DPMISCCAPS_CULLCCW) ||
        caps.ZCmpCaps != 0xff || !(caps.RasterCaps & D3DPRASTERCAPS_DITHER) ||
        caps.MaxPrimitiveCount < 21845 || caps.MaxVertexW <= 0 ||
        // The runtime implements stencil KEEP/ZERO/REPLACE/INCRSAT/DECRSAT/INVERT/
        // INCR/DECR but not two-sided stencil, and one fixed-function stage.
        caps.MaxTextureWidth != 2048 || caps.MaxSimultaneousTextures < 8 ||
        caps.StencilCaps != (D3DSTENCILCAPS_KEEP | D3DSTENCILCAPS_ZERO | D3DSTENCILCAPS_REPLACE |
            D3DSTENCILCAPS_INCRSAT | D3DSTENCILCAPS_DECRSAT | D3DSTENCILCAPS_INVERT |
            D3DSTENCILCAPS_INCR | D3DSTENCILCAPS_DECR)) return 36;
    D3DDISPLAYMODE desktop = {0}, enumerated = {0};
    if (FAILED(IDirect3D9_GetAdapterDisplayMode(d3d, 0, &desktop)) ||
            desktop.Width != (UINT)GetSystemMetrics(SM_CXSCREEN) ||
            desktop.Height != (UINT)GetSystemMetrics(SM_CYSCREEN) ||
            desktop.RefreshRate != 60 || desktop.Format != D3DFMT_X8R8G8B8) return 30;
    UINT mode_count = IDirect3D9_GetAdapterModeCount(d3d, 0, desktop.Format);
    if (!mode_count ||
            IDirect3D9_GetAdapterModeCount(d3d, 1, desktop.Format) != 0 ||
            FAILED(IDirect3D9_EnumAdapterModes(d3d, 0, desktop.Format, 0, &enumerated)) ||
            enumerated.Width != desktop.Width || enumerated.Height != desktop.Height ||
            enumerated.Format != desktop.Format || enumerated.RefreshRate != desktop.RefreshRate)
        return 31;
    enumerated.Width = 123;
    if (IDirect3D9_EnumAdapterModes(d3d, 0, desktop.Format, mode_count, &enumerated) != D3DERR_INVALIDCALL ||
            enumerated.Width != 123 ||
            IDirect3D9_GetAdapterDisplayMode(d3d, 1, &enumerated) != D3DERR_INVALIDCALL ||
            enumerated.Width != 123) return 32;
    // The renderer supplies depth-only attachments: D16 and D24S8 both work,
    // while formats needing real stencil or 32-bit depth must stay unadvertised.
    if (FAILED(IDirect3D9_CheckDepthStencilMatch(d3d, 0, D3DDEVTYPE_HAL, desktop.Format,
                    D3DFMT_X8R8G8B8, D3DFMT_D16)) ||
            FAILED(IDirect3D9_CheckDepthStencilMatch(d3d, 0, D3DDEVTYPE_HAL, desktop.Format,
                    D3DFMT_X8R8G8B8, D3DFMT_D24S8)) ||
            IDirect3D9_CheckDepthStencilMatch(d3d, 0, D3DDEVTYPE_HAL, desktop.Format,
                    D3DFMT_X8R8G8B8, D3DFMT_D15S1) != D3DERR_NOTAVAILABLE) return 33;
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
#ifdef WINEBROWSER_FULLSCREEN
    params.BackBufferFormat = D3DFMT_R5G6B5;
    params.Windowed = FALSE;
    params.SwapEffect = D3DSWAPEFFECT_FLIP;
    params.PresentationInterval = D3DPRESENT_INTERVAL_ONE;
    RECT original;
    GetWindowRect(window, &original);
    LONG original_style = GetWindowLongA(window, GWL_STYLE);
#endif

    IDirect3DDevice9 *device = 0;
    HRESULT status = IDirect3D9_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL,
            window, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &params, &device);
    if (FAILED(status) || !device) return 5;
    IDirect3DVertexBuffer9 *buffers[2] = {0, 0};
    IDirect3DIndexBuffer9 *indices[2] = {0, 0};
    for (UINT i = 0; i < 2; i++) {
        int result = create_dynamic_cube(device, i ? D3DPOOL_SYSTEMMEM : D3DPOOL_MANAGED,
                &buffers[i], &indices[i]);
        if (result) return result;
    }
    IDirect3D9 *original_d3d = d3d;
    IDirect3D9_Release(d3d);
    d3d = 0;
    if (FAILED(IDirect3DDevice9_GetDirect3D(device, &d3d)) || d3d != original_d3d) return 42;
    D3DDISPLAYMODE device_mode, adapter_mode;
    if (FAILED(IDirect3DDevice9_GetDisplayMode(device, 0, &device_mode)) ||
        FAILED(IDirect3D9_GetAdapterDisplayMode(d3d, 0, &adapter_mode)) ||
        device_mode.Width != adapter_mode.Width || device_mode.Height != adapter_mode.Height ||
        device_mode.RefreshRate != adapter_mode.RefreshRate || device_mode.Format != adapter_mode.Format)
        return 44;
    if (FAILED(IDirect3DDevice9_GetDeviceCaps(device, &device_caps))) return 37;
    for (UINT i = 0; i < sizeof(caps) / sizeof(DWORD); i++)
        if (((DWORD *)&caps)[i] != ((DWORD *)&device_caps)[i]) return 38;
    D3DVIEWPORT9 viewport, returned, small = {16, 16, 32, 32, 0.25f, 0.75f};
    if (FAILED(IDirect3DDevice9_GetViewport(device, &viewport)) || viewport.X || viewport.Y ||
        viewport.Width != WIDTH || viewport.Height != HEIGHT || viewport.MinZ != 0 || viewport.MaxZ != 1)
        return 39;
    if (FAILED(IDirect3DDevice9_SetViewport(device, &small)) ||
        FAILED(IDirect3DDevice9_GetViewport(device, &returned)) ||
        returned.X != small.X || returned.Y != small.Y || returned.Width != small.Width ||
        returned.Height != small.Height || returned.MinZ != small.MinZ || returned.MaxZ != small.MaxZ)
        return 40;
    if (FAILED(IDirect3DDevice9_SetViewport(device, &viewport))) return 41;
#ifdef WINEBROWSER_FULLSCREEN
    D3DDISPLAYMODE active;
    RECT fullscreen;
    GetWindowRect(window, &fullscreen);
    if (GetSystemMetrics(SM_CXSCREEN) != WIDTH || GetSystemMetrics(SM_CYSCREEN) != HEIGHT ||
        FAILED(IDirect3D9_GetAdapterDisplayMode(d3d, 0, &active)) || active.Format != D3DFMT_R5G6B5 ||
        fullscreen.left || fullscreen.top || fullscreen.right != WIDTH || fullscreen.bottom != HEIGHT)
        return 34;
#endif
    if (FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_LIGHTING, FALSE))) return 6;
    if (FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_CULLMODE, D3DCULL_NONE))) return 7;
    if (FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_ZENABLE, D3DZB_TRUE))) return 8;
    if (FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_ZWRITEENABLE, TRUE))) return 9;
    if (FAILED(IDirect3DDevice9_SetFVF(device, D3DFVF_XYZ | D3DFVF_DIFFUSE))) return 10;
    if (FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_DITHERENABLE, TRUE))) return 42;
    if (FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_SHADEMODE, D3DSHADE_GOURAUD)) ||
        FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_FILLMODE, D3DFILL_SOLID)) ||
        FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_CLIPPING, TRUE))) return 43;
    if (FAILED(IDirect3DDevice9_SetTransform(device, D3DTS_VIEW, (const D3DMATRIX *)view))) return 11;
    if (FAILED(IDirect3DDevice9_SetTransform(device, D3DTS_PROJECTION, (const D3DMATRIX *)projection))) return 12;

    UINT frame = 0;
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
        if (frame % 3 == 0) {
            status = IDirect3DDevice9_DrawPrimitiveUP(device, D3DPT_TRIANGLELIST, 12,
                    cube, sizeof(cube[0]));
        } else {
            UINT index = frame % 3 - 1;
            if (FAILED(IDirect3DDevice9_SetStreamSource(device, 0, buffers[index], 0, sizeof(cube[0]))) ||
                    FAILED(IDirect3DDevice9_SetIndices(device, indices[index]))) return 53;
            status = IDirect3DDevice9_DrawIndexedPrimitive(device, D3DPT_TRIANGLELIST, 0, 0, 36, 0, 12);
        }
        if (FAILED(status)) return 16;
        if (FAILED(IDirect3DDevice9_EndScene(device))) return 17;
        if (FAILED(IDirect3DDevice9_Present(device, 0, 0, 0, 0))) return 18;
        frame++;
        Sleep(16);
    }

    IDirect3DDevice9_SetStreamSource(device, 0, 0, 0, 0);
    IDirect3DDevice9_SetIndices(device, 0);
    for (UINT i = 0; i < 2; i++) {
        IDirect3DVertexBuffer9_Release(buffers[i]);
        IDirect3DIndexBuffer9_Release(indices[i]);
    }
    IDirect3DDevice9_Release(device);
    if (IDirect3D9_GetAdapterCount(d3d) != 1) return 43;
#ifdef WINEBROWSER_FULLSCREEN
    RECT restored;
    GetWindowRect(window, &restored);
    if (GetSystemMetrics(SM_CXSCREEN) != (int)desktop.Width ||
        GetSystemMetrics(SM_CYSCREEN) != (int)desktop.Height ||
        GetWindowLongA(window, GWL_STYLE) != original_style ||
        restored.left != original.left || restored.top != original.top ||
        restored.right != original.right || restored.bottom != original.bottom) return 35;
#endif
    IDirect3D9_Release(d3d);
    DestroyWindow(window);
    return 0;
}

void mainCRTStartup(void)
{
    ExitProcess((UINT)run());
}
