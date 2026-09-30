/* Freestanding PE32 Direct3D 10 animated cube.
 *
 * The D3D10 counterpart of the D3D12 cube fixture. It exercises the parts of
 * D3D10 that differ from D3D12: an explicit input layout, direct shader-register
 * binding (constant buffers, shader resources and samplers are set per stage
 * rather than through a root signature), view objects for the render target and
 * depth buffer, and per-stage state objects. */
#define COBJMACROS
#define WIDL_C_INLINE_WRAPPERS
#include <windows.h>
#include <initguid.h>
#include <dxgi.h>
#include <d3d10.h>
#include <d3d10misc.h>
#include <stdint.h>

#include "shaders.h"

#define WIDTH 640
#define HEIGHT 480

void *memset(void *target, int value, size_t count)
{
    volatile unsigned char *bytes = target;
    while (count--) *bytes++ = (unsigned char)value;
    return target;
}
static void copy_bytes(void *target, const void *source, UINT count)
{
    volatile unsigned char *out = target;
    const unsigned char *in = source;
    while (count--) *out++ = *in++;
}

/* 24 vertices: position, colour and the face normal, so the pixel shader can
 * light the surface and the procedural checker has something to ride on. */
struct gpu_vertex { float x, y, z, w, r, g, b, a, nx, ny, nz, pad; };

#define V(x, y, z, r, g, b, nx, ny, nz) \
    {x, y, z, 1, r, g, b, 1, nx, ny, nz, 0}

static const struct gpu_vertex cube_vertices[24] = {
    V(-1,-1,-1, 1,0.2f,0.2f,  0, 0,-1), V(-1, 1,-1, 1,0.2f,0.2f,  0, 0,-1),
    V( 1, 1,-1, 1,0.2f,0.2f,  0, 0,-1), V( 1,-1,-1, 1,0.2f,0.2f,  0, 0,-1),
    V( 1,-1, 1, 0.2f,1,0.3f,  0, 0, 1), V( 1, 1, 1, 0.2f,1,0.3f,  0, 0, 1),
    V(-1, 1, 1, 0.2f,1,0.3f,  0, 0, 1), V(-1,-1, 1, 0.2f,1,0.3f,  0, 0, 1),
    V(-1,-1, 1, 0.3f,0.5f,1, -1, 0, 0), V(-1, 1, 1, 0.3f,0.5f,1, -1, 0, 0),
    V(-1, 1,-1, 0.3f,0.5f,1, -1, 0, 0), V(-1,-1,-1, 0.3f,0.5f,1, -1, 0, 0),
    V( 1,-1,-1, 1,0.9f,0.2f,  1, 0, 0), V( 1, 1,-1, 1,0.9f,0.2f,  1, 0, 0),
    V( 1, 1, 1, 1,0.9f,0.2f,  1, 0, 0), V( 1,-1, 1, 1,0.9f,0.2f,  1, 0, 0),
    V(-1, 1,-1, 0.8f,0.3f,1,  0, 1, 0), V(-1, 1, 1, 0.8f,0.3f,1,  0, 1, 0),
    V( 1, 1, 1, 0.8f,0.3f,1,  0, 1, 0), V( 1, 1,-1, 0.8f,0.3f,1,  0, 1, 0),
    V(-1,-1, 1, 0.3f,1,0.9f,  0,-1, 0), V(-1,-1,-1, 0.3f,1,0.9f,  0,-1, 0),
    V( 1,-1,-1, 0.3f,1,0.9f,  0,-1, 0), V( 1,-1, 1, 0.3f,1,0.9f,  0,-1, 0),
};
static const uint16_t cube_indices[36] = {
     0, 1, 2,  0, 2, 3,   4, 5, 6,  4, 6, 7,
     8, 9,10,  8,10,11,  12,13,14, 12,14,15,
    16,17,18, 16,18,19,  20,21,22, 20,22,23,
};

/* A 24-iteration Newton square root: the cube only needs a stable normal. */
static float sqrtf_(float value)
{
    if (value <= 0.0f) return 0.0f;
    float guess = value > 1.0f ? value : 1.0f;
    for (int i = 0; i < 24; i++) guess = 0.5f * (guess + value / guess);
    return guess;
}

/* Composes the orbit view and a D3D-style perspective as four row vectors. */
static float yaw_cos = 1.0f, yaw_sin = 0.0f;
static void build_matrix(float *rows)
{
    const float step_c = 0.9995065604f, step_s = 0.0314107591f;
    const float next_c = yaw_cos * step_c - yaw_sin * step_s;
    const float next_s = yaw_sin * step_c + yaw_cos * step_s;
    yaw_cos = next_c; yaw_sin = next_s;

    const float f = 1.0f / 0.7002075382f; /* 1 / tan(35 degrees) */
    const float aspect = 4.0f / 3.0f;
    const float near_plane = 0.5f, far_plane = 40.0f;
    const float z_scale = far_plane / (far_plane - near_plane);
    const float z_translate = -(far_plane * near_plane) / (far_plane - near_plane);
    const float eye_x = yaw_sin * 5.0f, eye_y = 2.2f, eye_z = yaw_cos * 5.0f;

    float forward[3], right[3], up[3];
    const float length = 1.0f / 5.4772255751f;
    forward[0] = -eye_x * length; forward[1] = -eye_y * length; forward[2] = -eye_z * length;
    right[0] = forward[2]; right[1] = 0.0f; right[2] = -forward[0];
    const float rlen = 1.0f / (right[0] * right[0] + right[2] * right[2] > 0.000001f
        ? sqrtf_(right[0] * right[0] + right[2] * right[2]) : 1.0f);
    right[0] *= rlen; right[2] *= rlen;
    up[0] = forward[1] * right[2] - forward[2] * right[1];
    up[1] = forward[2] * right[0] - forward[0] * right[2];
    up[2] = forward[0] * right[1] - forward[1] * right[0];

    const float right_dot = right[0] * eye_x + right[1] * eye_y + right[2] * eye_z;
    const float up_dot = up[0] * eye_x + up[1] * eye_y + up[2] * eye_z;
    const float forward_dot = forward[0] * eye_x + forward[1] * eye_y + forward[2] * eye_z;

    rows[0] = right[0] * f / aspect; rows[1] = right[1] * f / aspect;
    rows[2] = right[2] * f / aspect; rows[3] = -right_dot * f / aspect;
    rows[4] = up[0] * f; rows[5] = up[1] * f; rows[6] = up[2] * f; rows[7] = -up_dot * f;
    rows[8] = forward[0] * z_scale; rows[9] = forward[1] * z_scale;
    rows[10] = forward[2] * z_scale;
    rows[11] = -forward_dot * z_scale + z_translate;
    rows[12] = forward[0]; rows[13] = forward[1]; rows[14] = forward[2];
    rows[15] = -forward_dot;
}

static volatile int running = 1;
static const float clear_color[4] = {0.05f, 0.07f, 0.12f, 1.0f};

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
    cls.lpszClassName = "WineBrowserD3D10Cube";
    if (!RegisterClassA(&cls)) return 1;
    RECT bounds = {0, 0, WIDTH, HEIGHT};
    if (!AdjustWindowRect(&bounds, WS_OVERLAPPEDWINDOW, FALSE)) return 2;
    HWND window = CreateWindowExA(0, cls.lpszClassName, "WineBrowser Direct3D 10 cube",
            WS_OVERLAPPEDWINDOW, 20, 20, bounds.right - bounds.left,
            bounds.bottom - bounds.top, 0, 0, instance, 0);
    if (!window) return 3;
    ShowWindow(window, SW_SHOW);

    DXGI_SWAP_CHAIN_DESC swap_desc = {0};
    swap_desc.BufferDesc.Width = WIDTH;
    swap_desc.BufferDesc.Height = HEIGHT;
    swap_desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    swap_desc.SampleDesc.Count = 1;
    swap_desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    swap_desc.BufferCount = 2;
    swap_desc.OutputWindow = window;
    swap_desc.Windowed = TRUE;
    swap_desc.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

    IDXGISwapChain *swapchain = 0;
    ID3D10Device *device = 0;
    if (FAILED(D3D10CreateDeviceAndSwapChain(0, D3D10_DRIVER_TYPE_HARDWARE, 0,
            D3D10_CREATE_DEVICE_BGRA_SUPPORT, D3D10_SDK_VERSION, &swap_desc, &swapchain,
            &device)))
        return 4;

    ID3D10Texture2D *backbuffer = 0;
    if (FAILED(IDXGISwapChain_GetBuffer(swapchain, 0, &IID_ID3D10Texture2D, (void **)&backbuffer)))
        return 5;
    ID3D10RenderTargetView *rtv = 0;
    if (FAILED(ID3D10Device_CreateRenderTargetView(device, (ID3D10Resource *)backbuffer, 0, &rtv)))
        return 6;
    if (FAILED(IDXGISwapChain_GetBuffer(swapchain, 1, &IID_ID3D10Texture2D, (void **)&backbuffer)))
        return 7;
    ID3D10RenderTargetView *rtv1 = 0;
    if (FAILED(ID3D10Device_CreateRenderTargetView(device, (ID3D10Resource *)backbuffer, 0, &rtv1)))
        return 7;

    D3D10_TEXTURE2D_DESC depth_desc = {0};
    depth_desc.Width = WIDTH;
    depth_desc.Height = HEIGHT;
    depth_desc.MipLevels = 1;
    depth_desc.ArraySize = 1;
    depth_desc.Format = DXGI_FORMAT_D16_UNORM;
    depth_desc.SampleDesc.Count = 1;
    depth_desc.BindFlags = D3D10_BIND_DEPTH_STENCIL;
    ID3D10Texture2D *depth = 0;
    if (FAILED(ID3D10Device_CreateTexture2D(device, &depth_desc, 0, &depth)))
        return 8;
    ID3D10DepthStencilView *dsv = 0;
    if (FAILED(ID3D10Device_CreateDepthStencilView(device, (ID3D10Resource *)depth, 0, &dsv)))
        return 8;

    D3D10_BUFFER_DESC vertex_desc = {0};
    vertex_desc.ByteWidth = sizeof(cube_vertices);
    vertex_desc.Usage = D3D10_USAGE_IMMUTABLE;
    vertex_desc.BindFlags = D3D10_BIND_VERTEX_BUFFER;
    D3D10_SUBRESOURCE_DATA vertex_data = {0};
    vertex_data.pSysMem = cube_vertices;
    ID3D10Buffer *vertices = 0;
    if (FAILED(ID3D10Device_CreateBuffer(device, &vertex_desc, &vertex_data, &vertices)))
        return 9;

    D3D10_BUFFER_DESC index_desc = {0};
    index_desc.ByteWidth = sizeof(cube_indices);
    index_desc.Usage = D3D10_USAGE_IMMUTABLE;
    index_desc.BindFlags = D3D10_BIND_INDEX_BUFFER;
    D3D10_SUBRESOURCE_DATA index_data = {0};
    index_data.pSysMem = cube_indices;
    ID3D10Buffer *indices = 0;
    if (FAILED(ID3D10Device_CreateBuffer(device, &index_desc, &index_data, &indices)))
        return 9;

    /* The vertex stage's transform and the pixel stage's light are two
     * separate dynamic constant buffers, each bound at register b0 of its own
     * stage: the D3D10 model, where a register is per stage and there is no
     * root signature to merge them. */
    D3D10_BUFFER_DESC matrix_desc = {0};
    matrix_desc.ByteWidth = 64;
    matrix_desc.Usage = D3D10_USAGE_DYNAMIC;
    matrix_desc.BindFlags = D3D10_BIND_CONSTANT_BUFFER;
    matrix_desc.CPUAccessFlags = D3D10_CPU_ACCESS_WRITE;
    ID3D10Buffer *matrix_buffer = 0;
    if (FAILED(ID3D10Device_CreateBuffer(device, &matrix_desc, 0, &matrix_buffer)))
        return 10;

    D3D10_BUFFER_DESC light_desc = matrix_desc;
    light_desc.ByteWidth = 32;
    ID3D10Buffer *light_buffer = 0;
    if (FAILED(ID3D10Device_CreateBuffer(device, &light_desc, 0, &light_buffer)))
        return 10;

    ID3D10VertexShader *vs = 0;
    if (FAILED(ID3D10Device_CreateVertexShader(device, cube_vs, sizeof(cube_vs), &vs)))
        return 11;
    ID3D10PixelShader *ps = 0;
    if (FAILED(ID3D10Device_CreatePixelShader(device, cube_ps, sizeof(cube_ps), &ps)))
        return 11;

    /* Three elements at fixed offsets: the interleaved layout the input layout
     * describes, matched against the vertex shader's compiled signature. */
    D3D10_INPUT_ELEMENT_DESC input[] = {
        {"POSITION", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 0,
            D3D10_INPUT_PER_VERTEX_DATA, 0},
        {"COLOR", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 16,
            D3D10_INPUT_PER_VERTEX_DATA, 0},
        {"NORMAL", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 32,
            D3D10_INPUT_PER_VERTEX_DATA, 0},
    };
    ID3D10InputLayout *layout = 0;
    if (FAILED(ID3D10Device_CreateInputLayout(device, input, 3, cube_vs, sizeof(cube_vs), &layout)))
        return 12;

    D3D10_RASTERIZER_DESC raster = {0};
    raster.FillMode = D3D10_FILL_SOLID;
    raster.CullMode = D3D10_CULL_NONE;
    raster.DepthClipEnable = TRUE;
    ID3D10RasterizerState *rasterizer = 0;
    if (FAILED(ID3D10Device_CreateRasterizerState(device, &raster, &rasterizer)))
        return 13;

    D3D10_DEPTH_STENCIL_DESC depth_state = {0};
    depth_state.DepthEnable = TRUE;
    depth_state.DepthWriteMask = D3D10_DEPTH_WRITE_MASK_ALL;
    depth_state.DepthFunc = D3D10_COMPARISON_LESS_EQUAL;
    ID3D10DepthStencilState *depthStencilState = 0;
    if (FAILED(ID3D10Device_CreateDepthStencilState(device, &depth_state, &depthStencilState)))
        return 13;

    /* A real descriptor: D3D10 rejects a null one with E_INVALIDARG. Blending
     * stays off and every channel is written. */
    D3D10_BLEND_DESC blend_desc = {0};
    for (int i = 0; i < 8; i++) blend_desc.RenderTargetWriteMask[i] = D3D10_COLOR_WRITE_ENABLE_ALL;
    ID3D10BlendState *blend = 0;
    if (FAILED(ID3D10Device_CreateBlendState(device, &blend_desc, &blend)))
        return 13;

    D3D10_VIEWPORT viewport = {0, 0, WIDTH, HEIGHT, 0.0f, 1.0f};
    D3D10_RECT scissor = {0, 0, WIDTH, HEIGHT};
    UINT stride = sizeof(struct gpu_vertex), offset = 0;
    /* The vertex stage's transform and the pixel stage's light are two
     * different constant buffers, both bound at register b0 of their own stage
     * — the D3D10 model that has no root signature to merge them. */
    float matrix[16];
    float light[8];

    while (running) {
        MSG message;
        while (PeekMessageA(&message, 0, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) running = 0;
            else DispatchMessageA(&message);
        }
        if (!running) break;

        build_matrix(matrix);
        void *mapped = 0;
        if (FAILED(ID3D10Buffer_Map(matrix_buffer, D3D10_MAP_WRITE_DISCARD, 0, &mapped)))
            break;
        copy_bytes(mapped, matrix, sizeof(matrix));
        ID3D10Buffer_Unmap(matrix_buffer);

        /* A key light for the pixel stage, normalised once on the CPU. */
        light[0] = 0.47f; light[1] = 0.75f; light[2] = 0.47f; light[3] = 0.0f;
        light[4] = 1.0f; light[5] = 0.97f; light[6] = 0.90f; light[7] = 1.0f;
        void *light_mapped = 0;
        if (FAILED(ID3D10Buffer_Map(light_buffer, D3D10_MAP_WRITE_DISCARD, 0, &light_mapped)))
            break;
        copy_bytes(light_mapped, light, sizeof(light));
        ID3D10Buffer_Unmap(matrix_buffer);

        ID3D10Device_ClearRenderTargetView(device, rtv, clear_color);
        ID3D10Device_ClearDepthStencilView(device, dsv, D3D10_CLEAR_DEPTH, 1.0f, 0);
        ID3D10Device_OMSetRenderTargets(device, 1, &rtv, dsv);
        ID3D10Device_RSSetViewports(device, 1, &viewport);
        ID3D10Device_RSSetScissorRects(device, 1, &scissor);
        ID3D10Device_IASetInputLayout(device, layout);
        ID3D10Device_IASetVertexBuffers(device, 0, 1, &vertices, &stride, &offset);
        ID3D10Device_IASetIndexBuffer(device, indices, DXGI_FORMAT_R16_UINT, 0);
        ID3D10Device_IASetPrimitiveTopology(device, D3D10_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ID3D10Device_VSSetShader(device, vs);
        ID3D10Device_VSSetConstantBuffers(device, 0, 1, &matrix_buffer);
        ID3D10Device_PSSetShader(device, ps);
        ID3D10Device_PSSetConstantBuffers(device, 0, 1, &light_buffer);
        ID3D10Device_RSSetState(device, rasterizer);
        ID3D10Device_OMSetDepthStencilState(device, depthStencilState, 0);
        ID3D10Device_OMSetBlendState(device, blend, 0, 0xffffffff);
        ID3D10Device_DrawIndexed(device, 36, 0, 0);
        IDXGISwapChain_Present(swapchain, 0, 0);
        Sleep(16);
    }

    ID3D10BlendState_Release(blend);
    ID3D10DepthStencilState_Release(depthStencilState);
    ID3D10RasterizerState_Release(rasterizer);
    ID3D10InputLayout_Release(layout);
    ID3D10PixelShader_Release(ps);
    ID3D10VertexShader_Release(vs);
    ID3D10Buffer_Release(light_buffer);
    ID3D10Buffer_Release(matrix_buffer);
    ID3D10Buffer_Release(indices);
    ID3D10Buffer_Release(vertices);
    ID3D10DepthStencilView_Release(dsv);
    ID3D10Texture2D_Release(depth);
    ID3D10RenderTargetView_Release(rtv1);
    ID3D10RenderTargetView_Release(rtv);
    ID3D10Texture2D_Release(backbuffer);
    ID3D10Device_Release(device);
    IDXGISwapChain_Release(swapchain);
    DestroyWindow(window);
    return 0;
}

void mainCRTStartup(void) { ExitProcess((UINT)run()); }
