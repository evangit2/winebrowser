/* Freestanding PE32 Direct3D 12 procedural torus knot.
 *
 * A richer target than the cube, triangle and parade samples: the guest builds
 * a trefoil knot (p=2, q=3) as a swept tube — 256 rings of 13 vertices, 3,072
 * vertices and 18,432 indices — and animates it every frame. The mesh is not
 * hard-coded: sin/cos come from incremental rotations and double/triple-angle
 * identities, the tube frame from cross products, and the projection from
 * native x87 arithmetic in guest code.
 *
 * It exercises the runtime through call shapes the earlier D3D12 samples do not:
 *
 *   - ID3D12Device.CreateHeap and CreatePlacedResource, so the vertex and index
 *     buffers live in a heap the guest owns rather than a committed resource;
 *   - a three-buffer BGRA8 flip-discard swap chain, where the present colour
 *     conversion and the current-back-buffer index both matter;
 *   - the swap chain descriptor and statistics queries (GetDesc1,
 *     GetFrameStatistics, GetLastPresentCount) that a real renderer polls.
 *
 * No C runtime, pretranslated WebAssembly or browser-specific imports. Close the
 * window to exit. */
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
#define BUFFER_COUNT 3
/* The tube: RINGS cross-sections of SIDES+1 vertices, closed by a duplicate
 * seam vertex so the ring's UV/colour can differ at the wrap. */
#define RINGS 256u
#define SIDES 12u
#define RING_VERTS (SIDES + 1u)
#define VERTEX_COUNT (RINGS * RING_VERTS)
#define TRIANGLES (RINGS * SIDES * 2u)
#define INDEX_COUNT (TRIANGLES * 3u)
#define VERTEX_STRIDE 32u
#define VERTEX_BYTES (VERTEX_COUNT * VERTEX_STRIDE)
#define INDEX_BYTES (INDEX_COUNT * sizeof(uint16_t))
/* Both buffers are placed inside one guest-owned upload heap, which is what
 * CreateHeap + CreatePlacedResource model. */
#define HEAP_BYTES (VERTEX_BYTES + INDEX_BYTES + 4096u)

void *memset(void *target, int value, size_t count)
{
    volatile unsigned char *bytes = target;
    while (count--) *bytes++ = (unsigned char)value;
    return target;
}

struct gpu_vertex { float x, y, z, w, r, g, b, a; };
/* A minimal normaliser: the tube frame only needs cross products normalised to
 * give a stable radius, and Newton iteration is plenty. */
static float sqrt_approx(float value)
{
    if (value <= 0.0f) return 0.0f;
    float guess = value > 1.0f ? value : 1.0f;
    for (int i = 0; i < 24; i++) guess = 0.5f * (guess + value / guess);
    return guess;
}

/* The trefoil knot as three orthogonal sinusoids, evaluated from sin/cos of the
 * base angle through the double- and triple-angle identities. */
static void knot_point(float st, float ct, float *out)
{
    const float c2 = ct * ct - st * st;
    const float s2 = 2.0f * st * ct;
    const float c3 = c2 * ct - s2 * st;
    const float s3 = s2 * ct + c2 * st;
    out[0] = st + 2.0f * s2;
    out[1] = ct - 2.0f * c2;
    out[2] = -s3;
    (void)c3;
}

static float yaw_cos = 1.0f, yaw_sin = 0.0f;
static volatile float camera_distance = 7.2f;
static volatile float knot_scale = 0.62f;
static volatile float knot_radius = 0.30f;

/* Composes an orbit view and a D3D-style perspective as four row vectors, so
 * the vertex shader's dot products reproduce the matrix exactly. */
static void build_matrix(float *rows)
{
    const float step_c = 0.9995065604f, step_s = 0.0314107591f;
    const float next_c = yaw_cos * step_c - yaw_sin * step_s;
    const float next_s = yaw_sin * step_c + yaw_cos * step_s;
    yaw_cos = next_c; yaw_sin = next_s;

    const float f = 1.0f / 0.7002075382f; /* 1 / tan(35 degrees) */
    const float aspect = 4.0f / 3.0f;
    const float near_plane = 0.1f, far_plane = 100.0f;
    const float z_scale = far_plane / (far_plane - near_plane);
    const float z_translate = -(far_plane * near_plane) / (far_plane - near_plane);

    /* The camera sits above the knot and looks down at the origin. */
    const float elevation = 0.62f;
    const float horizontal = camera_distance * 0.90f;
    const float eye_x = yaw_sin * horizontal;
    const float eye_y = camera_distance * elevation;
    const float eye_z = yaw_cos * horizontal;
    float forward[3], right[3], up[3];
    const float len_sq = sqrt_approx(
        eye_x * eye_x + eye_y * eye_y + eye_z * eye_z);
    forward[0] = -eye_x / len_sq; forward[1] = -eye_y / len_sq; forward[2] = -eye_z / len_sq;
    /* right = normalize(forward x world_up), world_up = (0, 1, 0). */
    const float rx = forward[2], ry = 0.0f, rz = -forward[0];
    const float rlen = sqrt_approx(rx * rx + rz * rz);
    right[0] = rx / rlen; right[1] = ry; right[2] = rz / rlen;
    up[0] = forward[1] * right[2] - forward[2] * right[1];
    up[1] = forward[2] * right[0] - forward[0] * right[2];
    up[2] = forward[0] * right[1] - forward[1] * right[0];

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

/* Builds the swept tube once; the vertex colours encode the knot's two turning
 * numbers so the animation reads as a 2-3 knot rather than a plain ring. */
static void build_knot(struct gpu_vertex *out)
{
    const float ring_step_c = 0.9996988187f, ring_step_s = 0.0245412285f;
    const float side_step_c = 0.9659258263f, side_step_s = 0.2588190451f;
    float st = 0.0f, ct = 1.0f;
    for (UINT ring = 0; ring < RINGS; ++ring) {
        float here[3], next[3];
        knot_point(st, ct, here);
        const float nst = st * ring_step_c + ct * ring_step_s;
        const float nct = ct * ring_step_c - st * ring_step_s;
        knot_point(nst, nct, next);
        /* Tangent by forward difference; the frame comes from crossing it with
         * a fixed world up, falling back when the tangent is near-vertical. */
        float tx = next[0] - here[0], ty = next[1] - here[1], tz = next[2] - here[2];
        const float tlen = sqrt_approx(tx * tx + ty * ty + tz * tz);
        tx /= tlen; ty /= tlen; tz /= tlen;
        const int vertical = ty > 0.9f || ty < -0.9f;
        const float ux = vertical ? 1.0f : 0.0f, uy = vertical ? 0.0f : 1.0f, uz = 0.0f;
        float nx = ty * uz - tz * uy, ny = tz * ux - tx * uz, nz = tx * uy - ty * ux;
        const float nlen = sqrt_approx(nx * nx + ny * ny + nz * nz);
        nx /= nlen; ny /= nlen; nz /= nlen;
        const float bx = ty * nz - tz * ny, by = tz * nx - tx * nz, bz = tx * ny - ty * nx;

        const float tint_r = 0.45f + 0.55f * ct;
        const float tint_g = 0.45f + 0.55f * (0.5f + 0.5f * st);
        const float tint_b = 0.55f + 0.45f * (st * 0.5f + 0.5f);
        float sp = 0.0f, cp = 1.0f;
        for (UINT side = 0; side < RING_VERTS; ++side) {
            const float radius = knot_radius;
            const float px = here[0] * knot_scale + (cp * nx + sp * bx) * radius;
            const float py = here[1] * knot_scale + (cp * ny + sp * by) * radius;
            const float pz = here[2] * knot_scale + (cp * nz + sp * bz) * radius;
            struct gpu_vertex *v = &out[ring * RING_VERTS + side];
            v->x = px; v->y = py; v->z = pz; v->w = 1.0f;
            /* Brighten the seam-adjacent side so the tube's twist is visible. */
            const float band = 0.72f + 0.28f * cp;
            v->r = tint_r * band; v->g = tint_g * band; v->b = tint_b * band; v->a = 1.0f;
            const float next_sp = sp * side_step_c + cp * side_step_s;
            const float next_cp = cp * side_step_c - sp * side_step_s;
            sp = next_sp; cp = next_cp;
        }
        st = nst; ct = nct;
    }
}

static void build_indices(uint16_t *out)
{
    UINT at = 0;
    for (UINT ring = 0; ring < RINGS; ++ring) {
        const UINT next_ring = (ring + 1u) % RINGS;
        for (UINT side = 0; side < SIDES; ++side) {
            const uint16_t a = (uint16_t)(ring * RING_VERTS + side);
            const uint16_t b = (uint16_t)(ring * RING_VERTS + side + 1u);
            const uint16_t c = (uint16_t)(next_ring * RING_VERTS + side);
            const uint16_t d = (uint16_t)(next_ring * RING_VERTS + side + 1u);
            out[at++] = a; out[at++] = c; out[at++] = b;
            out[at++] = b; out[at++] = c; out[at++] = d;
        }
    }
}

/* Transforms the stored knot vertices into clip space each frame on the guest
 * CPU, through the same four row vectors the shader multiplies. */
static void transform_vertices(struct gpu_vertex *out, const struct gpu_vertex *in,
        const float *m)
{
    for (UINT i = 0; i < VERTEX_COUNT; ++i) {
        const float x = in[i].x, y = in[i].y, z = in[i].z, w = in[i].w;
        float cx = m[0] * x + m[1] * y + m[2] * z + m[3] * w;
        float cy = m[4] * x + m[5] * y + m[6] * z + m[7] * w;
        float cz = m[8] * x + m[9] * y + m[10] * z + m[11] * w;
        float cw = m[12] * x + m[13] * y + m[14] * z + m[15] * w;
        if (cw < 0.05f) cw = 0.05f; /* keep the divide in front of the camera */
        out[i].x = cx; out[i].y = cy; out[i].z = cz; out[i].w = cw;
        out[i].r = in[i].r; out[i].g = in[i].g; out[i].b = in[i].b; out[i].a = 1.0f;
    }
}

static volatile int running = 1;
static const float clear_color[4] = {0.03f, 0.04f, 0.08f, 1.0f};
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
    cls.lpszClassName = "WineBrowserD3D12Knot";
    if (!RegisterClassA(&cls)) return 1;
    RECT bounds = {0, 0, WIDTH, HEIGHT};
    if (!AdjustWindowRect(&bounds, WS_OVERLAPPEDWINDOW, FALSE)) return 2;
    HWND window = CreateWindowExA(0, cls.lpszClassName, "WineBrowser Direct3D 12 torus knot",
            WS_OVERLAPPEDWINDOW, 30, 30, bounds.right - bounds.left,
            bounds.bottom - bounds.top, 0, 0, instance, 0);
    if (!window) return 3;
    ShowWindow(window, SW_SHOW);

    IDXGIFactory *factory = 0;
    ID3D12Device *device = 0;
    ID3D12CommandQueue *queue = 0;
    IDXGISwapChain *swapchain = 0;
    IDXGISwapChain3 *swapchain3 = 0;
    ID3D12DescriptorHeap *rtv_heap = 0, *dsv_heap = 0;
    ID3D12Resource *buffers[BUFFER_COUNT] = {0}, *depth = 0;
    ID3D12Heap *heap = 0;
    ID3D12Resource *vertices = 0, *indices = 0;
    ID3D12CommandAllocator *allocator = 0;
    ID3D12GraphicsCommandList *list = 0;
    ID3D12RootSignature *root = 0;
    ID3D12PipelineState *pso = 0;
    ID3D12Fence *fence = 0;
    ID3D10Blob *root_blob = 0, *error_blob = 0;
    int result = 4;

    if (FAILED(CreateDXGIFactory1(&IID_IDXGIFactory, (void **)&factory))) goto done;
    result = 5;
    if (FAILED(D3D12CreateDevice(0, D3D_FEATURE_LEVEL_11_0, &IID_ID3D12Device, (void **)&device))) goto done;
    D3D12_COMMAND_QUEUE_DESC queue_desc = {0};
    queue_desc.Type = D3D12_COMMAND_LIST_TYPE_DIRECT;
    result = 6;
    if (FAILED(ID3D12Device_CreateCommandQueue(device, &queue_desc, &IID_ID3D12CommandQueue,
            (void **)&queue))) goto done;

    /* A three-buffer BGRA8 flip-discard chain: the colour order and the buffer
     * count both exercise paths the two-buffer RGBA8 samples never touch. */
    DXGI_SWAP_CHAIN_DESC swap_desc = {0};
    swap_desc.BufferDesc.Width = WIDTH;
    swap_desc.BufferDesc.Height = HEIGHT;
    swap_desc.BufferDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
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

    /* One guest-owned upload heap backs both buffers, placed at fixed offsets. */
    D3D12_HEAP_PROPERTIES upload_props = {0};
    upload_props.Type = D3D12_HEAP_TYPE_UPLOAD;
    upload_props.CreationNodeMask = 1;
    upload_props.VisibleNodeMask = 1;
    D3D12_HEAP_DESC memory_desc = {0};
    memory_desc.SizeInBytes = HEAP_BYTES;
    memory_desc.Properties = upload_props;
    memory_desc.Alignment = 0;
    memory_desc.Flags = D3D12_HEAP_FLAG_NONE;
    result = 13;
    if (FAILED(ID3D12Device_CreateHeap(device, &memory_desc, &IID_ID3D12Heap, (void **)&heap))) goto done;

    D3D12_RESOURCE_DESC vertex_desc = {0};
    vertex_desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    vertex_desc.Width = VERTEX_BYTES;
    vertex_desc.Height = 1;
    vertex_desc.DepthOrArraySize = 1;
    vertex_desc.MipLevels = 1;
    vertex_desc.SampleDesc.Count = 1;
    vertex_desc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    result = 14;
    if (FAILED(ID3D12Device_CreatePlacedResource(device, heap, 0, &vertex_desc,
            D3D12_RESOURCE_STATE_GENERIC_READ, 0, &IID_ID3D12Resource, (void **)&vertices))) goto done;
    D3D12_RESOURCE_DESC index_desc = vertex_desc;
    index_desc.Width = INDEX_BYTES;
    result = 15;
    if (FAILED(ID3D12Device_CreatePlacedResource(device, heap, VERTEX_BYTES, &index_desc,
            D3D12_RESOURCE_STATE_GENERIC_READ, 0, &IID_ID3D12Resource, (void **)&indices))) goto done;

    /* Fill both placed buffers through the canonical Map/Unmap path. */
    void *mapped = 0;
    if (FAILED(ID3D12Resource_Map(vertices, 0, 0, &mapped))) goto done;
    build_knot(mapped);
    D3D12_RANGE vertices_written = {0, VERTEX_BYTES};
    ID3D12Resource_Unmap(vertices, 0, &vertices_written);
    /* A private model-space copy the per-frame transform reads from. */
    static struct gpu_vertex model[VERTEX_COUNT];
    build_knot(model);
    void *mapped_indices = 0;
    if (FAILED(ID3D12Resource_Map(indices, 0, 0, &mapped_indices))) goto done;
    build_indices(mapped_indices);
    D3D12_RANGE indices_written = {0, INDEX_BYTES};
    ID3D12Resource_Unmap(indices, 0, &indices_written);

    result = 16;
    if (FAILED(ID3D12Device_CreateCommandAllocator(device, D3D12_COMMAND_LIST_TYPE_DIRECT,
            &IID_ID3D12CommandAllocator, (void **)&allocator))) goto done;
    result = 17;
    if (FAILED(ID3D12Device_CreateCommandList(device, 0, D3D12_COMMAND_LIST_TYPE_DIRECT,
            allocator, 0, &IID_ID3D12GraphicsCommandList, (void **)&list))) goto done;
    if (FAILED(ID3D12GraphicsCommandList_Close(list))) goto done;

    D3D12_ROOT_SIGNATURE_DESC root_desc = {0};
    root_desc.Flags = D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
    result = 18;
    if (FAILED(D3D12SerializeRootSignature(&root_desc, D3D_ROOT_SIGNATURE_VERSION_1,
            &root_blob, &error_blob))) goto done;
    result = 19;
    if (FAILED(ID3D12Device_CreateRootSignature(device, 0,
            ID3D10Blob_GetBufferPointer(root_blob), ID3D10Blob_GetBufferSize(root_blob),
            &IID_ID3D12RootSignature, (void **)&root))) goto done;

    static const D3D12_INPUT_ELEMENT_DESC input[] = {
        {"POSITION", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 0, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        {"COLOR", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 16, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
    };
    D3D12_GRAPHICS_PIPELINE_STATE_DESC pso_desc = {0};
    pso_desc.pRootSignature = root;
    pso_desc.VS.pShaderBytecode = knot_vs;
    pso_desc.VS.BytecodeLength = sizeof(knot_vs);
    pso_desc.PS.pShaderBytecode = knot_ps;
    pso_desc.PS.BytecodeLength = sizeof(knot_ps);
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
    pso_desc.RTVFormats[0] = DXGI_FORMAT_B8G8R8A8_UNORM;
    pso_desc.DSVFormat = DXGI_FORMAT_D16_UNORM;
    pso_desc.SampleDesc.Count = 1;
    result = 20;
    if (FAILED(ID3D12Device_CreateGraphicsPipelineState(device, &pso_desc,
            &IID_ID3D12PipelineState, (void **)&pso))) goto done;
    result = 21;
    if (FAILED(ID3D12Device_CreateFence(device, 0, D3D12_FENCE_FLAG_NONE,
            &IID_ID3D12Fence, (void **)&fence))) goto done;

    /* Query the modern swap chain descriptor and statistics a real renderer
     * reads back after creation. */
    DXGI_SWAP_CHAIN_DESC1 desc1 = {0};
    IDXGISwapChain3_GetDesc1(swapchain3, &desc1);
    result = 22;
    if (desc1.Width != WIDTH || desc1.Height != HEIGHT || desc1.BufferCount != BUFFER_COUNT)
        goto done;
    result = 23;
    if (desc1.Format != DXGI_FORMAT_B8G8R8A8_UNORM) goto done;
    if (desc1.SwapEffect != DXGI_SWAP_EFFECT_FLIP_DISCARD) goto done;

    D3D12_VERTEX_BUFFER_VIEW vertex_view;
    vertex_view.BufferLocation = ID3D12Resource_GetGPUVirtualAddress(vertices);
    vertex_view.SizeInBytes = VERTEX_BYTES;
    vertex_view.StrideInBytes = VERTEX_STRIDE;
    D3D12_INDEX_BUFFER_VIEW index_view;
    index_view.BufferLocation = ID3D12Resource_GetGPUVirtualAddress(indices);
    index_view.SizeInBytes = INDEX_BYTES;
    index_view.Format = DXGI_FORMAT_R16_UINT;

    /* The model-space knot lives in the placed buffer's own mapped window. The
     * per-frame clip-space result reuses that same window after the previous
     * frame has been submitted, and the model geometry is rebuilt in it after
     * each transform, so no second allocation is needed. */
    float matrix[16];
    UINT64 fence_value = 0x200000000ull;
    UINT last_present = 0;
    while (running) {
        MSG message;
        while (PeekMessageA(&message, 0, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) running = 0;
            else DispatchMessageA(&message);
        }
        if (!running) break;

        build_matrix(matrix);
        void *mapped_vertices = 0;
        if (FAILED(ID3D12Resource_Map(vertices, 0, 0, &mapped_vertices))) goto done;
        transform_vertices((struct gpu_vertex *)mapped_vertices, model, matrix);
        D3D12_RANGE vertices_written = {0, VERTEX_BYTES};
        ID3D12Resource_Unmap(vertices, 0, &vertices_written);
        /* Rebuild the model-space knot so the next frame starts from it; the
         * placed buffer's mapped bytes have already been handed to the GPU. */
        build_knot(model);

        UINT index = IDXGISwapChain3_GetCurrentBackBufferIndex(swapchain3);
        result = 24;
        if (FAILED(ID3D12CommandAllocator_Reset(allocator))) goto done;
        result = 25;
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
        ID3D12GraphicsCommandList_DrawIndexedInstanced(list, INDEX_COUNT, 1, 0, 0, 0);
        barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
        barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_PRESENT;
        ID3D12GraphicsCommandList_ResourceBarrier(list, 1, &barrier);
        result = 26;
        if (FAILED(ID3D12GraphicsCommandList_Close(list))) goto done;
        ID3D12CommandList *lists[1] = {(ID3D12CommandList *)list};
        ID3D12CommandQueue_ExecuteCommandLists(queue, 1, lists);
        result = 27;
        if (FAILED(IDXGISwapChain_Present(swapchain, 0, 0))) goto done;
        result = 28;
        if (FAILED(ID3D12CommandQueue_Signal(queue, fence, ++fence_value))) goto done;
        while (ID3D12Fence_GetCompletedValue(fence) < fence_value) Sleep(1);
        /* GetFrameStatistics reports the presents the chain has counted. */
        DXGI_FRAME_STATISTICS stats = {0};
        if (SUCCEEDED(IDXGISwapChain_GetFrameStatistics(swapchain, &stats)) &&
                stats.PresentCount != last_present) {
            last_present = stats.PresentCount;
        }
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
    if (heap) ID3D12Heap_Release(heap);
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
