/* Freestanding PE32 Direct3D 12 demo: native COM calls, no C runtime. */
#define COBJMACROS
#define WIDL_C_INLINE_WRAPPERS
#include <windows.h>
#include <initguid.h>
#include <dxgi.h>
#include <d3d12.h>
#include <d3dcommon.h>
#include <stdint.h>

/* Large zero-initialized stack descriptors may make GCC emit this helper. */
void *memset(void *target, int value, size_t count)
{
    volatile unsigned char *bytes = (volatile unsigned char *)target;
    while (count--) *bytes++ = (unsigned char)value;
    return target;
}

#define WIDTH 640
#define HEIGHT 480
#define BUFFER_COUNT 2

/* Extracted from Wine 11.0 dlls/d3d12/tests/d3d12.c; see SHADERS-LICENSE. */
#include "shaders.h"

static volatile int running = 1;
static const float clear_color[4] = {0.055f, 0.095f, 0.19f, 1.0f};
static const D3D12_VIEWPORT viewports[4] = {
    { 48.0f, 50.0f, 360.0f, 300.0f, 0.0f, 1.0f },
    { 96.0f, 50.0f, 360.0f, 300.0f, 0.0f, 1.0f },
    { 144.0f, 50.0f, 360.0f, 300.0f, 0.0f, 1.0f },
    { 96.0f, 100.0f, 360.0f, 300.0f, 0.0f, 1.0f },
};
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
    cls.lpszClassName = "WineBrowserD3D12Triangle";
    if (!RegisterClassA(&cls)) return 1;
    RECT bounds = {0, 0, WIDTH, HEIGHT};
    if (!AdjustWindowRect(&bounds, WS_OVERLAPPEDWINDOW, FALSE)) return 2;
    HWND window = CreateWindowExA(0, cls.lpszClassName, "WineBrowser Direct3D 12 shader triangle",
            WS_OVERLAPPEDWINDOW, 20, 20, bounds.right - bounds.left,
            bounds.bottom - bounds.top, 0, 0, instance, 0);
    if (!window) return 3;
    ShowWindow(window, SW_SHOW);

    IDXGIFactory *factory = 0;
    ID3D12Device *device = 0;
    ID3D12CommandQueue *queue = 0;
    IDXGISwapChain *swapchain = 0;
    ID3D12DescriptorHeap *rtv_heap = 0;
    ID3D12Resource *buffers[BUFFER_COUNT] = {0};
    ID3D12CommandAllocator *allocator = 0;
    ID3D12GraphicsCommandList *list = 0;
    ID3D12RootSignature *root = 0;
    ID3D12PipelineState *pso = 0;
    ID3D12Fence *fence = 0;
    ID3DBlob *root_blob = 0;
    ID3DBlob *error_blob = 0;
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

    D3D12_DESCRIPTOR_HEAP_DESC heap_desc = {0};
    heap_desc.Type = D3D12_DESCRIPTOR_HEAP_TYPE_RTV;
    heap_desc.NumDescriptors = BUFFER_COUNT;
    result = 8;
    if (FAILED(ID3D12Device_CreateDescriptorHeap(device, &heap_desc, &IID_ID3D12DescriptorHeap,
            (void **)&rtv_heap))) goto done;
    D3D12_CPU_DESCRIPTOR_HANDLE rtv = ID3D12DescriptorHeap_GetCPUDescriptorHandleForHeapStart(rtv_heap);
    UINT rtv_stride = ID3D12Device_GetDescriptorHandleIncrementSize(device, D3D12_DESCRIPTOR_HEAP_TYPE_RTV);
    for (UINT i = 0; i < BUFFER_COUNT; ++i) {
        result = 9;
        if (FAILED(IDXGISwapChain_GetBuffer(swapchain, i, &IID_ID3D12Resource, (void **)&buffers[i]))) goto done;
        D3D12_CPU_DESCRIPTOR_HANDLE handle = {rtv.ptr + i * rtv_stride};
        ID3D12Device_CreateRenderTargetView(device, buffers[i], 0, handle);
    }

    result = 10;
    if (FAILED(ID3D12Device_CreateCommandAllocator(device, D3D12_COMMAND_LIST_TYPE_DIRECT,
            &IID_ID3D12CommandAllocator, (void **)&allocator))) goto done;
    result = 11;
    if (FAILED(ID3D12Device_CreateCommandList(device, 0, D3D12_COMMAND_LIST_TYPE_DIRECT,
            allocator, 0, &IID_ID3D12GraphicsCommandList, (void **)&list))) goto done;
    if (FAILED(ID3D12GraphicsCommandList_Close(list))) goto done;

    D3D12_ROOT_SIGNATURE_DESC root_desc = {0};
    root_desc.Flags = D3D12_ROOT_SIGNATURE_FLAG_ALLOW_INPUT_ASSEMBLER_INPUT_LAYOUT;
    result = 12;
    if (FAILED(D3D12SerializeRootSignature(&root_desc, D3D_ROOT_SIGNATURE_VERSION_1,
            &root_blob, &error_blob))) goto done;
    result = 13;
    if (FAILED(ID3D12Device_CreateRootSignature(device, 0,
            ID3D10Blob_GetBufferPointer(root_blob), ID3D10Blob_GetBufferSize(root_blob),
            &IID_ID3D12RootSignature, (void **)&root))) goto done;

    D3D12_GRAPHICS_PIPELINE_STATE_DESC pso_desc = {0};
    pso_desc.pRootSignature = root;
    pso_desc.VS.pShaderBytecode = shader_vs;
    pso_desc.VS.BytecodeLength = sizeof(shader_vs);
    pso_desc.PS.pShaderBytecode = shader_ps;
    pso_desc.PS.BytecodeLength = sizeof(shader_ps);
    pso_desc.RasterizerState.FillMode = D3D12_FILL_MODE_SOLID;
    pso_desc.RasterizerState.CullMode = D3D12_CULL_MODE_NONE;
    pso_desc.RasterizerState.DepthClipEnable = TRUE;
    pso_desc.BlendState.RenderTarget[0].RenderTargetWriteMask = D3D12_COLOR_WRITE_ENABLE_ALL;
    pso_desc.SampleMask = 0xffffffffu;
    pso_desc.PrimitiveTopologyType = D3D12_PRIMITIVE_TOPOLOGY_TYPE_TRIANGLE;
    pso_desc.NumRenderTargets = 1;
    pso_desc.RTVFormats[0] = DXGI_FORMAT_R8G8B8A8_UNORM;
    pso_desc.SampleDesc.Count = 1;
    result = 14;
    if (FAILED(ID3D12Device_CreateGraphicsPipelineState(device, &pso_desc,
            &IID_ID3D12PipelineState, (void **)&pso))) goto done;

    result = 15;
    if (FAILED(ID3D12Device_CreateFence(device, 0, D3D12_FENCE_FLAG_NONE,
            &IID_ID3D12Fence, (void **)&fence))) goto done;

    UINT64 fence_value = 0;
    while (running) {
        MSG message;
        while (PeekMessageA(&message, 0, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) running = 0;
            else DispatchMessageA(&message);
        }
        if (!running) break;

        UINT index = (UINT)(fence_value & 1u);
        result = 16;
        if (FAILED(ID3D12CommandAllocator_Reset(allocator))) goto done;
        result = 17;
        if (FAILED(ID3D12GraphicsCommandList_Reset(list, allocator, pso))) goto done;

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
        ID3D12GraphicsCommandList_RSSetViewports(list, 1, &viewports[(GetTickCount() / 350u) & 3u]);
        ID3D12GraphicsCommandList_RSSetScissorRects(list, 1, &scissor);
        ID3D12GraphicsCommandList_SetGraphicsRootSignature(list, root);
        ID3D12GraphicsCommandList_IASetPrimitiveTopology(list, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
        ID3D12GraphicsCommandList_DrawInstanced(list, 3, 1, 0, 0);
        barrier.Transition.StateBefore = D3D12_RESOURCE_STATE_RENDER_TARGET;
        barrier.Transition.StateAfter = D3D12_RESOURCE_STATE_PRESENT;
        ID3D12GraphicsCommandList_ResourceBarrier(list, 1, &barrier);
        result = 18;
        if (FAILED(ID3D12GraphicsCommandList_Close(list))) goto done;
        ID3D12CommandList *lists[1] = {(ID3D12CommandList *)list};
        ID3D12CommandQueue_ExecuteCommandLists(queue, 1, lists);
        result = 19;
        if (FAILED(IDXGISwapChain_Present(swapchain, 0, 0))) goto done;
        ++fence_value;
        result = 20;
        if (FAILED(ID3D12CommandQueue_Signal(queue, fence, fence_value))) goto done;
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
    for (UINT i = 0; i < BUFFER_COUNT; ++i) if (buffers[i]) ID3D12Resource_Release(buffers[i]);
    if (rtv_heap) ID3D12DescriptorHeap_Release(rtv_heap);
    if (swapchain) IDXGISwapChain_Release(swapchain);
    if (queue) ID3D12CommandQueue_Release(queue);
    if (device) ID3D12Device_Release(device);
    if (factory) IDXGIFactory_Release(factory);
    DestroyWindow(window);
    return result;
}

void mainCRTStartup(void) { ExitProcess((UINT)run()); }
