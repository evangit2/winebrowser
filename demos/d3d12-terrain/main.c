/* Freestanding PE32 Direct3D 12 procedural terrain.
 *
 * This is a substantially richer target than the cube samples: the guest
 * generates a 129x129 height field with a value-noise function and builds a
 * 32,768-triangle indexed mesh from it, with per-vertex Gouraud colours and
 * analytic normals. The whole 300 KB vertex buffer is produced in guest memory
 * and uploaded once through the canonical upload-heap path; the per-frame
 * transform then travels in a constant buffer bound through a CBV descriptor
 * table. The pixel stage does Lambert lighting with a rim term.
 *
 * It exercises 32-bit indices, a large vertex stride, a constant buffer view,
 * an indexed draw of tens of thousands of triangles and a real per-frame camera
 * orbit. No C runtime, pretranslated WebAssembly or browser-specific imports.
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
/* A 129x129 grid gives 16,641 vertices and 32,768 triangles. */
#define GRID 129u
#define VERTEX_COUNT (GRID * GRID)
#define VERTEX_STRIDE 36u            /* position(3) + normal(3) + colour(3) */
#define VERTEX_BYTES (VERTEX_COUNT * VERTEX_STRIDE)
#define TRIANGLES (2u * (GRID - 1u) * (GRID - 1u))
#define INDEX_COUNT (TRIANGLES * 3u)
#define INDEX_BYTES (INDEX_COUNT * sizeof(uint32_t))
#define MATRIX_CONSTANTS 16u
#define MATRIX_BYTES (MATRIX_CONSTANTS * 4u)
#define TERRAIN_EXTENT 40.0f
#define HEIGHT_SCALE 6.0f

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

struct gpu_vertex { float x, y, z, nx, ny, nz, r, g, b; };

/* Host-free deterministic value noise. No libm: the terrain only needs an
 * integer hash and a smooth two-dimensional interpolation. */
static uint32_t hash2(int32_t x, int32_t z)
{
    uint32_t h = (uint32_t)(x * 374761393) ^ (uint32_t)(z * 668265263);
    h = (h ^ (h >> 13)) * 1274126177u;
    return h ^ (h >> 16);
}
static float lattice(int32_t x, int32_t z)
{
    return (float)(hash2(x, z) & 0xffff) * (1.0f / 65535.0f);
}
static float smooth(float t) { return t * t * (3.0f - 2.0f * t); }
static float value_noise(float x, float z)
{
    const int32_t x0 = (int32_t)x, z0 = (int32_t)z;
    const float fx = smooth(x - (float)x0), fz = smooth(z - (float)z0);
    const float a = lattice(x0, z0), b = lattice(x0 + 1, z0);
    const float c = lattice(x0, z0 + 1), d = lattice(x0 + 1, z0 + 1);
    const float top = a + (b - a) * fx, bottom = c + (d - c) * fx;
    return top + (bottom - top) * fz;
}
/* Four octaves of noise give ridges and valleys rather than a single bump. */
static float terrain_height(float x, float z)
{
    float sum = 0.0f, amplitude = 1.0f, frequency = 0.09f, total = 0.0f;
    for (int octave = 0; octave < 4; octave++) {
        sum += value_noise(x * frequency, z * frequency) * amplitude;
        total += amplitude;
        amplitude *= 0.5f;
        frequency *= 2.07f;
    }
    return sum / total;
}
static float sqrt_approx(float value)
{
    if (value <= 0.0f) return 0.0f;
    /* Newton iterations on a scaled guess; exact enough for unit normals. */
    float guess = value > 1.0f ? value : 1.0f;
    for (int i = 0; i < 24; i++) guess = 0.5f * (guess + value / guess);
    return guess;
}
static void normalise(float *v, float x, float y, float z)
{
    const float length = sqrt_approx(x * x + y * y + z * z);
    if (length <= 0.0f) { v[0] = 0.0f; v[1] = 1.0f; v[2] = 0.0f; return; }
    v[0] = x / length; v[1] = y / length; v[2] = z / length;
}

static float yaw_cos = 1.0f, yaw_sin = 0.0f;
static volatile float camera_radius = 30.0f;
static volatile float terrain_flatten = 0.85f;

/* Composes the orbit camera and perspective projection as four row vectors, so
 * the shader's dot products reproduce the matrix exactly. */
/* Composes the orbit camera and a D3D-style perspective projection as four row
 * vectors, so the shader's dot products reproduce the matrix exactly. The
 * camera looks at the origin from (sin*radius, height, cos*radius) and the
 * projection maps the view depth to z in [0, 1] with w = depth. */
static void build_matrix(float *rows)
{
    const float yaw_step_cos = 0.9996954135f, yaw_step_sin = 0.0246814309f;
    const float next_cos = yaw_cos * yaw_step_cos - yaw_sin * yaw_step_sin;
    const float next_sin = yaw_sin * yaw_step_cos + yaw_cos * yaw_step_sin;
    yaw_cos = next_cos; yaw_sin = next_sin;

    const float height = 22.0f;
    const float f = 1.0f / 0.5773502692f; /* 1 / tan(30 degrees) */
    const float aspect = 4.0f / 3.0f;
    const float near_plane = 0.5f, far_plane = 120.0f;
    const float z_scale = far_plane / (far_plane - near_plane);
    const float z_translate = -(far_plane * near_plane) / (far_plane - near_plane);

    const float eye_x = yaw_sin * camera_radius, eye_y = height, eye_z = yaw_cos * camera_radius;
    /* Look toward a point a little past the origin so the terrain, rather than
     * the camera's own altitude, dominates the frame. */
    const float target_x = -eye_x * 0.22f, target_y = 0.0f, target_z = -eye_z * 0.22f;
    float forward[3], right[3], up[3];
    normalise(forward, target_x - eye_x, target_y - eye_y, target_z - eye_z);
    normalise(right, forward[2], 0.0f, -forward[0]);
    normalise(up,
        forward[1] * right[2] - forward[2] * right[1],
        forward[2] * right[0] - forward[0] * right[2],
        forward[0] * right[1] - forward[1] * right[0]);

    const float right_dot = right[0] * eye_x + right[1] * eye_y + right[2] * eye_z;
    const float up_dot = up[0] * eye_x + up[1] * eye_y + up[2] * eye_z;
    const float forward_dot = forward[0] * eye_x + forward[1] * eye_y + forward[2] * eye_z;

    rows[0] = right[0] * f / aspect; rows[1] = right[1] * f / aspect;
    rows[2] = right[2] * f / aspect; rows[3] = -right_dot * f / aspect;
    rows[4] = up[0] * f; rows[5] = up[1] * f; rows[6] = up[2] * f;
    rows[7] = -up_dot * f;
    rows[8] = forward[0] * z_scale; rows[9] = forward[1] * z_scale;
    rows[10] = forward[2] * z_scale;
    rows[11] = -forward_dot * z_scale + z_translate;
    rows[12] = forward[0]; rows[13] = forward[1]; rows[14] = forward[2];
    rows[15] = -forward_dot;
}

static volatile int running = 1;
static const float clear_color[4] = {0.42f, 0.58f, 0.78f, 1.0f};
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
    cls.lpszClassName = "WineBrowserD3D12Terrain";
    if (!RegisterClassA(&cls)) return 1;
    RECT bounds = {0, 0, WIDTH, HEIGHT};
    if (!AdjustWindowRect(&bounds, WS_OVERLAPPEDWINDOW, FALSE)) return 2;
    HWND window = CreateWindowExA(0, cls.lpszClassName, "WineBrowser Direct3D 12 terrain",
            WS_OVERLAPPEDWINDOW, 20, 20, bounds.right - bounds.left,
            bounds.bottom - bounds.top, 0, 0, instance, 0);
    if (!window) return 3;
    ShowWindow(window, SW_SHOW);

    IDXGIFactory *factory = 0;
    ID3D12Device *device = 0;
    ID3D12CommandQueue *queue = 0;
    IDXGISwapChain *swapchain = 0;
    IDXGISwapChain3 *swapchain3 = 0;
    ID3D12DescriptorHeap *rtv_heap = 0, *dsv_heap = 0, *cbv_heap = 0;
    ID3D12Resource *buffers[BUFFER_COUNT] = {0}, *depth = 0, *vertices = 0, *indices = 0;
    ID3D12Resource *constant_buffer = 0;
    void *mapped_constants = 0;
    ID3D12CommandAllocator *allocator = 0;
    ID3D12GraphicsCommandList *list = 0;
    ID3D12RootSignature *root = 0;
    ID3D12PipelineState *pso = 0;
    ID3D12Fence *fence = 0;
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

    /* Build the height field and the indexed mesh in guest memory. */
    void *mapped = 0;
    if (FAILED(ID3D12Resource_Map(vertices, 0, 0, &mapped))) goto done;
    {
        struct gpu_vertex *out = mapped;
        for (UINT gz = 0; gz < GRID; ++gz) {
            for (UINT gx = 0; gx < GRID; ++gx) {
                const float u = (float)gx / (float)(GRID - 1);
                const float v = (float)gz / (float)(GRID - 1);
                const float x = (u - 0.5f) * TERRAIN_EXTENT;
                const float z = (v - 0.5f) * TERRAIN_EXTENT;
                const float h = terrain_height(u * 24.0f, v * 24.0f) * HEIGHT_SCALE * terrain_flatten;
                /* Analytic-ish normal from neighbouring samples one step away. */
                const float step = TERRAIN_EXTENT / (float)(GRID - 1);
                const float hl = terrain_height((u * 24.0f) - 0.09f * (24.0f / (GRID - 1)),
                        v * 24.0f) * HEIGHT_SCALE * terrain_flatten;
                const float hr = terrain_height((u * 24.0f) + 0.09f * (24.0f / (GRID - 1)),
                        v * 24.0f) * HEIGHT_SCALE * terrain_flatten;
                const float hd = terrain_height(u * 24.0f,
                        (v * 24.0f) - 0.09f * (24.0f / (GRID - 1))) * HEIGHT_SCALE * terrain_flatten;
                const float hu = terrain_height(u * 24.0f,
                        (v * 24.0f) + 0.09f * (24.0f / (GRID - 1))) * HEIGHT_SCALE * terrain_flatten;
                float n[3];
                normalise(n, (hl - hr) * 0.5f, step, (hd - hu) * 0.5f);
                struct gpu_vertex *vertex = &out[gz * GRID + gx];
                vertex->x = x; vertex->y = h; vertex->z = z;
                vertex->nx = n[0]; vertex->ny = n[1]; vertex->nz = n[2];
                /* Sand at the low ground, rock higher, snow on the peaks. */
                const float t = h / (HEIGHT_SCALE * terrain_flatten);
                vertex->r = 0.62f + 0.20f * t;
                vertex->g = 0.52f + 0.24f * t;
                vertex->b = 0.34f + 0.46f * t;
            }
        }
        UINT32 *tri = 0;
        D3D12_RANGE vertices_written = {0, VERTEX_BYTES};
        ID3D12Resource_Unmap(vertices, 0, &vertices_written);
        void *mapped_indices = 0;
        if (FAILED(ID3D12Resource_Map(indices, 0, 0, &mapped_indices))) goto done;
        tri = mapped_indices;
        UINT32 at = 0;
        for (UINT gz = 0; gz + 1 < GRID; ++gz) {
            for (UINT gx = 0; gx + 1 < GRID; ++gx) {
                const UINT32 v00 = gz * GRID + gx, v10 = v00 + 1;
                const UINT32 v01 = v00 + GRID, v11 = v01 + 1;
                tri[at++] = v00; tri[at++] = v01; tri[at++] = v10;
                tri[at++] = v10; tri[at++] = v01; tri[at++] = v11;
            }
        }
        if (at != INDEX_COUNT) goto done;
        D3D12_RANGE indices_written = {0, INDEX_BYTES};
        ID3D12Resource_Unmap(indices, 0, &indices_written);
    }

    /* The per-frame transform lives in a permanently mapped upload buffer. */
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
        {"POSITION", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 0, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        {"NORMAL", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 12, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        {"COLOR", 0, DXGI_FORMAT_R32G32B32_FLOAT, 0, 24, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
    };
    D3D12_GRAPHICS_PIPELINE_STATE_DESC pso_desc = {0};
    pso_desc.pRootSignature = root;
    pso_desc.VS.pShaderBytecode = terrain_vs;
    pso_desc.VS.BytecodeLength = sizeof(terrain_vs);
    pso_desc.PS.pShaderBytecode = terrain_ps;
    pso_desc.PS.BytecodeLength = sizeof(terrain_ps);
    pso_desc.BlendState.RenderTarget[0].RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;
    pso_desc.SampleMask = 0xffffffffu;
    pso_desc.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    pso_desc.RasterizerState.CullMode = D3D12_CULL_MODE_BACK;
    pso_desc.RasterizerState.DepthClipEnable = TRUE;
    pso_desc.DepthStencilState.DepthEnable = TRUE;
    pso_desc.DepthStencilState.DepthWriteMask = D3D12_DEPTH_WRITE_MASK_ALL;
    pso_desc.DepthStencilState.DepthFunc = D3D12_COMPARISON_FUNC_LESS_EQUAL;
    pso_desc.InputLayout.pInputElementDescs = input;
    pso_desc.InputLayout.NumElements = 3;
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
    index_view.Format = DXGI_FORMAT_R32_UINT;

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
        ID3D12GraphicsCommandList_DrawIndexedInstanced(list, INDEX_COUNT, 1, 0, 0, 0);
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
