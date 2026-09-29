/* Freestanding PE32 Direct3D 12 blended overlay.
 *
 * Two passes draw the same clip-space triangle: a solid background whose
 * pipeline disables blending, then a foreground whose pipeline enables
 * SourceAlpha / OneMinusSourceAlpha blending. The final pixel therefore proves
 * the pipeline's blend state reached the renderer, not merely that a pipeline
 * was created: an unblended foreground would replace the background entirely.
 * A third pass uses additive (One / One) blending to exercise a second factor
 * pair, producing a visibly brighter intersection.
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
#define PASS_COUNT 3

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

struct vertex { float x, y, z, w, r, g, b, a; };

/* Three layers over the same region so blending is unmistakable:
 *   pass 0  opaque dark blue   (blending disabled)
 *   pass 1  half-transparent red  (SRC_ALPHA / INV_SRC_ALPHA)
 *   pass 2  additive green in the overlap (ONE / ONE)
 * Half of the frame stays background-only, so both the blended and unblended
 * results are visible in one capture. */
static const struct vertex layers[PASS_COUNT][3] = {
    { { -1.0f, -1.0f, 0.2f, 1.0f, 0.10f, 0.14f, 0.38f, 1.0f },
      {  1.0f, -1.0f, 0.2f, 1.0f, 0.10f, 0.14f, 0.38f, 1.0f },
      { -1.0f,  1.0f, 0.2f, 1.0f, 0.10f, 0.14f, 0.38f, 1.0f } },
    { { -0.9f, -0.9f, 0.1f, 1.0f, 0.90f, 0.12f, 0.10f, 0.50f },
      {  0.1f, -0.9f, 0.1f, 1.0f, 0.90f, 0.12f, 0.10f, 0.50f },
      { -0.4f,  0.9f, 0.1f, 1.0f, 0.90f, 0.12f, 0.10f, 0.50f } },
    { { -0.1f, -0.9f, 0.0f, 1.0f, 0.10f, 0.85f, 0.25f, 1.0f },
      {  0.9f, -0.9f, 0.0f, 1.0f, 0.10f, 0.85f, 0.25f, 1.0f },
      {  0.4f,  0.9f, 0.0f, 1.0f, 0.10f, 0.85f, 0.25f, 1.0f } },
};

static volatile int running = 1;
static const float clear_color[4] = {0.02f, 0.03f, 0.06f, 1.0f};
static const D3D12_VIEWPORT viewport = {0, 0, WIDTH, HEIGHT, 0, 1};
static const D3D12_RECT scissor = {0, 0, WIDTH, HEIGHT};

static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam)
{
    if (message == WM_CLOSE) { running = 0; return 0; }
    return DefWindowProcA(window, message, wparam, lparam);
}

/* Builds a pipeline state whose blend state differs per pass. */
static ID3D12PipelineState *create_pipeline(ID3D12Device *device, ID3D12RootSignature *root,
        int pass)
{
    D3D12_GRAPHICS_PIPELINE_STATE_DESC desc = {0};
    desc.pRootSignature = root;
    desc.VS.pShaderBytecode = blend_vs;
    desc.VS.BytecodeLength = sizeof(blend_vs);
    desc.PS.pShaderBytecode = blend_ps;
    desc.PS.BytecodeLength = sizeof(blend_ps);
    desc.SampleMask = 0xffffffffu;
    desc.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    desc.RasterizerState.CullMode = D3D12_CULL_MODE_NONE;
    desc.RasterizerState.DepthClipEnable = TRUE;
    /* No depth buffer: the passes are ordered and must all reach the target. */
    desc.DepthStencilState.DepthEnable = FALSE;
    desc.DepthStencilState.DepthWriteMask = D3D12_DEPTH_WRITE_MASK_ZERO;
    desc.InputLayout.pInputElementDescs = (const D3D12_INPUT_ELEMENT_DESC[]){
        {"POSITION", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 0, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
        {"COLOR", 0, DXGI_FORMAT_R32G32B32A32_FLOAT, 0, 16, D3D12_INPUT_CLASSIFICATION_PER_VERTEX_DATA, 0},
    };
    desc.InputLayout.NumElements = 2;
    desc.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    desc.NumRenderTargets = 1;
    desc.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.SampleDesc.Count = 1;
    D3D12_RENDER_TARGET_BLEND_DESC *blend = &desc.BlendState.RenderTarget[0];
    blend->RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;
    if (pass == 0) {
        /* Opaque: the write mask alone, no blending. */
    } else if (pass == 1) {
        blend->BlendEnable = TRUE;
        blend->SrcBlend = D3D12_BLEND_SRC_ALPHA;
        blend->DestBlend = D3D12_BLEND_INV_SRC_ALPHA;
        blend->BlendOp = D3D12_BLEND_OP_ADD;
        blend->SrcBlendAlpha = D3D12_BLEND_ONE;
        blend->DestBlendAlpha = D3D12_BLEND_ZERO;
        blend->BlendOpAlpha = D3D12_BLEND_OP_ADD;
    } else {
        blend->BlendEnable = TRUE;
        blend->SrcBlend = D3D12_BLEND_ONE;
        blend->DestBlend = D3D12_BLEND_ONE;
        blend->BlendOp = D3D12_BLEND_OP_ADD;
        blend->SrcBlendAlpha = D3D12_BLEND_ONE;
        blend->DestBlendAlpha = D3D12_BLEND_ONE;
        blend->BlendOpAlpha = D3D12_BLEND_OP_ADD;
    }
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
    cls.lpszClassName = "WineBrowserD3D12Blend";
    if (!RegisterClassA(&cls)) return 1;
    RECT bounds = {0, 0, WIDTH, HEIGHT};
    if (!AdjustWindowRect(&bounds, WS_OVERLAPPEDWINDOW, FALSE)) return 2;
    HWND window = CreateWindowExA(0, cls.lpszClassName, "WineBrowser Direct3D 12 blending",
            WS_OVERLAPPEDWINDOW, 20, 20, bounds.right - bounds.left,
            bounds.bottom - bounds.top, 0, 0, instance, 0);
    if (!window) return 3;
    ShowWindow(window, SW_SHOW);

    IDXGIFactory *factory = 0;
    ID3D12Device *device = 0;
    ID3D12CommandQueue *queue = 0;
    IDXGISwapChain *swapchain = 0;
    IDXGISwapChain3 *swapchain3 = 0;
    ID3D12DescriptorHeap *rtv_heap = 0;
    ID3D12Resource *buffers[BUFFER_COUNT] = {0}, *vertices = 0;
    ID3D12CommandAllocator *allocator = 0;
    ID3D12GraphicsCommandList *list = 0;
    ID3D12RootSignature *root = 0;
    ID3D12PipelineState *pipelines[PASS_COUNT] = {0};
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

    D3D12_HEAP_PROPERTIES upload_heap = {0};
    upload_heap.Type = D3D12_HEAP_TYPE_UPLOAD;
    upload_heap.CreationNodeMask = 1;
    upload_heap.VisibleNodeMask = 1;
    D3D12_RESOURCE_DESC vertex_desc = {0};
    vertex_desc.Dimension = D3D12_RESOURCE_DIMENSION_BUFFER;
    vertex_desc.Width = sizeof(layers);
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
    copy_bytes(mapped, layers, sizeof(layers));
    D3D12_RANGE written = {0, sizeof(layers)};
    ID3D12Resource_Unmap(vertices, 0, &written);

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

    for (int pass = 0; pass < PASS_COUNT; ++pass) {
        result = 30 + pass;
        pipelines[pass] = create_pipeline(device, root, pass);
        if (!pipelines[pass]) goto done;
    }
    result = 20;
    if (FAILED(ID3D12Device_CreateFence(device, 0, D3D12_FENCE_FLAG_NONE,
            &IID_ID3D12Fence, (void **)&fence))) goto done;

    D3D12_VERTEX_BUFFER_VIEW vertex_view;
    vertex_view.BufferLocation = ID3D12Resource_GetGPUVirtualAddress(vertices);
    vertex_view.SizeInBytes = sizeof(layers);
    vertex_view.StrideInBytes = sizeof(struct vertex);

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
        D3D12_RESOURCE_BARRIER barrier = {0};
        barrier.Type = D3D12_RESOURCE_BARRIER_TYPE_TRANSITION;
        barrier.Transition.pResource = buffers[index];
        barrier.Transition.Subresource = D3D12_RESOURCE_BARRIER_ALL_SUBRESOURCES;
        barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_PRESENT;
        barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_RENDER_TARGET;
        ID3D12GraphicsCommandList_ResourceBarrier(list, 1, &barrier);
        D3D12_CPU_DESCRIPTOR_HANDLE target = {rtv.ptr + index * rtv_stride};
        ID3D12GraphicsCommandList_OMSetRenderTargets(list, 1, &target, FALSE, 0);
        ID3D12GraphicsCommandList_ClearRenderTargetView(list, target, clear_color, 0, 0);
        ID3D12GraphicsCommandList_RSSetViewports(list, 1, &viewport);
        ID3D12GraphicsCommandList_RSSetScissorRects(list, 1, &scissor);
        ID3D12GraphicsCommandList_SetGraphicsRootSignature(list, root);
        ID3D12GraphicsCommandList_IASetPrimitiveTopology(list, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        /* One vertex buffer holds every layer; each pass selects its three
         * vertices with firstVertex rather than re-binding an offset view. */
        ID3D12GraphicsCommandList_IASetVertexBuffers(list, 0, 1, &vertex_view);
        for (int pass = 0; pass < PASS_COUNT; ++pass) {
            ID3D12GraphicsCommandList_SetPipelineState(list, pipelines[pass]);
            ID3D12GraphicsCommandList_DrawInstanced(list, 3, 1, pass * 3, 0);
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
    for (int pass = 0; pass < PASS_COUNT; ++pass)
        if (pipelines[pass]) ID3D12PipelineState_Release(pipelines[pass]);
    if (root) ID3D12RootSignature_Release(root);
    if (root_blob) ID3D10Blob_Release(root_blob);
    if (error_blob) ID3D10Blob_Release(error_blob);
    if (list) ID3D12GraphicsCommandList_Release(list);
    if (allocator) ID3D12CommandAllocator_Release(allocator);
    if (vertices) ID3D12Resource_Release(vertices);
    for (UINT i = 0; i < BUFFER_COUNT; ++i) if (buffers[i]) ID3D12Resource_Release(buffers[i]);
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
