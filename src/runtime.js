import { CPU } from './cpu.js';
import { parsePE, mapPE } from './pe.js';
import { GuestMemory } from './memory.js';
import { API_NAMES, createWin32ApiProvider, importKey } from './win32.js';

export { API_NAMES };

export function inspect(bytes) {
  const pe = parsePE(bytes);
  return {
    ...pe,
    unsupported: pe.imports
      .filter((i) => !API_NAMES[i.dll.toLowerCase()]?.includes(i.name))
      .map((i) => importKey(i.dll, i.name ?? `#${i.ordinal}`)),
  };
}

export class Runtime {
  constructor(
    iced,
    { files, exe, emit = () => {}, request = async () => 1, maxBlocks = 1_000_000 },
  ) {
    this.files = new Map([...files].map(([path, bytes]) => [path, bytes.slice()]));
    this.exe = exe;
    this.cwd = exe.includes('/') ? exe.slice(0, exe.lastIndexOf('/') + 1) : '';
    this.emit = emit;
    this.request = request;
    this.maxBlocks = maxBlocks;

    const bytes = files.get(exe);
    this.pe = inspect(bytes);
    if (this.pe.unsupported.length) {
      throw Error(`Unsupported imports: ${this.pe.unsupported.join(', ')}`);
    }

    this.memory = new WebAssembly.Memory({ initial: 1024, maximum: 1024 });
    mapPE(this.pe, bytes, this.memory);
    this.regions = this.pe.sections.map((section) => ({
      start: this.pe.imageBase + section.rva,
      end: this.pe.imageBase + section.rva + Math.max(section.virtualSize, section.rawSize),
      write: !!(section.characteristics & 0x80000000),
      exec: !!(section.characteristics & 0x20000000),
    }));
    this.regions.push({ start: 0x3000000, end: 0x4000000, write: true, exec: false });
    this.guestMemory = new GuestMemory(this.memory, this.regions);
    // Keep these fields available for callers that inspect guest memory.
    this.view = this.guestMemory.view;
    this.data = this.guestMemory.data;

    this.cpu = new CPU(iced, {
      memory: this.memory,
      read32: (address) => this.read32(address),
      write32: (address, value) => this.write32(address, value),
      executableRanges: this.regions
        .filter((region) => region.exec)
        .map((region) => [region.start, region.end]),
    });

    this.thunks = new Map();
    this.pe.imports.forEach((entry, index) => {
      const address = 0x80000000 + index * 16;
      this.view.setUint32(this.pe.imageBase + entry.iatRva, address, true);
      this.thunks.set(address, entry);
    });

    this.handles = new Map();
    this.nextHandle = 256;
    this.lastError = 0;
    this.exitCode = null;
    this.dirty = new Set();
    this.calls = 0;
    this.blocks = 0;
    this.apiProvider = createWin32ApiProvider();
  }

  check(address, size, write = false) {
    return this.guestMemory.check(address, size, write);
  }

  read32(address) {
    return this.guestMemory.read32(address);
  }

  write32(address, value) {
    return this.guestMemory.write32(address, value);
  }

  string(address) {
    return this.guestMemory.string(address);
  }

  async api(entry) {
    // PE import thunks use x86 stdcall: the guest leaves arguments on its
    // stack, so the host shim pops the return address and removes arguments.
    const stackPointer = this.cpu.r[4].value >>> 0;
    const argument = (index) => this.read32(stackPointer + 4 + index * 4);
    const handler = this.apiProvider.get(importKey(entry.dll, entry.name));
    if (!handler) throw Error(`Unimplemented import ${importKey(entry.dll, entry.name)}`);

    this.calls++;
    const { result, argc } = await handler(this, argument);
    const returnAddress = this.cpu.pop() >>> 0;
    this.cpu.r[4].value = (this.cpu.r[4].value + argc * 4) | 0;
    this.cpu.r[0].value = result | 0;
    return returnAddress;
  }

  async run() {
    const started = performance.now();
    let ip = this.pe.entryPoint;
    while (this.exitCode === null) {
      if (++this.blocks > this.maxBlocks) throw Error('Execution block budget exceeded');
      const thunk = this.thunks.get(ip);
      ip = thunk ? await this.api(thunk) : this.cpu.step(ip);
      if (this.blocks % 2048 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    return {
      exitCode: this.exitCode,
      blocks: this.blocks,
      instructions: this.cpu.instructions,
      compiledBlocks: this.cpu.cache.size,
      wasmBytes: this.cpu.compiledBytes,
      apiCalls: this.calls,
      elapsedMs: performance.now() - started,
      outputs: [...this.dirty].map((path) => ({ path, bytes: this.files.get(path) })),
    };
  }
}
