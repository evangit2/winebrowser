/* Freestanding PE32 Direct3D 9 programmable-shader cube. */
#define COBJMACROS
#include <windows.h>
#include <d3d9.h>
#include <stdint.h>

#include "shaders.h"

#define WIDTH 640
#define HEIGHT 480
#define CUBE_VERTEX_COUNT 36u

struct source_vertex { float x, y, z, r, g, b, a; };
struct gpu_vertex { float x, y, z, w, r, g, b, a; };

#define TRI(x0,y0,z0, x1,y1,z1, x2,y2,z2, r,g,b) \
    {x0,y0,z0,r,g,b,1}, {x1,y1,z1,r,g,b,1}, {x2,y2,z2,r,g,b,1}
#define FACE(x0,y0,z0, x1,y1,z1, x2,y2,z2, x3,y3,z3, r,g,b) \
    TRI(x0,y0,z0, x1,y1,z1, x2,y2,z2, r,g,b), \
    TRI(x0,y0,z0, x2,y2,z2, x3,y3,z3, r,g,b)

static const struct source_vertex cube[CUBE_VERTEX_COUNT] = {
    FACE(-1,-1,-1, -1, 1,-1,  1, 1,-1,  1,-1,-1, .91f,.25f,.20f),
    FACE( 1,-1, 1,  1, 1, 1, -1, 1, 1, -1,-1, 1, .18f,.66f,.94f),
    FACE(-1,-1, 1, -1, 1, 1, -1, 1,-1, -1,-1,-1, .95f,.76f,.19f),
    FACE( 1,-1,-1,  1, 1,-1,  1, 1, 1,  1,-1, 1, .25f,.82f,.38f),
    FACE(-1, 1,-1, -1, 1, 1,  1, 1, 1,  1, 1,-1, .67f,.34f,.91f),
    FACE(-1,-1, 1, -1,-1,-1,  1,-1,-1,  1,-1, 1, .94f,.46f,.17f),
};

/* Incremental rotations exercise ordinary x87 add, subtract and multiply. */
static float yaw_cos = 1.0f, yaw_sin = 0.0f;
static float pitch_cos = 1.0f, pitch_sin = 0.0f;
static volatile float aspect = 1.333333333f;
static volatile float depth_range = 9.0f;

static void transform(struct gpu_vertex *out, float *vertex_scale, float *pixel_scale)
{
    const float yc = .9987954562f, ys = .0490676743f;
    const float pc = .9996988187f, ps = .0245412285f;
    float next_yc = yaw_cos * yc - yaw_sin * ys;
    float next_ys = yaw_sin * yc + yaw_cos * ys;
    float next_pc = pitch_cos * pc - pitch_sin * ps;
    float next_ps = pitch_sin * pc + pitch_cos * ps;
    yaw_cos = next_yc; yaw_sin = next_ys;
    pitch_cos = next_pc; pitch_sin = next_ps;

    for (UINT i = 0; i < CUBE_VERTEX_COUNT; ++i) {
        const struct source_vertex *in = &cube[i];
        float x = in->x * yaw_cos + in->z * yaw_sin;
        float yz = in->z * yaw_cos - in->x * yaw_sin;
        float y = in->y * pitch_cos - yz * pitch_sin;
        float z = in->y * pitch_sin + yz * pitch_cos + 4.25f;
        out[i].x = x * 1.732050808f / aspect;
        out[i].y = y * 1.732050808f;
        out[i].z = (z * 10.0f - 10.0f) / depth_range;
        out[i].w = z;
        out[i].r = in->r; out[i].g = in->g; out[i].b = in->b; out[i].a = in->a;
    }

    /* Both programmable stages consume visibly changing, non-identity constants. */
    vertex_scale[0] = vertex_scale[1] = .90f + .08f * yaw_cos;
    vertex_scale[2] = vertex_scale[3] = 1.0f;
    pixel_scale[0] = .78f + .20f * pitch_cos;
    pixel_scale[1] = .78f + .20f * yaw_cos;
    pixel_scale[2] = .88f + .10f * yaw_sin;
    pixel_scale[3] = 1.0f;
}

static volatile int running = 1;

static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
{
    if (message == WM_CLOSE) { running = 0; return 0; }
    return DefWindowProcA(window, message, wparam, lparam);
}

static int run(void)
{
    HINSTANCE instance = GetModuleHandleA(0);
    WNDCLASSA cls = {0};
    cls.lpfnWndProc = window_proc;
    cls.hInstance = instance;
    cls.lpszClassName = "WineBrowserD3D9ShaderCube";
    if (!RegisterClassA(&cls)) return 1;
    RECT bounds = {0, 0, WIDTH, HEIGHT};
    if (!AdjustWindowRect(&bounds, WS_OVERLAPPEDWINDOW, FALSE)) return 2;
    HWND window = CreateWindowExA(0, cls.lpszClassName, "WineBrowser D3D9 shader cube",
            WS_OVERLAPPEDWINDOW, 20, 20, bounds.right - bounds.left,
            bounds.bottom - bounds.top, 0, 0, instance, 0);
    if (!window) return 3;
    ShowWindow(window, SW_SHOW);

    IDirect3D9 *d3d = Direct3DCreate9(D3D_SDK_VERSION);
    IDirect3DDevice9 *device = 0;
    IDirect3DVertexDeclaration9 *declaration = 0;
    IDirect3DVertexShader9 *vertex_shader = 0;
    IDirect3DPixelShader9 *pixel_shader = 0;
    int result = 4;
    if (!d3d) goto done;
    D3DPRESENT_PARAMETERS params = {0};
    params.BackBufferWidth = WIDTH; params.BackBufferHeight = HEIGHT;
    params.BackBufferFormat = D3DFMT_X8R8G8B8; params.BackBufferCount = 1;
    params.SwapEffect = D3DSWAPEFFECT_DISCARD; params.hDeviceWindow = window;
    params.Windowed = TRUE; params.EnableAutoDepthStencil = TRUE;
    params.AutoDepthStencilFormat = D3DFMT_D16;
    params.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;
    if (FAILED(IDirect3D9_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, window,
            D3DCREATE_SOFTWARE_VERTEXPROCESSING, &params, &device))) goto done;

    static const D3DVERTEXELEMENT9 elements[] = {
        {0, 0, D3DDECLTYPE_FLOAT4, D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_POSITION, 0},
        {0, 16, D3DDECLTYPE_FLOAT4, D3DDECLMETHOD_DEFAULT, D3DDECLUSAGE_COLOR, 0},
        D3DDECL_END()
    };
    result = 5;
    if (FAILED(IDirect3DDevice9_CreateVertexDeclaration(device, elements, &declaration))) goto done;
    if (FAILED(IDirect3DDevice9_CreateVertexShader(device, cube_vs, &vertex_shader))) goto done;
    if (FAILED(IDirect3DDevice9_CreatePixelShader(device, cube_ps, &pixel_shader))) goto done;
    if (FAILED(IDirect3DDevice9_SetVertexDeclaration(device, declaration))) goto done;
    if (FAILED(IDirect3DDevice9_SetVertexShader(device, vertex_shader))) goto done;
    if (FAILED(IDirect3DDevice9_SetPixelShader(device, pixel_shader))) goto done;
    if (FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_CULLMODE, D3DCULL_NONE))) goto done;
    if (FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_ZENABLE, D3DZB_TRUE))) goto done;
    if (FAILED(IDirect3DDevice9_SetRenderState(device, D3DRS_ZWRITEENABLE, TRUE))) goto done;

    result = 6;
    while (running) {
        MSG message;
        while (PeekMessageA(&message, 0, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) running = 0;
            else DispatchMessageA(&message);
        }
        if (!running) break;
        struct gpu_vertex vertices[CUBE_VERTEX_COUNT];
        float vertex_scale[4], pixel_scale[4];
        transform(vertices, vertex_scale, pixel_scale);
        if (FAILED(IDirect3DDevice9_SetVertexShaderConstantF(device, 0, vertex_scale, 1))) goto done;
        if (FAILED(IDirect3DDevice9_SetPixelShaderConstantF(device, 0, pixel_scale, 1))) goto done;
        if (FAILED(IDirect3DDevice9_Clear(device, 0, 0, D3DCLEAR_TARGET | D3DCLEAR_ZBUFFER,
                0x00171d31u, 1.0f, 0))) goto done;
        if (FAILED(IDirect3DDevice9_BeginScene(device))) goto done;
        if (FAILED(IDirect3DDevice9_DrawPrimitiveUP(device, D3DPT_TRIANGLELIST, 12,
                vertices, sizeof(vertices[0])))) goto done;
        if (FAILED(IDirect3DDevice9_EndScene(device))) goto done;
        if (FAILED(IDirect3DDevice9_Present(device, 0, 0, 0, 0))) goto done;
        Sleep(16);
    }
    result = 0;

done:
    if (pixel_shader) IDirect3DPixelShader9_Release(pixel_shader);
    if (vertex_shader) IDirect3DVertexShader9_Release(vertex_shader);
    if (declaration) IDirect3DVertexDeclaration9_Release(declaration);
    if (device) IDirect3DDevice9_Release(device);
    if (d3d) IDirect3D9_Release(d3d);
    DestroyWindow(window);
    return result;
}

void mainCRTStartup(void) { ExitProcess((UINT)run()); }
