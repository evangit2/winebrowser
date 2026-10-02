import test from 'node:test';
import assert from 'node:assert/strict';
import { vulkanApis } from '../src/vulkan.js';
import { VK_ABI, VK_COMMANDS } from '../src/vulkan-abi.js';
import { API_NAMES, createWin32ApiProvider } from '../src/win32.js';
function fixture() {
  const data = new Uint8Array(2 * 1024 * 1024),
    view = new DataView(data.buffer);
  let next = 0x10000;
  const r = {
    data,
    view,
    windows: { windows: new Map([[0x20000, {}]]) },
    check(p, n) {
      if (!p || !Number.isInteger(n) || n < 1 || p + n > data.length) throw Error('Guest bounds');
      return p;
    },
    read32(p) {
      return view.getUint32(this.check(p, 4), true);
    },
    write32(p, v) {
      view.setUint32(this.check(p, 4), v >>> 0, true);
    },
    allocate(n) {
      const p = next;
      next = (next + n + 15) & ~15;
      this.check(p, n);
      return p;
    },
    free() {},
    string(p) {
      let value = '';
      while (data[this.check(p++, 1)]) value += String.fromCharCode(data[p - 1]);
      return value;
    },
    graphics: {
      async initialize() {
        this.device = { queue: { async onSubmittedWorkDone() {} } };
      },
    },
  };
  const call = async (name, args) => {
    const words = args.flatMap((value, i) =>
      VK_COMMANDS[name][i] === 2
        ? [value >>> 0, value === Infinity ? 0xffffffff : Math.floor(value / 4294967296)]
        : [value],
    );
    return vulkanApis['vulkan-1.dll!' + name](r, (i) => words[i]);
  };
  const info = (type, st, fields = {}) => {
    const p = r.allocate(VK_ABI[type].__size);
    r.write32(p, st);
    for (const [name, value] of Object.entries(fields)) r.write32(p + VK_ABI[type][name], value);
    return p;
  };
  const instance = async () => {
    await call('vkCreateInstance', [info('VkInstanceCreateInfo', 1), 0, 0x100]);
    return r.read32(0x100);
  };
  const device = async () => {
    await instance();
    const physical = [...r.vulkan.objects.values()].find((o) => o.kind === 'physical').id;
    const queue = info('VkDeviceQueueCreateInfo', 2, { queueCount: 1 });
    await call('vkCreateDevice', [
      physical,
      info('VkDeviceCreateInfo', 3, { queueCreateInfoCount: 1, pQueueCreateInfos: queue }),
      0,
      0x104,
    ]);
    return r.read32(0x104);
  };
  return { r, call, info, instance, device };
}
test('PE32 ABI keeps struct size separate from the VkDeviceSize member offset', () => {
  assert.equal(VK_ABI.VkApplicationInfo.__size, 28);
  assert.equal(VK_ABI.VkMemoryRequirements.__size, 24);
  assert.equal(VK_ABI.VkMemoryRequirements.size, 0);
  assert.equal(VK_ABI.VkMemoryRequirements.alignment, 8);
  assert.equal(VK_ABI.VkMemoryRequirements.memoryTypeBits, 16);
  assert.equal(VK_ABI.VkImageViewCreateInfo.image, 16);
  assert.deepEqual(VK_COMMANDS.vkMapMemory, [1, 2, 2, 2, 1, 1]);
  assert.deepEqual(VK_COMMANDS.vkCreateSwapchainKHR, [1, 1, 1, 1]);
  assert.deepEqual(VK_COMMANDS.vkCmdBindIndexBuffer, [1, 2, 2, 1]);
  assert.deepEqual(VK_COMMANDS.vkCmdPushConstants, [1, 2, 1, 1, 1, 1]);
});
test('Vulkan loader names and handlers reach the ordinary module provider', () => {
  const provider = createWin32ApiProvider();
  for (const name of [
    'vkGetInstanceProcAddr',
    'vkCreateInstance',
    'vkQueueSubmit',
    'vkQueuePresentKHR',
  ]) {
    assert.ok(API_NAMES['vulkan-1.dll'].includes(name));
    assert.ok(provider.has('vulkan-1.dll!' + name));
  }
  assert.ok(API_NAMES['vulkan-1.dll'].includes('vkCreateComputePipelines'));
});
test('push constants capture immutable command bytes and respect layout ranges', async () => {
  const { r, call, info, device } = fixture();
  const dev = await device();
  const range = r.allocate(VK_ABI.VkPushConstantRange.__size);
  r.write32(range, 1);
  r.write32(range + 4, 0);
  r.write32(range + 8, 64);
  await call('vkCreatePipelineLayout', [
    dev,
    info('VkPipelineLayoutCreateInfo', 30, {
      pushConstantRangeCount: 1,
      pPushConstantRanges: range,
    }),
    0,
    0x108,
  ]);
  const layout = r.read32(0x108);
  await call('vkCreateCommandPool', [dev, info('VkCommandPoolCreateInfo', 39), 0, 0x110]);
  await call('vkAllocateCommandBuffers', [
    dev,
    info('VkCommandBufferAllocateInfo', 40, {
      commandPool: r.read32(0x110),
      commandBufferCount: 1,
    }),
    0x118,
  ]);
  const cmd = r.read32(0x118);
  await call('vkBeginCommandBuffer', [cmd, info('VkCommandBufferBeginInfo', 42)]);
  const data = r.allocate(64);
  r.write32(data, 17);
  await call('vkCmdPushConstants', [cmd, layout, 1, 0, 64, data]);
  r.write32(data, 29);
  await call('vkCmdPushConstants', [cmd, layout, 1, 0, 64, data]);
  const commands = r.vulkan.objects.get(cmd).commands;
  assert.equal(new DataView(commands[0].bytes.buffer).getUint32(0, true), 17);
  assert.equal(new DataView(commands[1].bytes.buffer).getUint32(0, true), 29);
  await assert.rejects(
    call('vkCmdPushConstants', [cmd, layout, 16, 0, 64, data]),
    /push constants/,
  );
  await assert.rejects(call('vkCmdPushConstants', [cmd, layout, 1, 4, 64, data]), /push constants/);
  await assert.rejects(call('vkCmdPushConstants', [cmd, layout, 1, 0, 63, data]), /push constants/);
});
test('unsupported Vulkan 1.3 static imports fail while optional loader queries remain null', async () => {
  const { r, call, instance } = fixture();
  const id = await instance(),
    name = r.allocate(32);
  r.data.set(new TextEncoder().encode('vkCmdBeginRendering\0'), name);
  assert.equal((await call('vkGetInstanceProcAddr', [id, name])).result, 0);
  await assert.rejects(call('vkCmdBeginRendering', [0, 0]), /unavailable/);
});
test('instance extension enumeration reports capacity, VK_INCOMPLETE and bounded names', async () => {
  const { r, call } = fixture();
  assert.equal((await call('vkEnumerateInstanceExtensionProperties', [0, 0x100, 0])).result, 0);
  assert.equal(r.read32(0x100), 2);
  r.write32(0x100, 1);
  assert.equal((await call('vkEnumerateInstanceExtensionProperties', [0, 0x100, 0x200])).result, 5);
  assert.equal(r.string(0x200), 'VK_KHR_surface');
  assert.equal(r.read32(0x100), 1);
  r.write32(0x100, 1025);
  await assert.rejects(
    call('vkEnumerateInstanceExtensionProperties', [0, 0x100, 0x200]),
    /capacity/,
  );
});
test('instance creation rejects extension chains, wrong sType and callbacks', async () => {
  const { r, call, info } = fixture();
  await assert.rejects(
    call('vkCreateInstance', [info('VkInstanceCreateInfo', 3), 0, 0x100]),
    /sType/,
  );
  await assert.rejects(
    call('vkCreateInstance', [info('VkInstanceCreateInfo', 1, { pNext: 0x200 }), 0, 0x100]),
    /pNext/,
  );
  assert.equal(
    (await call('vkCreateInstance', [info('VkInstanceCreateInfo', 1), 0x200, 0x100])).result,
    -6,
  );
  assert.equal(r.vulkan, undefined);
});
test('memory requirements, wide arguments and mapped host-coherent storage preserve addresses', async () => {
  const { r, call, info, device } = fixture();
  const dev = await device();
  const p = info('VkBufferCreateInfo', 12, { size: 1216, usage: 16 });
  await call('vkCreateBuffer', [dev, p, 0, 0x108]);
  const buffer = r.read32(0x108);
  const response = await call('vkGetBufferMemoryRequirements', [dev, buffer, 0x200]);
  assert.equal(response.argc, 4);
  assert.equal(r.read32(0x200), 1216);
  assert.equal(r.read32(0x208), 16);
  assert.equal(r.read32(0x210), 1);
  const allocation = info('VkMemoryAllocateInfo', 5, { allocationSize: 1216 });
  await call('vkAllocateMemory', [dev, allocation, 0, 0x110]);
  const memory = r.read32(0x110);
  assert.equal((await call('vkBindBufferMemory', [dev, buffer, memory, 0])).argc, 7);
  await call('vkMapMemory', [dev, memory, 0, 1216, 0, 0x118]);
  const address = r.read32(0x118);
  assert.ok(address >= 0x10000);
  r.write32(address, 0x12345678);
  assert.equal((await call('vkMapMemory', [dev, memory, 0, 1216, 0, 0x118])).result, -5);
  await call('vkUnmapMemory', [dev, memory]);
  await assert.rejects(call('vkMapMemory', [dev, memory, 1200, 32, 0, 0x118]), /mapped size/);
  await call('vkFreeMemory', [dev, memory, 0]);
  await assert.rejects(call('vkMapMemory', [dev, memory, 0, 4, 0, 0x118]), /released/);
});
test('Vulkan shader modules reject truncated headers and retain copied native SPIR-V', async () => {
  const { r, call, info, device } = fixture();
  const dev = await device();
  const p = info('VkShaderModuleCreateInfo', 16, { codeSize: 20, pCode: 0x200 });
  assert.equal((await call('vkCreateShaderModule', [dev, p, 0, 0x100])).result, -3);
  r.write32(0x200, 0x07230203);
  assert.equal((await call('vkCreateShaderModule', [dev, p, 0, 0x100])).result, 0);
  const shader = r.vulkan.objects.get(r.read32(0x100));
  r.write32(0x200, 0);
  assert.equal(new DataView(shader.bytes.buffer).getUint32(0, true), 0x07230203);
});
test('command recording, reset and release reject invalid states', async () => {
  const { r, call, info, device } = fixture();
  const dev = await device();
  await call('vkCreateCommandPool', [dev, info('VkCommandPoolCreateInfo', 39), 0, 0x100]);
  const pool = r.read32(0x100);
  await call('vkAllocateCommandBuffers', [
    dev,
    info('VkCommandBufferAllocateInfo', 40, { commandPool: pool, commandBufferCount: 1 }),
    0x108,
  ]);
  const cmd = r.read32(0x108);
  await assert.rejects(call('vkCmdDraw', [cmd, 36, 1, 0, 0]), /not recording/);
  const begin = info('VkCommandBufferBeginInfo', 42);
  assert.equal((await call('vkBeginCommandBuffer', [cmd, begin])).result, 0);
  assert.equal((await call('vkBeginCommandBuffer', [cmd, begin])).result, -3);
  await assert.rejects(call('vkCmdDraw', [cmd, 65537, 1, 0, 0]), /draw vertices/);
  await call('vkCmdDraw', [cmd, 36, 1, 0, 0]);
  await call('vkEndCommandBuffer', [cmd]);
  assert.equal(r.vulkan.objects.get(cmd).commands.length, 1);
  await call('vkResetCommandBuffer', [cmd, 0]);
  assert.equal(r.vulkan.objects.get(cmd).commands.length, 0);
  await call('vkDestroyCommandPool', [dev, pool, 0]);
  await assert.rejects(call('vkBeginCommandBuffer', [cmd, begin]), /released/);
});
