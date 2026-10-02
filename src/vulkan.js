// Bounded Vulkan 1.0 / Win32 ABI frontend. No application names or scene data
// occur here. Every native handle, descriptor and command is guest supplied.
import { VK_ABI as ABI, VK_COMMANDS } from './vulkan-abi.js';
import { VulkanRenderer } from './vulkan-renderer.js';
const MAX_BYTES = 8 * 1024 * 1024;
const WHOLE = Number.POSITIVE_INFINITY;
const formats = new Set([37, 43, 44, 50, 124]);
const u32 = (r, p) => r.read32(p) >>> 0;
const f32 = (r, p) => r.view.getFloat32(r.check(p, 4), true);
function u64(r, p) {
  const lo = u32(r, p),
    hi = u32(r, p + 4);
  if (lo === 0xffffffff && hi === 0xffffffff) return WHOLE;
  const value = lo + hi * 4294967296;
  if (!Number.isSafeInteger(value)) throw Error('Vulkan 64-bit value is out of range');
  return value;
}
function write64(r, p, value) {
  r.write32(p, value);
  r.write32(p + 4, Math.floor(value / 4294967296));
}
function field(r, p, type, name, wide = false) {
  const offset = ABI[type]?.[name];
  if (offset === undefined) throw Error('Unknown Vulkan ABI field ' + type + '.' + name);
  return wide ? u64(r, p + offset) : u32(r, p + offset);
}
function info(r, p, type, expected) {
  r.check(p, ABI[type].__size);
  if (expected !== undefined && u32(r, p) !== expected) throw Error('Invalid ' + type + ' sType');
  if (u32(r, p + 4)) throw Error('Unsupported Vulkan pNext chain');
  return (name, wide = false) => field(r, p, type, name, wide);
}
function bounded(value, max, label, min = 1) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw Error('Invalid Vulkan ' + label);
  return value;
}
function zero(r, p, size) {
  r.check(p, size, true);
  r.data.fill(0, p, p + size);
}
function putString(r, p, value, size) {
  zero(r, p, size);
  r.data.set(new TextEncoder().encode(value).subarray(0, size - 1), p);
}
function state(r) {
  if (!r.vulkan)
    r.vulkan = {
      objects: new Map(),
      next: 0x1000,
      renderer: new VulkanRenderer(r.graphics),
      dispose() {
        this.renderer.dispose();
      },
    };
  return r.vulkan;
}
function make(r, kind, data = {}) {
  const s = state(r);
  if (s.objects.size >= 1024) throw Error('Vulkan object limit exceeded');
  const object = { id: s.next++, kind, ...data };
  s.objects.set(object.id, object);
  return object;
}
function get(r, id, kind) {
  const object = state(r).objects.get(id);
  if (!object || object.kind !== kind)
    throw Error('Invalid or released Vulkan ' + kind + ' handle ' + id);
  return object;
}
function destroy(r, id, kind) {
  if (!id) return;
  const object = get(r, id, kind);
  if (kind === 'memory') r.free(object.address);
  if (kind === 'buffer') state(r).renderer.destroy(object.gpu);
  if (kind === 'image') state(r).renderer.destroy(object.texture);
  if (kind === 'swapchain') state(r).renderer.destroyChain(object);
  state(r).objects.delete(id);
}
function out(r, p, object, wide = true) {
  if (wide) write64(r, p, object.id);
  else r.write32(p, object.id);
  return 0;
}
function enumerate(r, count, pointer, values, stride, write) {
  const capacity = u32(r, count);
  if (!pointer) {
    r.write32(count, values.length);
    return 0;
  }
  bounded(capacity, 1024, 'enumeration capacity', 0);
  const length = Math.min(capacity, values.length);
  if (length) r.check(pointer, length * stride, true);
  for (let i = 0; i < length; i++) write(pointer + i * stride, values[i]);
  r.write32(count, length);
  return length < values.length ? 5 : 0; // VK_INCOMPLETE
}
function extensions(r, count, pointer, names) {
  return enumerate(r, count, pointer, names, ABI.VkExtensionProperties.__size, (p, name) => {
    putString(r, p, name, 256);
    r.write32(p + 256, 1);
  });
}
function names(r, count, pointer) {
  bounded(count, 32, 'extension count', 0);
  if (count) r.check(pointer, count * 4);
  return Array.from({ length: count }, (_, i) => r.string(u32(r, pointer + i * 4)));
}
function memoryRequirements(r, object, pointer) {
  const size =
    object.kind === 'buffer'
      ? object.size
      : object.width * object.height * (object.format === 124 ? 2 : 4);
  zero(r, pointer, ABI.VkMemoryRequirements.__size);
  write64(r, pointer + ABI.VkMemoryRequirements.size, size);
  write64(r, pointer + ABI.VkMemoryRequirements.alignment, 16);
  r.write32(pointer + ABI.VkMemoryRequirements.memoryTypeBits, 1);
}
function command(r, id) {
  const c = get(r, id, 'command');
  if (c.status !== 'recording') throw Error('Vulkan command buffer is not recording');
  return c;
}
function record(r, id, item) {
  const c = command(r, id);
  if (c.commands.length >= 256) throw Error('Vulkan command buffer limit exceeded');
  c.commands.push(item);
}
const impl = {};
const unavailable = new Set(['vkCmdBeginRendering', 'vkCmdEndRendering']);
async function procAddress(r, name) {
  if (!impl[name] || unavailable.has(name)) return 0;
  return r.resolveExport(r.graph.load('vulkan-1.dll'), name);
}
impl.vkGetInstanceProcAddr = async (r, [id, namePointer]) => {
  const name = r.string(namePointer);
  if (
    !id &&
    ![
      'vkGetInstanceProcAddr',
      'vkCreateInstance',
      'vkEnumerateInstanceVersion',
      'vkEnumerateInstanceExtensionProperties',
      'vkEnumerateInstanceLayerProperties',
    ].includes(name)
  )
    return 0;
  if (id) get(r, id, 'instance');
  return procAddress(r, name);
};
impl.vkGetDeviceProcAddr = async (r, [id, namePointer]) => {
  get(r, id, 'device');
  const name = r.string(namePointer);
  if (
    ['vkCreateInstance', 'vkCreateDevice', 'vkGetInstanceProcAddr'].includes(name) ||
    name.startsWith('vkGetPhysicalDevice') ||
    name.startsWith('vkEnumerate')
  )
    return 0;
  return procAddress(r, name);
};
impl.vkEnumerateInstanceVersion = (r, [p]) => {
  r.write32(p, 1 << 22);
  return 0;
};
// A Vulkan-1.0 binary may contain unused 1.3 paths in its C++ virtual table.
// Its static imports can resolve, while optional loader queries remain null
// and execution of an unimplemented path fails explicitly.
impl.vkCmdBeginRendering = impl.vkCmdEndRendering = () => {
  throw Error('Vulkan 1.3 dynamic rendering is unavailable');
};
impl.vkEnumerateInstanceLayerProperties = (r, [count, pointer]) =>
  enumerate(r, count, pointer, [], 520, () => {});
impl.vkEnumerateInstanceExtensionProperties = (r, [layer, count, p]) =>
  layer ? -6 : extensions(r, count, p, ['VK_KHR_surface', 'VK_KHR_win32_surface']);
impl.vkEnumerateDeviceExtensionProperties = (r, [gpu, layer, count, p]) => {
  get(r, gpu, 'physical');
  return layer ? -6 : extensions(r, count, p, ['VK_KHR_swapchain']);
};
impl.vkCreateInstance = async (r, [p, allocator, output]) => {
  const v = info(r, p, 'VkInstanceCreateInfo', 1);
  if (allocator || v('flags') || v('enabledLayerCount')) return -6;
  if (
    names(r, v('enabledExtensionCount'), v('ppEnabledExtensionNames')).some(
      (name) => !['VK_KHR_surface', 'VK_KHR_win32_surface'].includes(name),
    )
  )
    return -7;
  await state(r).renderer.initialize();
  const instance = make(r, 'instance');
  instance.physical = make(r, 'physical', { instance });
  return out(r, output, instance, false);
};
impl.vkDestroyInstance = (r, [id]) => {
  const instance = get(r, id, 'instance');
  destroy(r, instance.physical.id, 'physical');
  destroy(r, id, 'instance');
};
impl.vkEnumeratePhysicalDevices = (r, [instance, count, p]) =>
  enumerate(r, count, p, [get(r, instance, 'instance').physical.id], 4, (p, id) =>
    r.write32(p, id),
  );
impl.vkGetPhysicalDeviceProperties = (r, [gpu, p]) => {
  get(r, gpu, 'physical');
  zero(r, p, ABI.VkPhysicalDeviceProperties.__size);
  r.write32(p, 1 << 22);
  r.write32(p + 4, 1);
  r.write32(p + 16, 2);
  putString(
    r,
    p + ABI.VkPhysicalDeviceProperties.deviceName,
    'WineBrowser WebGPU Vulkan subset',
    256,
  );
  const l = p + ABI.VkPhysicalDeviceProperties.limits;
  for (const [name, value] of Object.entries({
    maxImageDimension1D: 2048,
    maxImageDimension2D: 2048,
    maxImageDimension3D: 1,
    maxImageDimensionCube: 1,
    maxImageArrayLayers: 1,
    maxUniformBufferRange: 65536,
    maxStorageBufferRange: MAX_BYTES,
    maxBoundDescriptorSets: 4,
    maxPerStageDescriptorSamplers: 16,
    maxPerStageDescriptorSampledImages: 16,
    maxPerStageDescriptorUniformBuffers: 12,
    maxPerStageDescriptorStorageBuffers: 4,
    maxDescriptorSetUniformBuffers: 12,
    maxDescriptorSetSamplers: 16,
    maxDescriptorSetSampledImages: 16,
    maxDescriptorSetStorageBuffers: 4,
    maxPushConstantsSize: 128,
    maxVertexInputAttributes: 16,
    maxVertexInputBindings: 8,
    maxVertexInputAttributeOffset: 2047,
    maxVertexInputBindingStride: 2048,
    maxComputeSharedMemorySize: 16384,
    maxComputeWorkGroupInvocations: 256,
    maxFramebufferWidth: 2048,
    maxFramebufferHeight: 2048,
    maxFramebufferLayers: 1,
    framebufferColorSampleCounts: 1,
    framebufferDepthSampleCounts: 1,
    sampledImageColorSampleCounts: 1,
    maxViewports: 1,
  }))
    r.write32(l + ABI.VkPhysicalDeviceLimits[name], value);
  write64(r, l + ABI.VkPhysicalDeviceLimits.minUniformBufferOffsetAlignment, 256);
  write64(r, l + ABI.VkPhysicalDeviceLimits.minStorageBufferOffsetAlignment, 256);
  for (let i = 0; i < 3; i++) {
    r.write32(l + ABI.VkPhysicalDeviceLimits.maxComputeWorkGroupCount + i * 4, 65535);
    r.write32(l + ABI.VkPhysicalDeviceLimits.maxComputeWorkGroupSize + i * 4, i === 2 ? 64 : 256);
  }
};
impl.vkGetPhysicalDeviceFeatures = (r, [gpu, p]) => {
  get(r, gpu, 'physical');
  zero(r, p, ABI.VkPhysicalDeviceFeatures.__size);
};
impl.vkGetPhysicalDeviceMemoryProperties = (r, [gpu, p]) => {
  get(r, gpu, 'physical');
  zero(r, p, ABI.VkPhysicalDeviceMemoryProperties.__size);
  r.write32(p, 1);
  r.write32(p + ABI.VkPhysicalDeviceMemoryProperties.memoryTypes, 7);
  r.write32(p + ABI.VkPhysicalDeviceMemoryProperties.memoryHeapCount, 1);
  const heap = p + ABI.VkPhysicalDeviceMemoryProperties.memoryHeaps;
  write64(r, heap, MAX_BYTES);
  r.write32(heap + ABI.VkMemoryHeap.flags, 1);
};
impl.vkGetPhysicalDeviceQueueFamilyProperties = (r, [gpu, count, p]) => {
  get(r, gpu, 'physical');
  return enumerate(r, count, p, [0], ABI.VkQueueFamilyProperties.__size, (p) => {
    zero(r, p, ABI.VkQueueFamilyProperties.__size);
    r.write32(p, 7); // Graphics, compute and transfer share one ordered queue.
    r.write32(p + 4, 1);
    for (let i = 0; i < 3; i++) r.write32(p + 12 + i * 4, 1);
  });
};
impl.vkGetPhysicalDeviceFormatProperties = (r, [gpu, format, p]) => {
  get(r, gpu, 'physical');
  zero(r, p, 12);
  if (formats.has(format)) {
    r.write32(p, format === 124 ? 0 : 1);
    r.write32(p + 4, format === 124 ? 0x200 : 0x81);
  }
};
impl.vkCreateDevice = (r, [gpu, p, allocator, output]) => {
  get(r, gpu, 'physical');
  const v = info(r, p, 'VkDeviceCreateInfo', 3);
  if (allocator || v('flags') || v('enabledLayerCount')) return -8;
  if (
    names(r, v('enabledExtensionCount'), v('ppEnabledExtensionNames')).some(
      (name) => name !== 'VK_KHR_swapchain',
    )
  )
    return -7;
  if (v('pEnabledFeatures')) {
    const f = v('pEnabledFeatures');
    r.check(f, ABI.VkPhysicalDeviceFeatures.__size);
    if (r.data.subarray(f, f + ABI.VkPhysicalDeviceFeatures.__size).some(Boolean)) return -8;
  }
  if (v('queueCreateInfoCount') !== 1) return -3;
  const q = info(r, v('pQueueCreateInfos'), 'VkDeviceQueueCreateInfo', 2);
  if (q('queueFamilyIndex') || q('queueCount') !== 1) return -3;
  const device = make(r, 'device');
  device.queue = make(r, 'queue', { device });
  return out(r, output, device, false);
};
impl.vkDestroyDevice = (r, [id]) => {
  const device = get(r, id, 'device');
  destroy(r, device.queue.id, 'queue');
  destroy(r, id, 'device');
};
impl.vkGetDeviceQueue = (r, [id, family, index, p]) => {
  if (family || index) throw Error('Unsupported Vulkan queue');
  return out(r, p, get(r, id, 'device').queue, false);
};
impl.vkCreateWin32SurfaceKHR = (r, [instance, p, allocator, output]) => {
  get(r, instance, 'instance');
  const v = info(r, p, 'VkWin32SurfaceCreateInfoKHR', 1000009000);
  const windowId = v('hwnd');
  if (!r.windows?.windows.has(windowId) || allocator || v('flags')) return -3;
  return out(r, output, make(r, 'surface', { windowId }));
};
impl.vkDestroySurfaceKHR = (r, [instance, id]) => destroy(r, id, 'surface');
impl.vkGetPhysicalDeviceSurfaceSupportKHR = (r, [gpu, queue, surface, p]) => {
  get(r, gpu, 'physical');
  get(r, surface, 'surface');
  r.write32(p, queue === 0 ? 1 : 0);
  return 0;
};
impl.vkGetPhysicalDeviceSurfaceCapabilitiesKHR = (r, [gpu, surface, p]) => {
  get(r, gpu, 'physical');
  get(r, surface, 'surface');
  zero(r, p, ABI.VkSurfaceCapabilitiesKHR.__size);
  const values = {
    minImageCount: 2,
    maxImageCount: 3,
    currentTransform: 1,
    supportedTransforms: 1,
    supportedCompositeAlpha: 1,
    supportedUsageFlags: 0x10,
    maxImageArrayLayers: 1,
  };
  for (const [name, value] of Object.entries(values))
    r.write32(p + ABI.VkSurfaceCapabilitiesKHR[name], value);
  for (const [name, value] of [
    ['currentExtent', 0xffffffff],
    ['minImageExtent', 1],
    ['maxImageExtent', 2048],
  ]) {
    r.write32(p + ABI.VkSurfaceCapabilitiesKHR[name], value);
    r.write32(p + ABI.VkSurfaceCapabilitiesKHR[name] + 4, value);
  }
  return 0;
};
impl.vkGetPhysicalDeviceSurfaceFormatsKHR = (r, [gpu, surface, count, p]) => {
  get(r, gpu, 'physical');
  get(r, surface, 'surface');
  return enumerate(r, count, p, [37], 8, (p, format) => {
    r.write32(p, format);
    r.write32(p + 4, 0);
  });
};
impl.vkGetPhysicalDeviceSurfacePresentModesKHR = (r, [gpu, surface, count, p]) => {
  get(r, gpu, 'physical');
  get(r, surface, 'surface');
  return enumerate(r, count, p, [2], 4, (p, mode) => r.write32(p, mode));
};
impl.vkCreateSwapchainKHR = async (r, [device, p, allocator, output]) => {
  get(r, device, 'device');
  const v = info(r, p, 'VkSwapchainCreateInfoKHR', 1000001000);
  if (
    allocator ||
    v('flags') ||
    v('imageFormat') !== 37 ||
    v('imageColorSpace') ||
    v('imageArrayLayers') !== 1 ||
    v('imageUsage') !== 0x10 ||
    v('imageSharingMode') ||
    v('presentMode') !== 2 ||
    v('preTransform') !== 1 ||
    v('compositeAlpha') !== 1
  )
    return -3;
  const extent = p + ABI.VkSwapchainCreateInfoKHR.imageExtent;
  const chain = make(r, 'swapchain', {
    windowId: get(r, v('surface', true), 'surface').windowId,
    width: bounded(u32(r, extent), 2048, 'width'),
    height: bounded(u32(r, extent + 4), 2048, 'height'),
    cursor: 0,
    acquired: new Set(),
  });
  chain.images = Array.from({ length: bounded(v('minImageCount'), 3, 'image count', 2) }, () =>
    make(r, 'image', { width: chain.width, height: chain.height, format: 37, chain }),
  );
  await state(r).renderer.createChain(chain);
  return out(r, output, chain);
};
impl.vkDestroySwapchainKHR = (r, [device, id]) => {
  const c = get(r, id, 'swapchain');
  for (const i of c.images) state(r).objects.delete(i.id);
  destroy(r, id, 'swapchain');
};
impl.vkGetSwapchainImagesKHR = (r, [device, chain, count, p]) =>
  enumerate(r, count, p, get(r, chain, 'swapchain').images, 8, (p, image) =>
    write64(r, p, image.id),
  );
impl.vkAcquireNextImageKHR = (r, [device, id, timeout, semaphore, fence, p]) => {
  const c = get(r, id, 'swapchain');
  const index = c.cursor++ % c.images.length;
  if (c.acquired.has(index)) return 2;
  c.acquired.add(index);
  r.write32(p, index);
  if (semaphore) get(r, semaphore, 'semaphore').signaled = true;
  if (fence) get(r, fence, 'fence').signaled = true;
  return 0;
};
impl.vkCreateBuffer = (r, [device, p, allocator, output]) => {
  get(r, device, 'device');
  const v = info(r, p, 'VkBufferCreateInfo', 12);
  if (allocator || v('flags') || v('sharingMode') || !v('usage') || v('usage') & ~0xf3) return -8;
  return out(
    r,
    output,
    make(r, 'buffer', {
      size: bounded(v('size', true), MAX_BYTES, 'buffer size'),
      usage: v('usage'),
    }),
  );
};
impl.vkCreateImage = (r, [device, p, allocator, output]) => {
  get(r, device, 'device');
  const v = info(r, p, 'VkImageCreateInfo', 14);
  const e = p + ABI.VkImageCreateInfo.extent;
  if (
    allocator ||
    v('flags') ||
    v('imageType') !== 1 ||
    !formats.has(v('format')) ||
    v('mipLevels') !== 1 ||
    v('arrayLayers') !== 1 ||
    v('samples') !== 1 ||
    u32(r, e + 8) !== 1 ||
    v('sharingMode')
  )
    return -11;
  const width = bounded(u32(r, e), 2048, 'image width'),
    height = bounded(u32(r, e + 4), 2048, 'image height');
  bounded(width * height * 4, MAX_BYTES, 'image bytes');
  return out(
    r,
    output,
    make(r, 'image', {
      width,
      height,
      format: v('format'),
      tiling: v('tiling'),
      layout: v('initialLayout'),
      dirty: true,
    }),
  );
};
impl.vkGetBufferMemoryRequirements = (r, [device, id, p]) =>
  memoryRequirements(r, get(r, id, 'buffer'), p);
impl.vkGetImageMemoryRequirements = (r, [device, id, p]) =>
  memoryRequirements(r, get(r, id, 'image'), p);
impl.vkAllocateMemory = (r, [device, p, allocator, output]) => {
  get(r, device, 'device');
  const v = info(r, p, 'VkMemoryAllocateInfo', 5);
  if (allocator || v('memoryTypeIndex')) return -8;
  const size = bounded(v('allocationSize', true), MAX_BYTES, 'memory allocation');
  return out(
    r,
    output,
    make(r, 'memory', { size, address: r.allocate(size), mapped: false, resources: new Set() }),
  );
};
for (const [name, kind] of [
  ['vkBindBufferMemory', 'buffer'],
  ['vkBindImageMemory', 'image'],
])
  impl[name] = (r, [device, id, memory, offset]) => {
    const object = get(r, id, kind),
      allocation = get(r, memory, 'memory');
    const length =
      kind === 'buffer'
        ? object.size
        : object.width * object.height * (object.format === 124 ? 2 : 4);
    bounded(offset, allocation.size - length, 'memory offset', 0);
    if (object.memory) throw Error('Vulkan resource memory already bound');
    object.memory = allocation;
    object.offset = offset;
    allocation.resources.add(object);
    return 0;
  };
impl.vkMapMemory = (r, [device, id, offset, size, flags, output]) => {
  const memory = get(r, id, 'memory');
  if (flags || memory.mapped) return -5;
  if (size === WHOLE) size = memory.size - offset;
  bounded(offset, memory.size - 1, 'map offset', 0);
  bounded(size, memory.size - offset, 'mapped size');
  memory.mapped = true;
  r.write32(output, memory.address + offset);
  return 0;
};
impl.vkUnmapMemory = (r, [device, id]) => {
  const memory = get(r, id, 'memory');
  if (!memory.mapped) throw Error('Vulkan memory is not mapped');
  memory.mapped = false;
  for (const object of memory.resources) object.dirty = true;
};
impl.vkGetImageSubresourceLayout = (r, [device, id, subresource, p]) => {
  const image = get(r, id, 'image');
  zero(r, p, ABI.VkSubresourceLayout.__size);
  write64(r, p + ABI.VkSubresourceLayout.size, image.width * image.height * 4);
  write64(r, p + ABI.VkSubresourceLayout.rowPitch, image.width * 4);
  write64(r, p + ABI.VkSubresourceLayout.arrayPitch, image.width * image.height * 4);
  write64(r, p + ABI.VkSubresourceLayout.depthPitch, image.width * image.height * 4);
};
impl.vkCreateImageView = (r, [device, p, allocator, output]) => {
  const v = info(r, p, 'VkImageViewCreateInfo', 15);
  const image = get(r, v('image', true), 'image');
  const range = p + ABI.VkImageViewCreateInfo.subresourceRange;
  const components = p + ABI.VkImageViewCreateInfo.components;
  if ([0, 1, 2, 3].some((i) => ![0, i + 3].includes(u32(r, components + i * 4)))) return -8;
  if (
    allocator ||
    v('flags') ||
    v('viewType') !== 1 ||
    v('format') !== image.format ||
    u32(r, range + 4) ||
    u32(r, range + 8) !== 1 ||
    u32(r, range + 12) ||
    u32(r, range + 16) !== 1
  )
    return -8;
  return out(r, output, make(r, 'view', { image }));
};
impl.vkCreateSampler = (r, [device, p, allocator, output]) => {
  const v = info(r, p, 'VkSamplerCreateInfo', 31);
  if (
    allocator ||
    v('flags') ||
    v('anisotropyEnable') ||
    v('compareEnable') ||
    v('unnormalizedCoordinates') ||
    v('mipmapMode') > 1
  )
    return -8;
  const modes = ['repeat', 'mirror-repeat', 'clamp-to-edge'];
  const filters = ['nearest', 'linear'];
  const descriptor = {
    magFilter: filters[v('magFilter')],
    minFilter: filters[v('minFilter')],
    mipmapFilter: filters[v('mipmapMode')],
    addressModeU: modes[v('addressModeU')],
    addressModeV: modes[v('addressModeV')],
    addressModeW: modes[v('addressModeW')],
  };
  if (Object.values(descriptor).some((v) => v === undefined)) return -8;
  return out(
    r,
    output,
    make(r, 'sampler', { gpu: state(r).renderer.device.createSampler(descriptor) }),
  );
};
impl.vkCreateShaderModule = (r, [device, p, allocator, output]) => {
  const v = info(r, p, 'VkShaderModuleCreateInfo', 16);
  const size = bounded(v('codeSize'), 1024 * 1024, 'SPIR-V bytes', 20);
  if (allocator || v('flags') || size % 4 || u32(r, v('pCode')) !== 0x07230203) return -3;
  const start = v('pCode');
  r.check(start, size);
  return out(r, output, make(r, 'shader', { bytes: r.data.slice(start, start + size) }));
};
impl.vkCreateDescriptorSetLayout = (r, [device, p, allocator, output]) => {
  const v = info(r, p, 'VkDescriptorSetLayoutCreateInfo', 32);
  if (allocator || v('flags')) return -8;
  const count = bounded(v('bindingCount'), 32, 'descriptor bindings', 0),
    base = v('pBindings'),
    bindings = new Map();
  for (let i = 0; i < count; i++) {
    const p = base + i * ABI.VkDescriptorSetLayoutBinding.__size;
    const binding = field(r, p, 'VkDescriptorSetLayoutBinding', 'binding'),
      type = field(r, p, 'VkDescriptorSetLayoutBinding', 'descriptorType');
    if (
      binding >= 32 ||
      bindings.has(binding) ||
      ![1, 6, 7].includes(type) ||
      field(r, p, 'VkDescriptorSetLayoutBinding', 'descriptorCount') !== 1 ||
      field(r, p, 'VkDescriptorSetLayoutBinding', 'pImmutableSamplers')
    )
      return -8;
    const stages = field(r, p, 'VkDescriptorSetLayoutBinding', 'stageFlags');
    if (!stages || stages & ~49) return -8;
    bindings.set(binding, { type, stages });
  }
  return out(r, output, make(r, 'set-layout', { bindings }));
};
impl.vkCreatePipelineLayout = (r, [device, p, allocator, output]) => {
  const v = info(r, p, 'VkPipelineLayoutCreateInfo', 30);
  if (allocator || v('flags')) return -8;
  const count = bounded(v('setLayoutCount'), 4, 'descriptor sets', 0);
  const layouts = Array.from({ length: count }, (_, i) =>
    get(r, u64(r, v('pSetLayouts') + i * 8), 'set-layout'),
  );
  const ranges = Array.from(
    { length: bounded(v('pushConstantRangeCount'), 8, 'push constant ranges', 0) },
    (_, i) => {
      const p = v('pPushConstantRanges') + i * ABI.VkPushConstantRange.__size;
      const offset = field(r, p, 'VkPushConstantRange', 'offset'),
        size = field(r, p, 'VkPushConstantRange', 'size'),
        stages = field(r, p, 'VkPushConstantRange', 'stageFlags');
      if (
        count > 3 ||
        offset % 4 ||
        size % 4 ||
        !size ||
        offset + size > 128 ||
        !stages ||
        stages & ~49
      )
        throw Error('Unsupported Vulkan push constant range');
      return { offset, size, stages };
    },
  );
  return out(r, output, make(r, 'pipeline-layout', { layouts, ranges }));
};
impl.vkCreateDescriptorPool = (r, [device, p, allocator, output]) => {
  const v = info(r, p, 'VkDescriptorPoolCreateInfo', 33);
  if (allocator || v('flags')) return -8;
  return out(
    r,
    output,
    make(r, 'descriptor-pool', { max: bounded(v('maxSets'), 32, 'pool size'), sets: new Set() }),
  );
};
impl.vkAllocateDescriptorSets = (r, [device, p, output]) => {
  const v = info(r, p, 'VkDescriptorSetAllocateInfo', 34),
    pool = get(r, v('descriptorPool', true), 'descriptor-pool');
  const count = bounded(
    v('descriptorSetCount'),
    pool.max - pool.sets.size,
    'descriptor allocation',
  );
  for (let i = 0; i < count; i++) {
    const layout = get(r, u64(r, v('pSetLayouts') + i * 8), 'set-layout');
    const set = make(r, 'descriptor-set', { layout, bindings: new Map() });
    pool.sets.add(set.id);
    out(r, output + i * 8, set);
  }
  return 0;
};
impl.vkUpdateDescriptorSets = (r, [device, count, writes, copyCount]) => {
  if (copyCount) throw Error('Vulkan descriptor copies are unsupported');
  bounded(count, 64, 'descriptor writes', 0);
  for (let i = 0; i < count; i++) {
    const p = writes + i * ABI.VkWriteDescriptorSet.__size,
      v = info(r, p, 'VkWriteDescriptorSet', 35),
      set = get(r, v('dstSet', true), 'descriptor-set');
    const binding = v('dstBinding'),
      type = v('descriptorType');
    if (
      v('dstArrayElement') ||
      v('descriptorCount') !== 1 ||
      set.layout.bindings.get(binding)?.type !== type
    )
      throw Error('Invalid Vulkan descriptor write');
    let descriptor;
    if (type === 6 || type === 7) {
      const p = v('pBufferInfo'),
        buffer = get(r, field(r, p, 'VkDescriptorBufferInfo', 'buffer', true), 'buffer');
      const offset = field(r, p, 'VkDescriptorBufferInfo', 'offset', true);
      let range = field(r, p, 'VkDescriptorBufferInfo', 'range', true);
      if (range === WHOLE) range = buffer.size - offset;
      bounded(offset, buffer.size - 1, 'uniform offset', 0);
      bounded(
        range,
        Math.min(type === 6 ? 65536 : MAX_BYTES, buffer.size - offset),
        'descriptor range',
      );
      if (!(buffer.usage & (type === 6 ? 0x10 : 0x20)))
        throw Error('Vulkan buffer descriptor usage mismatch');
      descriptor = { type, buffer, offset, range };
    } else {
      const p = v('pImageInfo');
      descriptor = {
        type,
        view: get(r, field(r, p, 'VkDescriptorImageInfo', 'imageView', true), 'view'),
        sampler: get(r, field(r, p, 'VkDescriptorImageInfo', 'sampler', true), 'sampler'),
      };
    }
    set.bindings.set(binding, descriptor);
  }
};
impl.vkCreateRenderPass = (r, [device, p, allocator, output]) => {
  const v = info(r, p, 'VkRenderPassCreateInfo', 38);
  if (allocator || v('flags') || v('attachmentCount') !== 2 || v('subpassCount') !== 1) return -8;
  const attachments = Array.from({ length: 2 }, (_, i) => {
    const p = v('pAttachments') + i * ABI.VkAttachmentDescription.__size;
    return {
      format: field(r, p, 'VkAttachmentDescription', 'format'),
      samples: field(r, p, 'VkAttachmentDescription', 'samples'),
      load: field(r, p, 'VkAttachmentDescription', 'loadOp'),
      store: field(r, p, 'VkAttachmentDescription', 'storeOp'),
    };
  });
  if (
    attachments[0].format !== 37 ||
    attachments[1].format !== 124 ||
    attachments.some((a) => a.samples !== 1 || a.load !== 1)
  )
    return -8;
  return out(r, output, make(r, 'renderpass', { attachments }));
};
impl.vkCreateFramebuffer = (r, [device, p, allocator, output]) => {
  const v = info(r, p, 'VkFramebufferCreateInfo', 37);
  if (allocator || v('flags') || v('attachmentCount') !== 2 || v('layers') !== 1) return -8;
  const renderpass = get(r, v('renderPass', true), 'renderpass');
  const attachments = Array.from({ length: 2 }, (_, i) =>
    get(r, u64(r, v('pAttachments') + i * 8), 'view'),
  );
  const width = v('width'),
    height = v('height');
  if (
    attachments.some(
      (a, i) =>
        a.image.format !== renderpass.attachments[i].format ||
        a.image.width !== width ||
        a.image.height !== height,
    )
  )
    return -3;
  return out(r, output, make(r, 'framebuffer', { renderpass, attachments, width, height }));
};
impl.vkCreatePipelineCache = (r, [device, p, allocator, output]) => {
  const v = info(r, p, 'VkPipelineCacheCreateInfo', 17);
  if (allocator || v('flags') || v('initialDataSize')) return -8;
  return out(r, output, make(r, 'pipeline-cache'));
};
impl.vkCreateGraphicsPipelines = async (
  r,
  [device, cache, count, descriptions, allocator, output],
) => {
  get(r, device, 'device');
  if (cache) get(r, cache, 'pipeline-cache');
  bounded(count, 4, 'pipeline count');
  if (allocator) return -8;
  for (let i = 0; i < count; i++) {
    const p = descriptions + i * ABI.VkGraphicsPipelineCreateInfo.__size,
      v = info(r, p, 'VkGraphicsPipelineCreateInfo', 28);
    if (
      v('flags') ||
      v('stageCount') !== 2 ||
      v('subpass') ||
      v('pTessellationState') ||
      v('basePipelineHandle', true)
    )
      return -8;
    const stages = Array.from({ length: 2 }, (_, i) => {
      const p = v('pStages') + i * ABI.VkPipelineShaderStageCreateInfo.__size,
        s = info(r, p, 'VkPipelineShaderStageCreateInfo', 18);
      if (s('pSpecializationInfo') || s('flags')) throw Error('Unsupported Vulkan specialization');
      return {
        stage: s('stage'),
        entry: r.string(s('pName')),
        bytes: get(r, s('module', true), 'shader').bytes,
      };
    });
    const vertex = info(r, v('pVertexInputState'), 'VkPipelineVertexInputStateCreateInfo', 19);
    const vertexBindings = Array.from(
      { length: bounded(vertex('vertexBindingDescriptionCount'), 8, 'vertex bindings', 0) },
      (_, i) => {
        const p =
          vertex('pVertexBindingDescriptions') + i * ABI.VkVertexInputBindingDescription.__size;
        const binding = field(r, p, 'VkVertexInputBindingDescription', 'binding'),
          stride = field(r, p, 'VkVertexInputBindingDescription', 'stride'),
          rate = field(r, p, 'VkVertexInputBindingDescription', 'inputRate');
        if (binding >= 8 || stride > 2048 || stride % 4 || rate > 1)
          throw Error('Unsupported Vulkan vertex binding');
        return { binding, stride, rate };
      },
    );
    const vertexAttributes = Array.from(
      { length: bounded(vertex('vertexAttributeDescriptionCount'), 16, 'vertex attributes', 0) },
      (_, i) => {
        const p =
          vertex('pVertexAttributeDescriptions') + i * ABI.VkVertexInputAttributeDescription.__size;
        return Object.fromEntries(
          ['location', 'binding', 'format', 'offset'].map((n) => [
            n,
            field(r, p, 'VkVertexInputAttributeDescription', n),
          ]),
        );
      },
    );
    const assembly = info(
      r,
      v('pInputAssemblyState'),
      'VkPipelineInputAssemblyStateCreateInfo',
      20,
    );
    if (assembly('topology') !== 3 || assembly('primitiveRestartEnable')) return -8;
    const raster = info(r, v('pRasterizationState'), 'VkPipelineRasterizationStateCreateInfo', 23);
    if (
      raster('polygonMode') ||
      raster('depthClampEnable') ||
      raster('rasterizerDiscardEnable') ||
      raster('depthBiasEnable') ||
      raster('cullMode') > 2
    )
      return -8;
    const multisample = info(r, v('pMultisampleState'), 'VkPipelineMultisampleStateCreateInfo', 24);
    if (
      multisample('rasterizationSamples') !== 1 ||
      multisample('sampleShadingEnable') ||
      multisample('alphaToCoverageEnable') ||
      multisample('alphaToOneEnable')
    )
      return -8;
    const depth = info(r, v('pDepthStencilState'), 'VkPipelineDepthStencilStateCreateInfo', 25);
    if (depth('stencilTestEnable') || depth('depthBoundsTestEnable')) return -8;
    const blend = info(r, v('pColorBlendState'), 'VkPipelineColorBlendStateCreateInfo', 26);
    if (blend('logicOpEnable') || blend('attachmentCount') !== 1) return -8;
    const attachment = blend('pAttachments');
    const blending = Object.fromEntries(
      [
        'blendEnable',
        'srcColorBlendFactor',
        'dstColorBlendFactor',
        'colorBlendOp',
        'srcAlphaBlendFactor',
        'dstAlphaBlendFactor',
        'alphaBlendOp',
      ].map((n) => [n, field(r, attachment, 'VkPipelineColorBlendAttachmentState', n)]),
    );
    const viewport = info(r, v('pViewportState'), 'VkPipelineViewportStateCreateInfo', 22);
    if (viewport('viewportCount') !== 1 || viewport('scissorCount') !== 1 || !v('pDynamicState'))
      return -8;
    const dynamic = info(r, v('pDynamicState'), 'VkPipelineDynamicStateCreateInfo', 27);
    if (dynamic('dynamicStateCount') !== 2) return -8;
    const dynamicStates = [
      u32(r, dynamic('pDynamicStates')),
      u32(r, dynamic('pDynamicStates') + 4),
    ].sort();
    if (dynamicStates[0] !== 0 || dynamicStates[1] !== 1) return -8;
    const layout = get(r, v('layout', true), 'pipeline-layout');
    get(r, v('renderPass', true), 'renderpass');
    const gpu = await state(r).renderer.pipeline({
      stages,
      layout,
      vertexBindings,
      vertexAttributes,
      blending,
      depthWrite: !!depth('depthWriteEnable'),
      depthCompare: depth('depthTestEnable') ? depth('depthCompareOp') : 7,
      cullMode: raster('cullMode'),
      frontFace: raster('frontFace'),
      writeMask: field(r, attachment, 'VkPipelineColorBlendAttachmentState', 'colorWriteMask'),
    });
    out(r, output + i * 8, make(r, 'pipeline', { gpu, layout }));
  }
  return 0;
};
impl.vkCreateCommandPool = (r, [device, p, allocator, output]) => {
  const v = info(r, p, 'VkCommandPoolCreateInfo', 39);
  if (allocator || v('queueFamilyIndex') || v('flags') & ~3) return -8;
  return out(r, output, make(r, 'command-pool', { commands: new Set() }));
};
impl.vkCreateComputePipelines = async (
  r,
  [device, cache, count, descriptions, allocator, output],
) => {
  get(r, device, 'device');
  if (allocator) return -8;
  if (cache) get(r, cache, 'pipeline-cache');
  bounded(count, 4, 'compute pipeline count');
  for (let i = 0; i < count; i++) {
    const p = descriptions + i * ABI.VkComputePipelineCreateInfo.__size,
      v = info(r, p, 'VkComputePipelineCreateInfo', 29);
    if (v('flags') || v('basePipelineHandle', true)) return -8;
    const stage = info(
      r,
      p + ABI.VkComputePipelineCreateInfo.stage,
      'VkPipelineShaderStageCreateInfo',
      18,
    );
    if (stage('stage') !== 32 || stage('flags') || stage('pSpecializationInfo')) return -8;
    const layout = get(r, v('layout', true), 'pipeline-layout');
    const gpu = await state(r).renderer.computePipeline({
      layout,
      stage: {
        entry: r.string(stage('pName')),
        bytes: get(r, stage('module', true), 'shader').bytes,
      },
    });
    out(r, output + i * 8, make(r, 'pipeline', { gpu, layout }));
  }
  return 0;
};
impl.vkAllocateCommandBuffers = (r, [device, p, output]) => {
  const v = info(r, p, 'VkCommandBufferAllocateInfo', 40),
    pool = get(r, v('commandPool', true), 'command-pool');
  if (v('level')) return -8;
  const count = bounded(v('commandBufferCount'), 32 - pool.commands.size, 'command buffers');
  for (let i = 0; i < count; i++) {
    const object = make(r, 'command', { commands: [], status: 'initial' });
    pool.commands.add(object.id);
    out(r, output + i * 4, object, false);
  }
  return 0;
};
impl.vkFreeCommandBuffers = (r, [device, poolId, count, p]) => {
  const pool = get(r, poolId, 'command-pool');
  bounded(count, 32, 'free commands', 0);
  for (let i = 0; i < count; i++) {
    const id = u32(r, p + i * 4);
    if (!pool.commands.delete(id)) throw Error('Command buffer belongs to another pool');
    destroy(r, id, 'command');
  }
};
impl.vkBeginCommandBuffer = (r, [id, p]) => {
  const v = info(r, p, 'VkCommandBufferBeginInfo', 42),
    c = get(r, id, 'command');
  if (c.status === 'recording' || v('pInheritanceInfo') || v('flags') & ~5) return -3;
  c.status = 'recording';
  c.commands = [];
  return 0;
};
impl.vkEndCommandBuffer = (r, [id]) => {
  command(r, id).status = 'executable';
  return 0;
};
impl.vkResetCommandBuffer = (r, [id, flags]) => {
  const c = get(r, id, 'command');
  if (flags & ~1 || c.status === 'recording') return -3;
  c.status = 'initial';
  c.commands = [];
  return 0;
};
impl.vkCmdBeginRenderPass = (r, [id, p, contents]) => {
  const v = info(r, p, 'VkRenderPassBeginInfo', 43),
    framebuffer = get(r, v('framebuffer', true), 'framebuffer');
  if (contents || v('clearValueCount') !== 2 || framebuffer.renderpass.id !== v('renderPass', true))
    throw Error('Unsupported Vulkan render pass');
  const area = p + ABI.VkRenderPassBeginInfo.renderArea;
  if (
    u32(r, area) ||
    u32(r, area + 4) ||
    u32(r, area + 8) !== framebuffer.width ||
    u32(r, area + 12) !== framebuffer.height
  )
    throw Error('Unsupported partial Vulkan render area');
  const c = v('pClearValues');
  const color = Array.from({ length: 4 }, (_, i) => f32(r, c + i * 4));
  const depth = f32(r, c + 16);
  if (color.some((v) => !Number.isFinite(v)) || depth < 0 || depth > 1)
    throw Error('Invalid Vulkan clear values');
  record(r, id, { type: 'begin-pass', framebuffer, color, depth });
};
impl.vkCmdEndRenderPass = (r, [id]) => record(r, id, { type: 'end-pass' });
impl.vkCmdBindPipeline = (r, [id, point, pipeline]) => {
  if (point > 1) throw Error('Unsupported Vulkan pipeline bind point');
  record(r, id, { type: 'pipeline', point, pipeline: get(r, pipeline, 'pipeline') });
};
impl.vkCmdBindDescriptorSets = (r, [id, point, layout, first, count, sets, dynamicCount]) => {
  const target = get(r, layout, 'pipeline-layout');
  if (point > 1 || dynamicCount) throw Error('Unsupported Vulkan descriptor bind');
  bounded(count, target.layouts.length - first, 'bound sets');
  const bindings = Array.from({ length: count }, (_, i) =>
    get(r, u64(r, sets + i * 8), 'descriptor-set'),
  );
  if (
    bindings.some(
      (set, i) =>
        JSON.stringify([...set.layout.bindings]) !==
        JSON.stringify([...target.layouts[first + i].bindings]),
    )
  )
    throw Error('Vulkan descriptor layout mismatch');
  record(r, id, {
    type: 'sets',
    point,
    first,
    sets: bindings,
  });
};
impl.vkCmdBindVertexBuffers = (r, [id, first, count, p, offsets]) => {
  bounded(count, 8 - first, 'bound vertex buffers');
  const buffers = Array.from({ length: count }, (_, i) => {
    const buffer = get(r, u64(r, p + i * 8), 'buffer'),
      offset = u64(r, offsets + i * 8);
    if (!(buffer.usage & 0x80) || offset >= buffer.size || offset % 4)
      throw Error('Invalid Vulkan vertex buffer binding');
    return { buffer, offset };
  });
  record(r, id, { type: 'vertices', first, buffers });
};
impl.vkCmdBindIndexBuffer = (r, [id, bufferId, offset, indexType]) => {
  const buffer = get(r, bufferId, 'buffer');
  if (
    !(buffer.usage & 0x40) ||
    indexType > 1 ||
    offset >= buffer.size ||
    offset % (indexType ? 4 : 2)
  )
    throw Error('Invalid Vulkan index buffer binding');
  record(r, id, { type: 'indices', buffer, offset, format: indexType ? 'uint32' : 'uint16' });
};
impl.vkCmdDrawIndexed = (r, [id, indices, instances, first, vertexOffset, firstInstance]) => {
  bounded(indices, 1024 * 1024, 'draw indices');
  bounded(instances, 1024, 'draw instances');
  record(r, id, {
    type: 'draw-indexed',
    values: [indices, instances, first, vertexOffset | 0, firstInstance],
  });
};
impl.vkCmdPushConstants = (r, [id, layoutId, stages, offset, size, p]) => {
  const layout = get(r, layoutId, 'pipeline-layout');
  if (
    offset % 4 ||
    size % 4 ||
    !size ||
    offset + size > 128 ||
    !stages ||
    stages & ~49 ||
    !layout.ranges.some(
      (range) =>
        (range.stages & stages) === stages &&
        range.offset <= offset &&
        range.offset + range.size >= offset + size,
    )
  )
    throw Error('Invalid Vulkan push constants');
  r.check(p, size);
  record(r, id, { type: 'push', offset, bytes: r.data.slice(p, p + size) });
};
impl.vkCmdCopyBuffer = (r, [id, sourceId, targetId, count, p]) => {
  const source = get(r, sourceId, 'buffer'),
    target = get(r, targetId, 'buffer');
  if (!(source.usage & 1) || !(target.usage & 2)) throw Error('Vulkan copy buffer usage mismatch');
  bounded(count, 64, 'buffer copies');
  for (let i = 0; i < count; i++) {
    const at = p + i * ABI.VkBufferCopy.__size;
    const sourceOffset = field(r, at, 'VkBufferCopy', 'srcOffset', true),
      targetOffset = field(r, at, 'VkBufferCopy', 'dstOffset', true),
      size = field(r, at, 'VkBufferCopy', 'size', true);
    bounded(
      size,
      Math.min(source.size - sourceOffset, target.size - targetOffset),
      'buffer copy size',
    );
    record(r, id, { type: 'copy-buffer', source, target, sourceOffset, targetOffset, size });
  }
};
impl.vkFlushMappedMemoryRanges = impl.vkInvalidateMappedMemoryRanges = (r, [device, count, p]) => {
  get(r, device, 'device');
  bounded(count, 64, 'mapped ranges');
  for (let i = 0; i < count; i++) {
    const v = info(r, p + i * ABI.VkMappedMemoryRange.__size, 'VkMappedMemoryRange', 6),
      memory = get(r, v('memory', true), 'memory');
    const offset = v('offset', true),
      size = v('size', true) === WHOLE ? memory.size - offset : v('size', true);
    if (!memory.mapped) return -5;
    bounded(size, memory.size - offset, 'mapped range size');
    for (const object of memory.resources) object.dirty = true;
  }
  return 0;
};
impl.vkCmdSetViewport = (r, [id, first, count, p]) => {
  if (first || count !== 1) throw Error('Unsupported Vulkan viewport count');
  const values = Array.from({ length: 6 }, (_, i) => f32(r, p + i * 4));
  if (
    values.some((v) => !Number.isFinite(v)) ||
    values[2] <= 0 ||
    values[3] <= 0 ||
    values[4] < 0 ||
    values[5] > 1
  )
    throw Error('Invalid Vulkan viewport');
  record(r, id, { type: 'viewport', values });
};
impl.vkCmdSetScissor = (r, [id, first, count, p]) => {
  if (first || count !== 1) throw Error('Unsupported Vulkan scissor count');
  const values = Array.from({ length: 4 }, (_, i) => u32(r, p + i * 4));
  record(r, id, { type: 'scissor', values });
};
impl.vkCmdDraw = (r, [id, vertices, instances, first, firstInstance]) => {
  bounded(vertices, 65536, 'draw vertices');
  bounded(instances, 1024, 'draw instances');
  record(r, id, { type: 'draw', values: [vertices, instances, first, firstInstance] });
};
impl.vkCmdDispatch = (r, [id, x, y, z]) => {
  for (const count of [x, y, z]) bounded(count, 65535, 'dispatch group count', 0);
  record(r, id, { type: 'dispatch', values: [x, y, z] });
};
impl.vkCmdPipelineBarrier = (
  r,
  [id, src, dst, dependency, memoryCount, memories, bufferCount, buffers, imageCount, images],
) => {
  if (dependency || memoryCount) throw Error('Unsupported Vulkan barrier kind');
  bounded(bufferCount, 32, 'buffer barriers', 0);
  for (let i = 0; i < bufferCount; i++) {
    const v = info(r, buffers + i * ABI.VkBufferMemoryBarrier.__size, 'VkBufferMemoryBarrier', 44);
    const buffer = get(r, v('buffer', true), 'buffer');
    if (
      ![0xffffffff, 0].includes(v('srcQueueFamilyIndex')) ||
      ![0xffffffff, 0].includes(v('dstQueueFamilyIndex'))
    )
      throw Error('Unsupported Vulkan buffer queue ownership');
    const size = v('size', true) === WHOLE ? buffer.size - v('offset', true) : v('size', true);
    bounded(size, buffer.size - v('offset', true), 'buffer barrier range');
    record(r, id, { type: 'barrier', buffer });
  }
  bounded(imageCount, 32, 'image barriers', 0);
  for (let i = 0; i < imageCount; i++) {
    const p = images + i * ABI.VkImageMemoryBarrier.__size,
      v = info(r, p, 'VkImageMemoryBarrier', 45);
    const image = get(r, v('image', true), 'image');
    if (
      ![0xffffffff, 0].includes(v('srcQueueFamilyIndex')) ||
      ![0xffffffff, 0].includes(v('dstQueueFamilyIndex'))
    )
      throw Error('Unsupported Vulkan queue ownership');
    record(r, id, { type: 'barrier', image, oldLayout: v('oldLayout'), newLayout: v('newLayout') });
  }
};
impl.vkCmdCopyBufferToImage = (r, [id, buffer, image, layout, count, p]) => {
  if (count !== 1 || layout !== 7) throw Error('Unsupported Vulkan image copy');
  const target = get(r, image, 'image');
  const row = field(r, p, 'VkBufferImageCopy', 'bufferRowLength'),
    height = field(r, p, 'VkBufferImageCopy', 'bufferImageHeight');
  const offset = p + ABI.VkBufferImageCopy.imageOffset,
    subresource = p + ABI.VkBufferImageCopy.imageSubresource;
  if (
    (row && row !== target.width) ||
    (height && height !== target.height) ||
    [0, 4, 8].some((i) => u32(r, offset + i)) ||
    u32(r, subresource) !== 1 ||
    u32(r, subresource + 4) ||
    u32(r, subresource + 8) ||
    u32(r, subresource + 12) !== 1
  )
    throw Error('Unsupported Vulkan image copy region');
  const extent = p + ABI.VkBufferImageCopy.imageExtent;
  if (
    u32(r, extent) !== target.width ||
    u32(r, extent + 4) !== target.height ||
    u32(r, extent + 8) !== 1
  )
    throw Error('Vulkan copy extent mismatch');
  record(r, id, {
    type: 'copy-buffer-image',
    buffer: get(r, buffer, 'buffer'),
    image: target,
    offset: field(r, p, 'VkBufferImageCopy', 'bufferOffset', true),
  });
};
for (const [name, type, st] of [
  ['vkCreateFence', 'fence', 8],
  ['vkCreateSemaphore', 'semaphore', 9],
])
  impl[name] = (r, [device, p, allocator, output]) => {
    const v = info(r, p, type === 'fence' ? 'VkFenceCreateInfo' : 'VkSemaphoreCreateInfo', st);
    if (allocator || v('flags') & ~(type === 'fence' ? 1 : 0)) return -8;
    return out(r, output, make(r, type, { signaled: !!v('flags') }));
  };
impl.vkGetFenceStatus = (r, [device, id]) => (get(r, id, 'fence').signaled ? 0 : 1);
impl.vkWaitForFences = (r, [device, count, p, all]) => {
  bounded(count, 32, 'fences');
  const flags = Array.from(
    { length: count },
    (_, i) => get(r, u64(r, p + i * 8), 'fence').signaled,
  );
  return (all ? flags.every(Boolean) : flags.some(Boolean)) ? 0 : 2;
};
impl.vkResetFences = (r, [device, count, p]) => {
  bounded(count, 32, 'fences');
  for (let i = 0; i < count; i++) get(r, u64(r, p + i * 8), 'fence').signaled = false;
  return 0;
};
impl.vkQueueSubmit = async (r, [queue, count, p, fence]) => {
  get(r, queue, 'queue');
  bounded(count, 32, 'submissions', 0);
  for (let i = 0; i < count; i++) {
    const v = info(r, p + i * ABI.VkSubmitInfo.__size, 'VkSubmitInfo', 4);
    for (let j = 0; j < bounded(v('waitSemaphoreCount'), 32, 'wait semaphores', 0); j++) {
      const semaphore = get(r, u64(r, v('pWaitSemaphores') + j * 8), 'semaphore');
      if (!semaphore.signaled) throw Error('Vulkan submission semaphore not signaled');
      semaphore.signaled = false;
    }
    for (let j = 0; j < bounded(v('commandBufferCount'), 32, 'submitted commands', 0); j++) {
      const c = get(r, u32(r, v('pCommandBuffers') + j * 4), 'command');
      if (c.status !== 'executable') throw Error('Vulkan command buffer is not executable');
      await state(r).renderer.execute(r, c.commands);
    }
    for (let j = 0; j < bounded(v('signalSemaphoreCount'), 32, 'signal semaphores', 0); j++)
      get(r, u64(r, v('pSignalSemaphores') + j * 8), 'semaphore').signaled = true;
  }
  if (fence) get(r, fence, 'fence').signaled = true;
  return 0;
};
impl.vkQueuePresentKHR = async (r, [queue, p]) => {
  get(r, queue, 'queue');
  const v = info(r, p, 'VkPresentInfoKHR', 1000001001);
  for (let i = 0; i < bounded(v('waitSemaphoreCount'), 32, 'present semaphores', 0); i++) {
    const semaphore = get(r, u64(r, v('pWaitSemaphores') + i * 8), 'semaphore');
    if (!semaphore.signaled) throw Error('Vulkan present semaphore not signaled');
    semaphore.signaled = false;
  }
  for (let i = 0; i < bounded(v('swapchainCount'), 4, 'present chains'); i++) {
    const chain = get(r, u64(r, v('pSwapchains') + i * 8), 'swapchain'),
      index = u32(r, v('pImageIndices') + i * 4);
    if (!chain.acquired.delete(index)) throw Error('Vulkan swapchain image is not acquired');
    await state(r).renderer.present(chain, index);
    if (v('pResults')) r.write32(v('pResults') + i * 4, 0);
  }
  return 0;
};
impl.vkDeviceWaitIdle = impl.vkQueueWaitIdle = async (r) => {
  await state(r).renderer.device.queue.onSubmittedWorkDone();
  return 0;
};
for (const [name, kind] of Object.entries({
  vkFreeMemory: 'memory',
  vkDestroyBuffer: 'buffer',
  vkDestroyImage: 'image',
  vkDestroyImageView: 'view',
  vkDestroySampler: 'sampler',
  vkDestroyShaderModule: 'shader',
  vkDestroyDescriptorSetLayout: 'set-layout',
  vkDestroyPipelineLayout: 'pipeline-layout',
  vkDestroyPipelineCache: 'pipeline-cache',
  vkDestroyPipeline: 'pipeline',
  vkDestroyRenderPass: 'renderpass',
  vkDestroyFramebuffer: 'framebuffer',
  vkDestroyFence: 'fence',
  vkDestroySemaphore: 'semaphore',
}))
  impl[name] = (r, [device, id, allocator]) => {
    if (allocator) throw Error('Vulkan allocation callbacks unsupported');
    destroy(r, id, kind);
  };
impl.vkDestroyDescriptorPool = (r, [device, id]) => {
  const pool = get(r, id, 'descriptor-pool');
  for (const id of pool.sets) destroy(r, id, 'descriptor-set');
  destroy(r, id, 'descriptor-pool');
};
impl.vkDestroyCommandPool = (r, [device, id]) => {
  const pool = get(r, id, 'command-pool');
  for (const id of pool.commands) destroy(r, id, 'command');
  destroy(r, id, 'command-pool');
};
export const vulkanApis = Object.fromEntries(
  Object.entries(impl).map(([name, handler]) => {
    const widths = VK_COMMANDS[name];
    if (!widths) throw Error('Missing Vulkan ABI signature ' + name);
    return [
      'vulkan-1.dll!' + name,
      async (r, argument) => {
        let word = 0;
        const args = widths.map((width) => {
          const low = argument(word++);
          if (width === 1) return low >>> 0;
          const high = argument(word++);
          if (low >>> 0 === 0xffffffff && high >>> 0 === 0xffffffff) return WHOLE;
          const value = (low >>> 0) + (high >>> 0) * 4294967296;
          if (!Number.isSafeInteger(value)) throw Error('Invalid 64-bit Vulkan argument');
          return value;
        });
        try {
          return { result: (await handler(r, args)) ?? 0, argc: word };
        } catch (error) {
          error.message = name + ': ' + error.message;
          throw error;
        }
      },
    ];
  }),
);
