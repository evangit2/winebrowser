/* Freestanding PE32 Direct3D 12 render-to-texture.
 *
 * The frame is drawn in two passes. The first renders a gradient into an
 * offscreen R8G8B8A8_UNORM texture created with ALLOW_RENDER_TARGET; the second
 * samples that texture through an SRV descriptor table and multiplies it by
 * half. The final colour therefore proves the offscreen result was stored and
 * re-read: an unrendered or unbound texture would show either the clear colour
 * or the composite shader's own output.
 *
 * This is the structure post-processing, shadow maps and deferred shading all
 * build on: draw to a texture, transition it, then sample it.
 *
 * No C runtime, pretranslated WebAssembly or browser-specific imports.
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
#define TARGET_SIZE 256u

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

/* One full-screen quad in clip space with a uv. */
struct vertex { float x, y, z, w, u, v; };
static const struct vertex quad[6] = {
    { -1.0f,  1.0f, 0.0f, 1.0f, 0.0f, 1.0f },
    {  1.0f,  1.0f, 0.0f, 1.0f, 1.0f, 1.0f },
    { -1.0f, -1.0f, 0.0f, 1.0f, 0.0f, 0.0f },
    { -1.0f, -1.0f, 0.0f, 1.0f, 0.0f, 0.0f },
    {  1.0f,  1.0f, 0.0f, 1.0f, 1.0f, 1.0f },
    {  1.0f, -1.0f, 0.0f, 1.0f, 1.0f, 0.0f },
};

static volatile int running = 1;
static const float clear_color[4] = {0.02f, 0.03f, 0.06f, 1.0f};
static const float target_clear[4] = {1.0f, 0.0f, 1.0f, 1.0f};
static const D3D12_VIEWPORT screen_viewport = {0, 0, WIDTH, HEIGHT, 0, 1};
static const D3D12_RECT screen_scissor = {0, 0, WIDTH, HEIGHT};
static const D3D12_VIEWPORT target_viewport = {0, 0, TARGET_SIZE, TARGET_SIZE, 0, 1};
static const D3D12_RECT target_scissor = {0, 0, TARGET_SIZE, TARGET_SIZE};

static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
{
    if (message == WM_CLOSE) { running = 0; return 0; }
    return DefWindowProcA(window, message, wparam, lparam);
}

static ID3D12PipelineState *create_pipeline(ID3D12Device *device, ID3D12RootSignature *root,
        const unsigned char *vertex, unsigned vertex_bytes,
        const unsigned char *pixel, unsigned pixel_bytes)
{
    D3D12_GRAPHICS_PIPELINE_STATE_DESC desc = {0};
    desc.pRootSignature = root;
    desc.VS.pShaderBytecode = vertex;
    desc.VS.BytecodeLength = vertex_bytes;
    desc.PS.pShaderBytecode = pixel;
    desc.PS.BytecodeLength = pixel_bytes;
    desc.BlendState.RenderTarget[0].RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;
    desc.SampleMask = 0xffffffffu;
    desc.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    desc.RasterizerState.CullMode = D3D12_CULL_MODE_NONE;
    desc.RasterizerState.DepthClipEnable = TRUE;
    desc.DepthStencilState.DepthEnable = FALSE;
    desc.DepthStencilState.DepthWriteMask = D3D12_DEPTH_WRITE_MASK_ZERO;
    desc.InputLayout.pInputElementDescs = (const D3D12_INPUT_ELEMENT_DESC[]){
        {"POSITION", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 0, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        {"TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 16, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
    };
    desc.InputLayout.NumElements = 2;
    desc.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    desc.NumRenderTargets = 1;
    desc.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.SampleDesc.Count = 1;
    ID3D12PipelineState *pso = 0;
    if (FAILED(ID3D12Device_CreateGraphicsPipelineState(device, &desc,
            &IID_ID3D12PipelineState, (void **)&pso))) return 0;
    return pso;
}

static int run(void)
{
    HINSTANCE instance = GetModuleHandleA(0);
    WNDCLASSA cls = {0};
    cls.lpfnWndProc = window_proc;
    cls.hInstance = instance;
    cls.lpszClassName = "WineBrowserD3D12RenderTexture";
    if (!RegisterClassA(&cls)) return 1;
    RECT bounds = {0, 0, WIDTH, HEIGHT};
    if (!AdjustWindowRect(&bounds, WS_OVERLAPPEDWINDOW, FALSE)) return 2;
    HWND window = CreateWindowExA(0, cls.lpszClassName, "WineBrowser Direct3D 12 render texture",
            WS_OVERLAPPEDWINDOW, 20, 20, bounds.right - bounds.left,
            bounds.bottom - bounds.top, 0, 0, instance, 0);
    if (!window) return 3;
    ShowWindow(window, SW_SHOW);

    IDXGIFactory *factory = 0;
    ID3D12Device *device = 0;
    ID3D12CommandQueue *queue = 0;
    IDXGISwapChain *swapchain = 0;
    IDXGISwapChain3 *swapchain3 = 0;
    ID3D12DescriptorHeap *rtv_heap = 0, *srv_heap = 0;
    ID3D12Resource *buffers[BUFFER_COUNT] = {0}, *vertices = 0;
    ID3D12Resource *target = 0;
    ID3D12CommandAllocator *allocator = 0;
    ID3D12GraphicsCommandList *list = 0;
    ID3D12RootSignature *root = 0;
    ID3D12PipelineState *draw_pso = 0, *composite_pso = 0;
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
    heap_desc.NumDescriptors = BUFFER_COUNT + 1; /* swapchain images and the render texture */
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

    D3D12_HEAP_PROPERTIES default_heap = {0};
    default_heap.Type = D3D12_HEAP_TYPE_DEFAULT;
    default_heap.CreationNodeMask = 1;
    default_heap.VisibleNodeMask = 1;

    /* The offscreen render target. ALLOW_RENDER_TARGET requires a clear value,
     * which is also the value the offscreen pass clears to. */
    D3D12_RESOURCE_DESC target_desc = {0};
    target_desc.Dimension = D3D12_RESOURCE_DIMENSION_TEXTURE2D;
    target_desc.Width = TARGET_SIZE;
    target_desc.Height = TARGET_SIZE;
    target_desc.DepthOrArraySize = 1;
    target_desc.MipLevels = 1;
    target_desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    target_desc.SampleDesc.Count = 1;
    target_desc.Layout = D3D12_TEXTURE_LAYOUT_UNKNOWN;
    target_desc.Flags = D3D12_RESOURCE_FLAG_ALLOW_RENDER_TARGET;
    D3D12_CLEAR_VALUE target_clear_value = {0};
    target_clear_value.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    for (int i = 0; i < 4; i++) target_clear_value.Color[i] = target_clear[i];
    result = 40;
    if (FAILED(ID3D12Device_CreateCommittedResource(device, &default_heap, D3D12_HEAP_FLAG_NONE,
            &target_desc, D3D12_RESOURCE_STATE_RENDER_TARGET, &target_clear_value,
            &IID_ID3D12Resource, (void **)&target))) goto done;
    D3D12_CPU_DESCRIPTOR_HANDLE target_rtv = {rtv.ptr + BUFFER_COUNT * rtv_stride};
    ID3D12Device_CreateRenderTargetView(device, target, 0, target_rtv);

    /* A shader-visible heap holding the render texture's SRV. */
    heap_desc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_CBV_SRV_UAV;
    heap_desc.NumDescriptors = 1;
    heap_desc.Flags = D3D12_DESCRIPTOR_HEAP_FLAG_SHADER_VISIBLE;
    result = 41;
    if (FAILED(ID3D12Device_CreateDescriptorHeap(device, &heap_desc, &IID_ID3D12DescriptorHeap,
            (void **)&srv_heap))) goto done;
    D3D12_SHADER_RESOURCE_VIEW_DESC srv_desc = {0};
    srv_desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    srv_desc.ViewDimension = D3D12_SRV_DIMENSION_TEXTURE2D;
    srv_desc.Shader4ComponentMapping = D3D12_DEFAULT_SHADER_4_COMPONENT_MAPPING;
    srv_desc.Texture2D.MipLevels = 1;
    ID3D12Device_CreateShaderResourceView(device, target, &srv_desc,
            ID3D12DescriptorHeap_GetCPUDescriptorHandleForHeapStart(srv_heap));

    D3D12_HEAP_PROPERTIES upload_heap = {0};
    upload_heap.Type = D3D12_HEAP_TYPE_UPLOAD;
    upload_heap.CreationNodeMask = 1;
    upload_heap.VisibleNodeMask = 1;
    D3D12_RESOURCE_DESC vertex_desc = {0};
    vertex_desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    vertex_desc.Width = sizeof(quad);
    vertex_desc.Height = 1;
    vertex_desc.DepthOrArraySize = 1;
    vertex_desc.MipLevels = 1;
    vertex_desc.SampleDesc.Count = 1;
    vertex_desc.Layout = D3D12_TEXTURE_LAYOUT_ROW_MAJOR;
    result = 13;
    if (FAILED(ID3D12Device_CreateCommittedResource(device, &upload_heap, D3D12_HEAP_FLAG_NONE,
            &vertex_desc, D3D12_RESOURCE_STATE_GENERIC_READ, 0,
            &IID_ID3D12Resource, (void **)&vertices))) goto done;
    void *mapped = 0;
    if (FAILED(ID3D12Resource_Map(vertices, 0, 0, &mapped))) goto done;
    copy_bytes(mapped, quad, sizeof(quad));
    D3D12_RANGE written = {0, sizeof(quad)};
    ID3D12Resource_Unmap(vertices, 0, &written);

    result = 15;
    if (FAILED(ID3D12Device_CreateCommandAllocator(device, D3D12_COMMAND_LIST_TYPE_DIRECT,
            &IID_ID3D12CommandAllocator, (void **)&allocator))) goto done;
    result = 16;
    if (FAILED(ID3D12Device_CreateCommandList(device, 0, D3D12_COMMAND_LIST_TYPE_DIRECT,
            allocator, 0, &IID_ID3D12GraphicsCommandList, (void **)&list))) goto done;
    if (FAILED(ID3D12GraphicsCommandList_Close(list))) goto done;

    /* Parameter 0 is an SRV descriptor table at t0; parameter 1 is a static
     * sampler at s0. */
    D3D12_DESCRIPTOR_RANGE range = {0};
    range.RangeType = D3D12_DESCRIPTOR_RANGE_TYPE_SRV;
    range.NumDescriptors = 1;
    range.BaseShaderRegister = 0;
    D3D12_ROOT_PARAMETER parameter = {0};
    parameter.ParameterType = D3D12_ROOT_PARAMETER_TYPE_DESCRIPTOR_TABLE;
    parameter.DescriptorTable.NumDescriptorRanges = 1;
    parameter.DescriptorTable.pDescriptorRanges = &range;
    parameter.ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
    D3D12_STATIC_SAMPLER_DESC sampler = {0};
    sampler.Filter = D3D12_FILTER_MIN_MAG_MIP_LINEAR;
    sampler.AddressU = sampler.AddressV = sampler.AddressW = D3D12_TEXTURE_ADDRESS_MODE_CLAMP;
    sampler.MaxAnisotropy = 1;
    sampler.ComparisonFunc = D3D12_COMPARISON_FUNC_NEVER;
    sampler.MaxLOD = 3.402823466e+38f;
    sampler.ShaderRegister = 0;
    sampler.ShaderVisibility = D3D12_SHADER_VISIBILITY_PIXEL;
    D3D12_ROOT_SIGNATURE_DESC root_desc = {0};
    root_desc.NumParameters = 1;
    root_desc.pParameters = &parameter;
    root_desc.NumStaticSamplers = 1;
    root_desc.pStaticSamplers = &sampler;
    root_desc.Flags = D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
    result = 17;
    if (FAILED(D3D12SerializeRootSignature(&root_desc, D3D_ROOT_SIGNATURE_VERSION_1,
            &root_blob, &error_blob))) goto done;
    result = 18;
    if (FAILED(ID3D12Device_CreateRootSignature(device, 0,
            ID3D10Blob_GetBufferPointer(root_blob), ID3D10Blob_GetBufferSize(root_blob),
            &IID_ID3D12RootSignature, (void **)&root))) goto done;

    result = 42;
    draw_pso = create_pipeline(device, root, rt_vs, sizeof(rt_vs),
            rt_draw_ps, sizeof(rt_draw_ps));
    if (!draw_pso) goto done;
    result = 43;
    composite_pso = create_pipeline(device, root, rt_vs, sizeof(rt_vs),
            rt_composite_ps, sizeof(rt_composite_ps));
    if (!composite_pso) goto done;
    result = 20;
    if (FAILED(ID3D12Device_CreateFence(device, 0, D3D12_FENCE_FLAG_NONE,
            &IID_ID3D12Fence, (void **)&fence))) goto done;

    D3D12_VERTEX_BUFFER_VIEW vertex_view;
    vertex_view.BufferLocation = ID3D12Resource_GetGPUVirtualAddress(vertices);
    vertex_view.SizeInBytes = sizeof(quad);
    vertex_view.StrideInBytes = sizeof(struct vertex);

    /* The render texture's current state. It is created in RENDER_TARGET, so
     * the first frame needs no transition into it, only out of it. */
    D3D12_RESOURCE_STATES target_state = D3D12_RESOURCE_STATE_RENDER_TARGET;
    UINT64 fence_value = 0;
    while (running) {
        MSG message;
        while (PeekMessageA(&message, 0, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) running = 0;
            else DispatchMessageA(&message);
        }
        if (!running) break;

        UINT index = IDXGISwapChain3_GetCurrentBackBufferIndex(swapchain3);
        result = 21;
        if (FAILED(ID3D12CommandAllocator_Reset(allocator))) goto done;
        result = 22;
        if (FAILED(ID3D12GraphicsCommandList_Reset(list, allocator, 0))) goto done;
        /* Pass 1: draw the gradient into the offscreen texture. The previous
         * frame left it shader-readable, so transition it back first. */
        if (target_state != D3D12_RESOURCE_STATE_RENDER_TARGET) {
            D3D12_RESOURCE_BARRIER into = {0};
            into.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
            into.Transition.pResource = target;
            into.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
            into.Transition.StateBefore = target_state;
            into.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
            ID3D12GraphicsCommandList_ResourceBarrier(list, 1, &into);
        }
        ID3D12GraphicsCommandList_OMSetRenderTargets(list, 1, &target_rtv, FALSE, 0);
        ID3D12GraphicsCommandList_ClearRenderTargetView(list, target_rtv, target_clear, 0, 0);
        ID3D12GraphicsCommandList_RSSetViewports(list, 1, &target_viewport);
        ID3D12GraphicsCommandList_RSSetScissorRects(list, 1, &target_scissor);
        ID3D12GraphicsCommandList_SetGraphicsRootSignature(list, root);
        ID3D12GraphicsCommandList_IASetPrimitiveTopology(list, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ID3D12GraphicsCommandList_IASetVertexBuffers(list, 0, 1, &vertex_view);
        ID3D12GraphicsCommandList_SetPipelineState(list, draw_pso);
        ID3D12GraphicsCommandList_DrawInstanced(list, 6, 1, 0, 0);

        /* Transition the texture to a shader-readable state so pass 2 can
         * sample it. */
        {
            D3D12_RESOURCE_BARRIER out = {0};
            out.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
            out.Transition.pResource = target;
            out.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
            out.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
            out.Transition.StateAfter = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;
            ID3D12GraphicsCommandList_ResourceBarrier(list, 1, &out);
        }
        target_state = D3D12_RESOURCE_STATE_PIXEL_SHADER_RESOURCE;

        /* Pass 2: present the swapchain image and composite the texture. */
        {
            D3D12_RESOURCE_BARRIER toTarget = {0};
            toTarget.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
            toTarget.Transition.pResource = buffers[index];
            toTarget.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
            toTarget.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
            toTarget.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
            ID3D12GraphicsCommandList_ResourceBarrier(list, 1, &toTarget);
        }
        D3D12_CPU_DESCRIPTOR_HANDLE screen = {rtv.ptr + index * rtv_stride};
        ID3D12GraphicsCommandList_OMSetRenderTargets(list, 1, &screen, FALSE, 0);
        ID3D12GraphicsCommandList_ClearRenderTargetView(list, screen, clear_color, 0, 0);
        ID3D12GraphicsCommandList_RSSetViewports(list, 1, &screen_viewport);
        ID3D12GraphicsCommandList_RSSetScissorRects(list, 1, &screen_scissor);
        {
            ID3D12DescriptorHeap *heaps[1] = {srv_heap};
            ID3D12GraphicsCommandList_SetDescriptorHeaps(list, 1, heaps);
            D3D12_GPU_DESCRIPTOR_HANDLE srv_gpu =
                    ID3D12DescriptorHeap_GetGPUDescriptorHandleForHeapStart(srv_heap);
            ID3D12GraphicsCommandList_SetGraphicsRootDescriptorTable(list, 0, srv_gpu);
        }
        ID3D12GraphicsCommandList_SetPipelineState(list, composite_pso);
        ID3D12GraphicsCommandList_DrawInstanced(list, 6, 1, 0, 0);

        {
            D3D12_RESOURCE_BARRIER toPresent = {0};
            toPresent.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
            toPresent.Transition.pResource = buffers[index];
            toPresent.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
            toPresent.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
            toPresent.Transition.StateAfter = D3D12_RESOURCE_STATE_PRESENT;
            ID3D12GraphicsCommandList_ResourceBarrier(list, 1, &toPresent);
        }
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
    if (composite_pso) ID3D12PipelineState_Release(composite_pso);
    if (draw_pso) ID3D12PipelineState_Release(draw_pso);
    if (root) ID3D12RootSignature_Release(root);
    if (root_blob) ID3D10Blob_Release(root_blob);
    if (error_blob) ID3D10Blob_Release(error_blob);
    if (list) ID3D12GraphicsCommandList_Release(list);
    if (allocator) ID3D12CommandAllocator_Release(allocator);
    if (vertices) ID3D12Resource_Release(vertices);
    if (target) ID3D12Resource_Release(target);
    for (UINT i = 0; i < BUFFER_COUNT; ++i) if (buffers[i]) ID3D12Resource_Release(buffers[i]);
    if (srv_heap) ID3D12DescriptorHeap_Release(srv_heap);
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
