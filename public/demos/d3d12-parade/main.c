/* Freestanding PE32 Direct3D 12 animated "parade": a 3x3x3 field of
 * depth-tested, Gouraud-shaded solids (cubes and octahedra) that each spin
 * independently. All geometry, per-vertex lighting and projection run in the
 * guest on x87, then 27 indexed draws are submitted through the ordinary
 * D3D12/DXGI COM interfaces. No C runtime, pretranslated WebAssembly or
 * browser-specific imports. Close the window to exit. */
#define COBJMACROS
#define WIDL_C_INLINE_WRAPPERS
#include <windows.h>
#include <initguid.h>
#include <dxgi1_4.h>
#include <d3d12.h>
#include <d3dcommon.h>
#include <stdint.h>

#include "shaders.h"

#define WIDTH 640
#define HEIGHT 480
#define BUFFER_COUNT 2
#define GRID 3
#define OBJECT_COUNT (GRID * GRID * GRID)
#define VERTS_PER_OBJECT 24u
#define CUBE_INDEX_COUNT 36u
#define OCTA_INDEX_COUNT 24u
#define MAX_INDEX_COUNT CUBE_INDEX_COUNT
#define TOTAL_VERTEX_COUNT (OBJECT_COUNT * VERTS_PER_OBJECT)
#define VERTEX_STRIDE 32u
#define VERTEX_BYTES (TOTAL_VERTEX_COUNT * VERTEX_STRIDE)
#define TOTAL_INDEX_COUNT (OBJECT_COUNT * MAX_INDEX_COUNT)
#define INDEX_BYTES (TOTAL_INDEX_COUNT * sizeof(uint16_t))

void *memset(void *target, int value, size_t count)
{
    volatile unsigned char *bytes = target;
    while (count--) *bytes++ = (unsigned char)value;
    return target;
}

struct source_vertex { float x, y, z, nx, ny, nz, r, g, b; };
struct gpu_vertex { float x, y, z, w, r, g, b, a; };

#define FACE(nx,ny,nz, x0,y0,z0, x1,y1,z1, x2,y2,z2, x3,y3,z3) \
    {x0,y0,z0,nx,ny,nz,1,1,1}, {x1,y1,z1,nx,ny,nz,1,1,1}, \
    {x2,y2,z2,nx,ny,nz,1,1,1}, {x3,y3,z3,nx,ny,nz,1,1,1}

/* Unit cube, four vertices per face so every face has its own flat normal. */
static const struct source_vertex cube_vertices[VERTS_PER_OBJECT] = {
    FACE( 0, 0,-1, -1,-1,-1, -1, 1,-1,  1, 1,-1,  1,-1,-1),
    FACE( 0, 0, 1,  1,-1, 1,  1, 1, 1, -1, 1, 1, -1,-1, 1),
    FACE(-1, 0, 0, -1,-1, 1, -1, 1, 1, -1, 1,-1, -1,-1,-1),
    FACE( 1, 0, 0,  1,-1,-1,  1, 1,-1,  1, 1, 1,  1,-1, 1),
    FACE( 0, 1, 0, -1, 1,-1, -1, 1, 1,  1, 1, 1,  1, 1,-1),
    FACE( 0,-1, 0, -1,-1, 1, -1,-1,-1,  1,-1,-1,  1,-1, 1),
};

static const uint16_t cube_indices[CUBE_INDEX_COUNT] = {
     0, 1, 2,  0, 2, 3,   4, 5, 6,  4, 6, 7,
     8, 9,10,  8,10,11,  12,13,14, 12,14,15,
    16,17,18, 16,18,19,  20,21,22, 20,22,23,
};

#define NF (0.5773502692f)
#define TRI(nx,ny,nz, x0,y0,z0, x1,y1,z1, x2,y2,z2) \
    {x0,y0,z0,nx,ny,nz,1,1,1}, {x1,y1,z1,nx,ny,nz,1,1,1}, {x2,y2,z2,nx,ny,nz,1,1,1}

/* Unit octahedron as eight flat-shaded triangles; winding is irrelevant
 * because the pipeline disables culling. */
static const struct source_vertex octa_vertices[VERTS_PER_OBJECT] = {
    TRI( NF, NF, NF,  1,0,0,  0,1,0,  0,0,1),
    TRI(-NF, NF, NF,  0,1,0, -1,0,0,  0,0,1),
    TRI(-NF,-NF, NF, -1,0,0,  0,-1,0, 0,0,1),
    TRI( NF,-NF, NF,  0,-1,0, 1,0,0,  0,0,1),
    TRI( NF, NF,-NF,  1,0,0,  0,0,-1, 0,1,0),
    TRI(-NF, NF,-NF, -1,0,0,  0,1,0,  0,0,-1),
    TRI(-NF,-NF,-NF, -1,0,0,  0,0,-1, 0,-1,0),
    TRI( NF,-NF,-NF,  1,0,0,  0,-1,0, 0,0,-1),
};

static const uint16_t octa_indices[OCTA_INDEX_COUNT] = {
     0, 1, 2,  3, 4, 5,  6, 7, 8,  9,10,11,
    12,13,14, 15,16,17, 18,19,20, 21,22,23,
};

static const float palette[6][3] = {
    {0.93f, 0.29f, 0.24f}, {0.20f, 0.70f, 0.96f}, {0.96f, 0.78f, 0.22f},
    {0.30f, 0.85f, 0.42f}, {0.72f, 0.38f, 0.94f}, {0.98f, 0.52f, 0.20f},
};

/* Per-object independent rotation. Incremental steps avoid trigonometry while
 * exercising native x87 arithmetic. */
static float yaw_cos[OBJECT_COUNT], yaw_sin[OBJECT_COUNT];
static float pitch_cos[OBJECT_COUNT], pitch_sin[OBJECT_COUNT];
static volatile float projection_aspect = 1.333333333f;
static volatile float depth_range = 9.0f;

#define SPACING 2.15f
#define SCALE 0.54f
#define CAMERA 7.0f

static void init_rotations(void)
{
    for (int i = 0; i < OBJECT_COUNT; ++i) {
        /* Distinct starting phase per object, all still simple ratios. */
        float a = (float)((i * 37) % 90) * 0.0174532925f;
        float b = (float)((i * 53) % 90) * 0.0174532925f;
        /* cos/sin of small angles via polynomial so we avoid trig calls. */
        float aa = a * a, ab = b * b;
        yaw_cos[i] = 1.0f - aa * 0.5f + aa * aa * 0.0416666f;
        yaw_sin[i] = a * (1.0f - aa * 0.1666666f + aa * aa * 0.0083333f);
        pitch_cos[i] = 1.0f - ab * 0.5f + ab * ab * 0.0416666f;
        pitch_sin[i] = b * (1.0f - ab * 0.1666666f + ab * ab * 0.0083333f);
    }
}

static void transform_vertices(struct gpu_vertex *out)
{
    /* Fixed directional light, normalized (1,2,1). */
    const float lx = 0.40824829f, ly = 0.81649658f, lz = 0.40824829f;
    const float y_scale = 1.732050808f;
    for (int o = 0; o < OBJECT_COUNT; ++o) {
        const int gi = o % GRID, gj = (o / GRID) % GRID, gk = o / (GRID * GRID);
        const int use_octa = ((gi + gj + gk) & 1) != 0;
        const struct source_vertex *src = use_octa ? octa_vertices : cube_vertices;
        const float *tint = palette[(gi * 9 + gj * 3 + gk) % 6];
        const float cx = ((float)gi - 1.0f) * SPACING;
        const float cy = ((float)gj - 1.0f) * SPACING;
        const float cz = CAMERA + ((float)gk - 1.0f) * SPACING;

        /* Advance each object's rotation at a slightly different rate. */
        const float ystep_c = 0.9987954562f, ystep_s = 0.0490676743f;
        const float pstep_c = 0.9996988187f, pstep_s = 0.0245412285f;
        const float ry_c = yaw_cos[o] * ystep_c - yaw_sin[o] * ystep_s;
        const float ry_s = yaw_sin[o] * ystep_c + yaw_cos[o] * ystep_s;
        const float rp_c = pitch_cos[o] * pstep_c - pitch_sin[o] * pstep_s;
        const float rp_s = pitch_sin[o] * pstep_c + pitch_cos[o] * pstep_s;
        yaw_cos[o] = ry_c; yaw_sin[o] = ry_s;
        pitch_cos[o] = rp_c; pitch_sin[o] = rp_s;

        for (UINT v = 0; v < VERTS_PER_OBJECT; ++v) {
            const struct source_vertex *in = &src[v];
            float px = in->x * SCALE, py = in->y * SCALE, pz = in->z * SCALE;
            float nx = in->nx, ny = in->ny, nz = in->nz;
            /* Rotate position and normal around Y then X. */
            float x1 = px * ry_c + pz * ry_s, z1 = pz * ry_c - px * ry_s;
            float x2 = x1, y2 = py * rp_c - z1 * rp_s, z2 = py * rp_s + z1 * rp_c;
            float n1x = nx * ry_c + nz * ry_s, n1z = nz * ry_c - nx * ry_s;
            float n2x = n1x, n2y = ny * rp_c - n1z * rp_s, n2z = ny * rp_s + n1z * rp_c;
            /* World position and camera-relative depth. */
            float wx = x2 + cx, wy = y2 + cy, wz = z2 + cz;
            /* Per-vertex diffuse lighting computed on the guest CPU. */
            float ndl = n2x * lx + n2y * ly + n2z * lz;
            if (ndl < 0.0f) ndl = 0.0f;
            if (ndl > 1.0f) ndl = 1.0f;
            float lit = 0.30f + 0.70f * ndl;
            struct gpu_vertex *dst = &out[o * VERTS_PER_OBJECT + v];
            dst->x = wx * y_scale / projection_aspect;
            dst->y = wy * y_scale;
            dst->z = (wz * 10.0f - 10.0f) / depth_range;
            dst->w = wz;
            dst->r = tint[0] * lit;
            dst->g = tint[1] * lit;
            dst->b = tint[2] * lit;
            dst->a = 1.0f;
        }
    }
}

static int build_indices(uint16_t *out)
{
    const uint16_t *src;
    UINT count;
    for (int o = 0; o < OBJECT_COUNT; ++o) {
        const int gi = o % GRID, gj = (o / GRID) % GRID, gk = o / (GRID * GRID);
        const int use_octa = ((gi + gj + gk) & 1) != 0;
        src = use_octa ? octa_indices : cube_indices;
        count = use_octa ? OCTA_INDEX_COUNT : CUBE_INDEX_COUNT;
        for (UINT v = 0; v < count; ++v)
            out[o * MAX_INDEX_COUNT + v] = (uint16_t)(src[v] + o * VERTS_PER_OBJECT);
    }
    return 0;
}

static volatile int running = 1;
static const float clear_color[4] = {0.035f, 0.065f, 0.14f, 1.0f};
static const D3D12_VIEWPORT viewport = {0, 0, WIDTH, HEIGHT, 0, 1};
static const D3D12_RECT scissor = {0, 0, WIDTH, HEIGHT};

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
    cls.lpszClassName = "WineBrowserD3D12Parade";
    if (!RegisterClassA(&cls)) return 1;
    RECT bounds = {0, 0, WIDTH, HEIGHT};
    if (!AdjustWindowRect(&bounds, WS_OVERLAPPEDWINDOW, FALSE)) return 2;
    HWND window = CreateWindowExA(0, cls.lpszClassName, "WineBrowser Direct3D 12 parade",
            WS_OVERLAPPEDWINDOW, 20, 20, bounds.right - bounds.left,
            bounds.bottom - bounds.top, 0, 0, instance, 0);
    if (!window) return 3;
    ShowWindow(window, SW_SHOW);

    IDXGIFactory *factory = 0;
    ID3D12Device *device = 0;
    ID3D12CommandQueue *queue = 0;
    IDXGISwapChain *swapchain = 0;
    IDXGISwapChain3 *swapchain3 = 0;
    ID3D12DescriptorHeap *rtv_heap = 0, *dsv_heap = 0;
    ID3D12Resource *buffers[BUFFER_COUNT] = {0}, *depth = 0, *vertices = 0, *indices = 0;
    ID3D12CommandAllocator *allocator = 0;
    ID3D12GraphicsCommandList *list = 0;
    ID3D12RootSignature *root = 0;
    ID3D12PipelineState *pso = 0;
    ID3D12Fence *fence = 0;
    ID3D10Blob *root_blob = 0, *error_blob = 0;
    int result = 4;

    init_rotations();

    if (FAILED(CreateDXGIFactory1(&IID_IDXGIFactory, (void **)&factory))) goto done;
    result = 5;
    if (FAILED(D3D12CreateDevice(0, D3D_FEATURE_LEVEL_11_0, &IID_ID3D12Device, (void **)&device))) goto done;
    D3D12_COMMAND_QUEUE_DESC queue_desc = {0};
    queue_desc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    result = 6;
    if (FAILED(ID3D12Device_CreateCommandQueue(device, &queue_desc, &IID_ID3D12CommandQueue,
            (void **)&queue))) goto done;

    DXGI_SWAP_CHAIN_DESC swap_desc = {0};
    swap_desc.BufferDesc.Width = WIDTH;
    swap_desc.BufferDesc.Height = HEIGHT;
    swap_desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    swap_desc.SampleDesc.Count = 1;
    swap_desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    swap_desc.BufferCount = BUFFER_COUNT;
    swap_desc.OutputWindow = window;
    swap_desc.Windowed = TRUE;
    swap_desc.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    result = 7;
    if (FAILED(IDXGIFactory_CreateSwapChain(factory, (IUnknown *)queue, &swap_desc, &swapchain))) goto done;
    result = 8;
    if (FAILED(IDXGISwapChain_QueryInterface(swapchain, &IID_IDXGISwapChain3, (void **)&swapchain3))) goto done;

    D3D12_DESCRIPTOR_HEAP_DESC heap_desc = {0};
    heap_desc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    heap_desc.NumDescriptors = BUFFER_COUNT;
    result = 9;
    if (FAILED(ID3D12Device_CreateDescriptorHeap(device, &heap_desc, &IID_ID3D12DescriptorHeap,
            (void **)&rtv_heap))) goto done;
    D3D12_CPU_DESCRIPTOR_HANDLE rtv = ID3D12DescriptorHeap_GetCPUDescriptorHandleForHeapStart(rtv_heap);
    UINT rtv_stride = ID3D12Device_GetDescriptorHandleIncrementSize(device, D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
    for (UINT i = 0; i < BUFFER_COUNT; ++i) {
        result = 10;
        if (FAILED(IDXGISwapChain_GetBuffer(swapchain, i, &IID_ID3D12Resource, (void **)&buffers[i]))) goto done;
        D3D12_CPU_DESCRIPTOR_HANDLE handle = {rtv.ptr + i * rtv_stride};
        ID3D12Device_CreateRenderTargetView(device, buffers[i], 0, handle);
    }

    heap_desc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_DSV;
    heap_desc.NumDescriptors = 1;
    result = 11;
    if (FAILED(ID3D12Device_CreateDescriptorHeap(device, &heap_desc, &IID_ID3D12DescriptorHeap,
            (void **)&dsv_heap))) goto done;
    D3D12_CPU_DESCRIPTOR_HANDLE dsv = ID3D12DescriptorHeap_GetCPUDescriptorHandleForHeapStart(dsv_heap);

    D3D12_HEAP_PROPERTIES default_heap = {0};
    default_heap.Type = D3D12_HEAP_TYPE_DEFAULT;
    default_heap.CreationNodeMask = 1;
    default_heap.VisibleNodeMask = 1;
    D3D12_RESOURCE_DESC depth_desc = {0};
    depth_desc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    depth_desc.Width = WIDTH;
    depth_desc.Height = HEIGHT;
    depth_desc.DepthOrArraySize = 1;
    depth_desc.MipLevels = 1;
    depth_desc.Format = DXGI_FORMAT_D16_UNORM;
    depth_desc.SampleDesc.Count = 1;
    depth_desc.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
    depth_desc.Flags = D3D12_RESOURCE_FLAG_ALLOW_DEPTH_STENCIL;
    D3D12_CLEAR_VALUE depth_clear = {0};
    depth_clear.Format = DXGI_FORMAT_D16_UNORM;
    depth_clear.DepthStencil.Depth = 1.0f;
    result = 12;
    if (FAILED(ID3D12Device_CreateCommittedResource(device, &default_heap, D3D12_HEAP_FLAG_NONE,
            &depth_desc, D3D12_RESOURCE_STATE_DEPTH_WRITE, &depth_clear,
            &IID_ID3D12Resource, (void **)&depth))) goto done;
    ID3D12Device_CreateDepthStencilView(device, depth, 0, dsv);

    D3D12_HEAP_PROPERTIES upload_heap = {0};
    upload_heap.Type = D3D12_HEAP_TYPE_UPLOAD;
    upload_heap.CreationNodeMask = 1;
    upload_heap.VisibleNodeMask = 1;
    D3D12_RESOURCE_DESC vertex_desc = {0};
    vertex_desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    vertex_desc.Width = VERTEX_BYTES;
    vertex_desc.Height = 1;
    vertex_desc.DepthOrArraySize = 1;
    vertex_desc.MipLevels = 1;
    vertex_desc.SampleDesc.Count = 1;
    vertex_desc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    result = 13;
    if (FAILED(ID3D12Device_CreateCommittedResource(device, &upload_heap, D3D12_HEAP_FLAG_NONE,
            &vertex_desc, D3D12_RESOURCE_STATE_GENERIC_READ, 0,
            &IID_ID3D12Resource, (void **)&vertices))) goto done;
    D3D12_RESOURCE_DESC index_desc = vertex_desc;
    index_desc.Width = INDEX_BYTES;
    result = 14;
    if (FAILED(ID3D12Device_CreateCommittedResource(device, &upload_heap, D3D12_HEAP_FLAG_NONE,
            &index_desc, D3D12_RESOURCE_STATE_GENERIC_READ, 0,
            &IID_ID3D12Resource, (void **)&indices))) goto done;

    void *mapped_indices = 0;
    if (FAILED(ID3D12Resource_Map(indices, 0, 0, &mapped_indices))) goto done;
    build_indices((uint16_t *)mapped_indices);
    D3D12_RANGE indices_written = {0, INDEX_BYTES};
    ID3D12Resource_Unmap(indices, 0, &indices_written);

    result = 15;
    if (FAILED(ID3D12Device_CreateCommandAllocator(device, D3D12_COMMAND_LIST_TYPE_DIRECT,
            &IID_ID3D12CommandAllocator, (void **)&allocator))) goto done;
    result = 16;
    if (FAILED(ID3D12Device_CreateCommandList(device, 0, D3D12_COMMAND_LIST_TYPE_DIRECT,
            allocator, 0, &IID_ID3D12GraphicsCommandList, (void **)&list))) goto done;
    if (FAILED(ID3D12GraphicsCommandList_Close(list))) goto done;

    D3D12_ROOT_SIGNATURE_DESC root_desc = {0};
    root_desc.Flags = D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
    result = 17;
    if (FAILED(D3D12SerializeRootSignature(&root_desc, D3D_ROOT_SIGNATURE_VERSION_1,
            &root_blob, &error_blob))) goto done;
    result = 18;
    if (FAILED(ID3D12Device_CreateRootSignature(device, 0,
            ID3D10Blob_GetBufferPointer(root_blob), ID3D10Blob_GetBufferSize(root_blob),
            &IID_ID3D12RootSignature, (void **)&root))) goto done;

    static const D3D12_INPUT_ELEMENT_DESC input[] = {
        {"POSITION", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 0, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        {"COLOR", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 16, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
    };
    D3D12_GRAPHICS_PIPELINE_STATE_DESC pso_desc = {0};
    pso_desc.pRootSignature = root;
    pso_desc.VS.pShaderBytecode = parade_vs;
    pso_desc.VS.BytecodeLength = sizeof(parade_vs);
    pso_desc.PS.pShaderBytecode = parade_ps;
    pso_desc.PS.BytecodeLength = sizeof(parade_ps);
    pso_desc.BlendState.RenderTarget[0].RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;
    pso_desc.SampleMask = 0xffffffffu;
    pso_desc.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    pso_desc.RasterizerState.CullMode = D3D12_CULL_MODE_NONE;
    pso_desc.RasterizerState.DepthClipEnable = TRUE;
    pso_desc.DepthStencilState.DepthEnable = TRUE;
    pso_desc.DepthStencilState.DepthWriteMask = D3D12_DEPTH_WRITE_MASK_ALL;
    pso_desc.DepthStencilState.DepthFunc = D3D12_COMPARISON_FUNC_LESS_EQUAL;
    pso_desc.InputLayout.pInputElementDescs = input;
    pso_desc.InputLayout.NumElements = 2;
    pso_desc.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    pso_desc.NumRenderTargets = 1;
    pso_desc.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM;
    pso_desc.DSVFormat = DXGI_FORMAT_D16_UNORM;
    pso_desc.SampleDesc.Count = 1;
    result = 19;
    if (FAILED(ID3D12Device_CreateGraphicsPipelineState(device, &pso_desc,
            &IID_ID3D12PipelineState, (void **)&pso))) goto done;
    result = 20;
    if (FAILED(ID3D12Device_CreateFence(device, 0, D3D12_FENCE_FLAG_NONE,
            &IID_ID3D12Fence, (void **)&fence))) goto done;

    D3D12_VERTEX_BUFFER_VIEW vertex_view;
    vertex_view.BufferLocation = ID3D12Resource_GetGPUVirtualAddress(vertices);
    vertex_view.SizeInBytes = VERTEX_BYTES;
    vertex_view.StrideInBytes = VERTEX_STRIDE;
    D3D12_INDEX_BUFFER_VIEW index_view;
    index_view.BufferLocation = ID3D12Resource_GetGPUVirtualAddress(indices);
    index_view.SizeInBytes = INDEX_BYTES;
    index_view.Format = DXGI_FORMAT_R16_UINT;
    UINT64 fence_value = 0x100000000ull;
    while (running) {
        MSG message;
        while (PeekMessageA(&message, 0, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) running = 0;
            else DispatchMessageA(&message);
        }
        if (!running) break;

        void *mapped_vertices = 0;
        if (FAILED(ID3D12Resource_Map(vertices, 0, 0, &mapped_vertices))) goto done;
        transform_vertices((struct gpu_vertex *)mapped_vertices);
        D3D12_RANGE written = {0, VERTEX_BYTES};
        ID3D12Resource_Unmap(vertices, 0, &written);

        UINT index = IDXGISwapChain3_GetCurrentBackBufferIndex(swapchain3);
        result = 21;
        if (FAILED(ID3D12CommandAllocator_Reset(allocator))) goto done;
        result = 22;
        if (FAILED(ID3D12GraphicsCommandList_Reset(list, allocator, pso))) goto done;
        D3D12_RESOURCE_BARRIER barrier = {0};
        barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        barrier.Transition.pResource = buffers[index];
        barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
        barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
        barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
        ID3D12GraphicsCommandList_ResourceBarrier(list, 1, &barrier);
        D3D12_CPU_DESCRIPTOR_HANDLE target = {rtv.ptr + index * rtv_stride};
        ID3D12GraphicsCommandList_OMSetRenderTargets(list, 1, &target, FALSE, &dsv);
        ID3D12GraphicsCommandList_ClearRenderTargetView(list, target, clear_color, 0, 0);
        ID3D12GraphicsCommandList_ClearDepthStencilView(list, dsv,
                D3D12_CLEAR_FLAG_DEPTH, 1.0f, 0, 0, 0);
        ID3D12GraphicsCommandList_RSSetViewports(list, 1, &viewport);
        ID3D12GraphicsCommandList_RSSetScissorRects(list, 1, &scissor);
        ID3D12GraphicsCommandList_SetGraphicsRootSignature(list, root);
        ID3D12GraphicsCommandList_IASetPrimitiveTopology(list, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ID3D12GraphicsCommandList_IASetVertexBuffers(list, 0, 1, &vertex_view);
        ID3D12GraphicsCommandList_IASetIndexBuffer(list, &index_view);
        for (int o = 0; o < OBJECT_COUNT; ++o) {
            const int gi = o % GRID, gj = (o / GRID) % GRID, gk = o / (GRID * GRID);
            const int use_octa = ((gi + gj + gk) & 1) != 0;
            const UINT count = use_octa ? OCTA_INDEX_COUNT : CUBE_INDEX_COUNT;
            ID3D12GraphicsCommandList_DrawIndexedInstanced(list, count, 1,
                    o * MAX_INDEX_COUNT, 0, 0);
        }
        barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
        barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_PRESENT;
        ID3D12GraphicsCommandList_ResourceBarrier(list, 1, &barrier);
        result = 23;
        if (FAILED(ID3D12GraphicsCommandList_Close(list))) goto done;
        ID3D12CommandList *lists[1] = {(ID3D12CommandList *)list};
        ID3D12CommandQueue_ExecuteCommandLists(queue, 1, lists);
        result = 24;
        if (FAILED(IDXGISwapChain_Present(swapchain, 0, 0))) goto done;
        result = 25;
        if (FAILED(ID3D12CommandQueue_Signal(queue, fence, ++fence_value))) goto done;
        while (ID3D12Fence_GetCompletedValue(fence) < fence_value) Sleep(1);
        Sleep(16);
    }
    result = 0;

done:
    if (fence) ID3D12Fence_Release(fence);
    if (pso) ID3D12PipelineState_Release(pso);
    if (root) ID3D12RootSignature_Release(root);
    if (root_blob) ID3D10Blob_Release(root_blob);
    if (error_blob) ID3D10Blob_Release(error_blob);
    if (list) ID3D12GraphicsCommandList_Release(list);
    if (allocator) ID3D12CommandAllocator_Release(allocator);
    if (indices) ID3D12Resource_Release(indices);
    if (vertices) ID3D12Resource_Release(vertices);
    if (depth) ID3D12Resource_Release(depth);
    for (UINT i = 0; i < BUFFER_COUNT; ++i) if (buffers[i]) ID3D12Resource_Release(buffers[i]);
    if (dsv_heap) ID3D12DescriptorHeap_Release(dsv_heap);
    if (rtv_heap) ID3D12DescriptorHeap_Release(rtv_heap);
    if (swapchain3) IDXGISwapChain3_Release(swapchain3);
    if (swapchain) IDXGISwapChain_Release(swapchain);
    if (queue) ID3D12CommandQueue_Release(queue);
    if (device) ID3D12Device_Release(device);
    if (factory) IDXGIFactory_Release(factory);
    DestroyWindow(window);
    return result;
}

void mainCRTStartup(void) { ExitProcess((UINT)run()); }
