/* Freestanding PE32 Direct3D 12 cube driven by a constant buffer.
 *
 * The per-frame transform travels in an upload-heap constant buffer that the
 * vertex shader reads through a constant buffer view bound by a descriptor
 * table, the D3D12HelloConstBuffers shape. Each frame maps the buffer, writes
 * the matrix and unmaps; the shader does the multiply on the GPU. No C
 * runtime, pretranslated WebAssembly or browser-specific imports.
 * Close the window to exit. */
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
#define CUBE_VERTEX_COUNT 24u
#define CUBE_VERTEX_STRIDE 32u
#define CUBE_INDEX_COUNT 36u
#define VERTEX_BYTES (CUBE_VERTEX_COUNT * CUBE_VERTEX_STRIDE)
#define INDEX_BYTES (CUBE_INDEX_COUNT * sizeof(uint16_t))
#define MATRIX_CONSTANTS 16u
#define MATRIX_BYTES (MATRIX_CONSTANTS * 4u)

void *memset(void *target, int value, size_t count)
{
    volatile unsigned char *bytes = target;
    while (count--) *bytes++ = (unsigned char)value;
    return target;
}
static void copy_bytes(void *target, const void *source, size_t count)
{
    volatile unsigned char *out = target;
    const unsigned char *in = source;
    while (count--) *out++ = *in++;
}

struct source_vertex { float x, y, z, nx, ny, nz, r, g, b; };
struct gpu_vertex { float x, y, z, w, r, g, b, a; };

#define FACE(nx,ny,nz, x0,y0,z0, x1,y1,z1, x2,y2,z2, x3,y3,z3, cr,cg,cb) \
    {x0,y0,z0,nx,ny,nz,cr,cg,cb}, {x1,y1,z1,nx,ny,nz,cr,cg,cb}, \
    {x2,y2,z2,nx,ny,nz,cr,cg,cb}, {x3,y3,z3,nx,ny,nz,cr,cg,cb}

/* Unit cube, four vertices per face so every face has its own flat normal. */
static const struct source_vertex cube_vertices[CUBE_VERTEX_COUNT] = {
    FACE( 0, 0,-1, -1,-1,-1, -1, 1,-1,  1, 1,-1,  1,-1,-1, .90f,.40f,.33f),
    FACE( 0, 0, 1,  1,-1, 1,  1, 1, 1, -1, 1, 1, -1,-1, 1, .36f,.77f,.94f),
    FACE(-1, 0, 0, -1,-1, 1, -1, 1, 1, -1, 1,-1, -1,-1,-1, .95f,.76f,.19f),
    FACE( 1, 0, 0,  1,-1,-1,  1, 1,-1,  1, 1, 1,  1,-1, 1, .25f,.82f,.38f),
    FACE( 0, 1, 0, -1, 1,-1, -1, 1, 1,  1, 1, 1,  1, 1,-1, .67f,.34f,.91f),
    FACE( 0,-1, 0, -1,-1, 1, -1,-1,-1,  1,-1,-1,  1,-1, 1, .94f,.46f,.17f),
};

static const uint16_t cube_indices[CUBE_INDEX_COUNT] = {
     0, 1, 2,  0, 2, 3,   4, 5, 6,  4, 6, 7,
     8, 9,10,  8,10,11,  12,13,14, 12,14,15,
    16,17,18, 16,18,19,  20,21,22, 20,22,23,
};

/* Incremental rotations avoid trigonometry while exercising native x87 math. */
static float yaw_cos = 1.0f, yaw_sin = 0.0f;
static float pitch_cos = 1.0f, pitch_sin = 0.0f;
static volatile float projection_aspect = 1.333333333f;
static volatile float depth_range = 9.0f;
static volatile float camera_distance = 4.25f;

/* Composes the same yaw/pitch rotation, camera translation and projection the
 * fixed-function cube applies per vertex, but as four row-major float4 rows:
 * out = M * (x, y, z, 1). The shader evaluates the dot products. */
static void build_matrix(float *rows)
{
    const float yaw_step_cos = 0.9987954562f, yaw_step_sin = 0.0490676743f;
    const float pitch_step_cos = 0.9996988187f, pitch_step_sin = 0.0245412285f;
    const float y_scale = 1.732050808f;
    float next_yaw_cos = yaw_cos * yaw_step_cos - yaw_sin * yaw_step_sin;
    float next_yaw_sin = yaw_sin * yaw_step_cos + yaw_cos * yaw_step_sin;
    float next_pitch_cos = pitch_cos * pitch_step_cos - pitch_sin * pitch_step_sin;
    float next_pitch_sin = pitch_sin * pitch_step_cos + pitch_cos * pitch_step_sin;
    yaw_cos = next_yaw_cos; yaw_sin = next_yaw_sin;
    pitch_cos = next_pitch_cos; pitch_sin = next_pitch_sin;

    const float aspect_scale = y_scale / projection_aspect;
    const float z_scale = 10.0f / depth_range;

    /* Row 0: x' = (yaw_cos * x + yaw_sin * z) * y_scale / aspect. */
    rows[0] = yaw_cos * aspect_scale;
    rows[1] = 0.0f;
    rows[2] = yaw_sin * aspect_scale;
    rows[3] = 0.0f;

    /* Row 1: y' = y_scale * (pitch_cos * y - pitch_sin * (-yaw_sin*x + yaw_cos*z)). */
    rows[4] = y_scale * pitch_sin * yaw_sin;
    rows[5] = y_scale * pitch_cos;
    rows[6] = -y_scale * pitch_sin * yaw_cos;
    rows[7] = 0.0f;

    /* Camera-space z: z_c = pitch_sin*y + pitch_cos*(-yaw_sin*x + yaw_cos*z) + camera. */
    const float ca = -pitch_cos * yaw_sin;
    const float cb = pitch_sin;
    const float cc = pitch_cos * yaw_cos;
    const float cd = camera_distance;

    /* Row 2: the fixed-function form is z' = (z_c * 10 - 10) / depth_range,
     * which expands to z_c * (10/depth_range) - 10/depth_range. Since z_c is
     * linear in (x, y, z), the constant term is -10/depth_range, not
     * (camera * 10 - 10) * z_scale. */
    rows[8] = ca * z_scale;
    rows[9] = cb * z_scale;
    rows[10] = cc * z_scale;
    rows[11] = cd * z_scale - 10.0f / depth_range;

    /* Row 3: w' = z_c, the value D3D's perspective divide uses. */
    rows[12] = ca;
    rows[13] = cb;
    rows[14] = cc;
    rows[15] = cd;
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
    cls.lpszClassName = "WineBrowserD3D12ConstBuffer";
    if (!RegisterClassA(&cls)) return 1;
    RECT bounds = {0, 0, WIDTH, HEIGHT};
    if (!AdjustWindowRect(&bounds, WS_OVERLAPPEDWINDOW, FALSE)) return 2;
    HWND window = CreateWindowExA(0, cls.lpszClassName, "WineBrowser Direct3D 12 constant buffer",
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
    ID3D12Resource *constant_buffer = 0;
    ID3D12DescriptorHeap *cbv_heap = 0;
    void *mapped_constants = 0;
    ID3DBlob *root_blob = 0, *error_blob = 0;
    int result = 4;

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

    /* The vertex buffer is written once: position and colour only, in unit-cube
     * space. Every later transform happens in the vertex shader. */
    void *mapped = 0;
    if (FAILED(ID3D12Resource_Map(vertices, 0, 0, &mapped))) goto done;
    {
        struct gpu_vertex *out = mapped;
        for (UINT i = 0; i < CUBE_VERTEX_COUNT; ++i) {
            out[i].x = cube_vertices[i].x;
            out[i].y = cube_vertices[i].y;
            out[i].z = cube_vertices[i].z;
            out[i].w = 1.0f;
            out[i].r = cube_vertices[i].r;
            out[i].g = cube_vertices[i].g;
            out[i].b = cube_vertices[i].b;
            out[i].a = 1.0f;
        }
    }
    D3D12_RANGE vertices_written = {0, VERTEX_BYTES};
    ID3D12Resource_Unmap(vertices, 0, &vertices_written);

    void *mapped_indices = 0;
    if (FAILED(ID3D12Resource_Map(indices, 0, 0, &mapped_indices))) goto done;
    copy_bytes(mapped_indices, cube_indices, INDEX_BYTES);
    D3D12_RANGE indices_written = {0, INDEX_BYTES};
    ID3D12Resource_Unmap(indices, 0, &indices_written);

    /* The transform lives in a permanently mapped upload buffer, exactly as
     * D3D12HelloConstBuffers does it, and is read through a constant buffer
     * view bound by a descriptor table. */
    D3D12_RESOURCE_DESC constant_desc = {0};
    constant_desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    constant_desc.Width = 256;
    constant_desc.Height = 1;
    constant_desc.DepthOrArraySize = 1;
    constant_desc.MipLevels = 1;
    constant_desc.SampleDesc.Count = 1;
    constant_desc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    result = 29;
    if (FAILED(ID3D12Device_CreateCommittedResource(device, &upload_heap, D3D12_HEAP_FLAG_NONE,
            &constant_desc, D3D12_RESOURCE_STATE_GENERIC_READ, 0,
            &IID_ID3D12Resource, (void **)&constant_buffer))) goto done;
    if (FAILED(ID3D12Resource_Map(constant_buffer, 0, 0, &mapped_constants))) goto done;

    heap_desc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;
    heap_desc.NumDescriptors = 1;
    heap_desc.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;
    result = 28;
    if (FAILED(ID3D12Device_CreateDescriptorHeap(device, &heap_desc, &IID_ID3D12DescriptorHeap,
            (void **)&cbv_heap))) goto done;
    D3D12_CONSTANT_BUFFER_VIEW_DESC cbv_desc = {0};
    cbv_desc.BufferLocation = ID3D12Resource_GetGPUVirtualAddress(constant_buffer);
    cbv_desc.SizeInBytes = 256;
    ID3D12Device_CreateConstantBufferView(device, &cbv_desc,
            ID3D12DescriptorHeap_GetCPUDescriptorHandleForHeapStart(cbv_heap));

    result = 15;
    if (FAILED(ID3D12Device_CreateCommandAllocator(device, D3D12_COMMAND_LIST_TYPE_DIRECT,
            &IID_ID3D12CommandAllocator, (void **)&allocator))) goto done;
    result = 16;
    if (FAILED(ID3D12Device_CreateCommandList(device, 0, D3D12_COMMAND_LIST_TYPE_DIRECT,
            allocator, 0, &IID_ID3D12GraphicsCommandList, (void **)&list))) goto done;
    if (FAILED(ID3D12GraphicsCommandList_Close(list))) goto done;

    /* One descriptor table holding a single CBV at HLSL cbuffer register b0,
     * visible to the vertex shader that reads the transform. */
    D3D12_DESCRIPTOR_RANGE range = {0};
    range.RangeType = D3D12_DESCRIPTOR_RANGE_TYPE_CBV;
    range.NumDescriptors = 1;
    range.BaseShaderRegister = 0;
    D3D12_ROOT_PARAMETER parameter = {0};
    parameter.ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    parameter.DescriptorTable.NumDescriptorRanges = 1;
    parameter.DescriptorTable.pDescriptorRanges = &range;
    parameter.ShaderVisibility = D3D12_SHADER_VISIBILITY_VERTEX;
    D3D12_ROOT_SIGNATURE_DESC root_desc = {0};
    root_desc.NumParameters = 1;
    root_desc.pParameters = &parameter;
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
    pso_desc.VS.pShaderBytecode = constbuffer_vs;
    pso_desc.VS.BytecodeLength = sizeof(constbuffer_vs);
    pso_desc.PS.pShaderBytecode = constbuffer_ps;
    pso_desc.PS.BytecodeLength = sizeof(constbuffer_ps);
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
    vertex_view.StrideInBytes = CUBE_VERTEX_STRIDE;
    D3D12_INDEX_BUFFER_VIEW index_view;
    index_view.BufferLocation = ID3D12Resource_GetGPUVirtualAddress(indices);
    index_view.SizeInBytes = INDEX_BYTES;
    index_view.Format = DXGI_FORMAT_R16_UINT;

    float matrix[MATRIX_CONSTANTS];
    UINT64 fence_value = 0;
    while (running) {
        MSG message;
        while (PeekMessageA(&message, 0, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) running = 0;
            else DispatchMessageA(&message);
        }
        if (!running) break;

        build_matrix(matrix);
        copy_bytes(mapped_constants, matrix, MATRIX_BYTES);
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
        {
            ID3D12DescriptorHeap *heaps[1] = {cbv_heap};
            ID3D12GraphicsCommandList_SetDescriptorHeaps(list, 1, heaps);
            D3D12_GPU_DESCRIPTOR_HANDLE cbv_gpu =
                    ID3D12DescriptorHeap_GetGPUDescriptorHandleForHeapStart(cbv_heap);
            ID3D12GraphicsCommandList_SetGraphicsRootDescriptorTable(list, 0, cbv_gpu);
        }
        ID3D12GraphicsCommandList_IASetPrimitiveTopology(list, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ID3D12GraphicsCommandList_IASetVertexBuffers(list, 0, 1, &vertex_view);
        ID3D12GraphicsCommandList_IASetIndexBuffer(list, &index_view);
        ID3D12GraphicsCommandList_DrawIndexedInstanced(list, CUBE_INDEX_COUNT, 1, 0, 0, 0);
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
    if (cbv_heap) ID3D12DescriptorHeap_Release(cbv_heap);
    if (constant_buffer) ID3D12Resource_Release(constant_buffer);
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
