import { registerThunk } from './thunk-addresses.js';
import { packageDosPath, resolveGuestPath } from './guest-paths.js';

const INVALID_PARAMETER = 0xc000000d,
  NOT_SUPPORTED = 0xc00000bb;
const DLL_NOT_FOUND = 0xc0000135,
  PROCEDURE_NOT_FOUND = 0xc000007a;
const failure = (status) =>
  Object.assign(Error(`Wine loader status 0x${status.toString(16)}`), { ntStatus: status });
export const wineModulePath = (module) =>
  `\\??\\${packageDosPath(module.path ?? '@runtime/' + module.name)}`;

// Opt-in companion to the source-built loader bridge. Native Wine entry points
// call this provider; mapping, forwarders, refcounts and DllMain stay owned by
// Runtime. Wine's private records mirror the graph before any new DllMain runs.
export class WineLoader {
  constructor(runtime, ntdll) {
    this.runtime = runtime;
    this.registered = new Map();
    const address = (name) => {
      const entry = ntdll.pe.exports.find((e) => e.name === name);
      if (!entry || entry.forwarder) throw Error(`Missing source loader export ${name}`);
      return ntdll.base + entry.rva;
    };
    this.configureAddress = address('WineBrowserLoaderConfigure');
    this.syncAddress = address('WineBrowserLoaderSync');
    const threadAttach = ntdll.pe.exports.find((e) => e.name === 'WineBrowserThreadAttach');
    this.threadAttachAddress = threadAttach ? ntdll.base + threadAttach.rva : 0;
    this.threadDetachAddress = address('LdrShutdownThread');
    this.threadExitAddress = address('RtlExitUserThread');
  }
  async enable() {
    const r = this.runtime;
    if (r.wineLoader || !r.graph.hostModuleImages)
      throw Error('Wine loader requires mapped host DLL images');
    const thunk = registerThunk(r.thunks, {
      kind: 'wine-loader',
      name: 'WineBrowserLoaderCallback',
      invoke: async (runtime, argument) => ({ result: await this.call(argument), argc: 6 }),
    });
    const status = await r.callGuest(this.configureAddress, [1, thunk]);
    if (status) {
      r.thunks.delete(thunk);
      throw failure(status);
    }
    r.wineLoader = this;
    await this.sync();
  }
  async sync() {
    const r = this.runtime;
    for (const module of r.graph.modules.values()) {
      // Thunk-only proxies that supply missing exports of a guest component
      // are not independent Wine modules; the component owns the load.
      if (module.proxy) continue;
      if (!module.mapped)
        throw Error(`Wine loader cannot register an unmapped DLL: ${module.name}`);
      const refs =
        module.host ||
        module.pinned ||
        r.graph.startupModules.has(module) ||
        module === r.wineProcess?.module
          ? -1
          : Math.min(module.refs, 32767);
      const flags = (module.initialized ? 4 : 0) | (r.tls.records.has(module) ? 8 : 0);
      const signature = `${module.base}:${flags}:${refs}`;
      if (this.registered.get(module) === signature) continue;
      const name = r.allocString(wineModulePath(module), true);
      try {
        const status = await r.callGuest(this.syncAddress, [module.base, name, flags, refs]);
        if (status) throw failure(status);
        this.registered.set(module, signature);
      } finally {
        r.free(name);
      }
    }
  }
  async forget(modules) {
    for (const module of modules) {
      if (!this.registered.has(module)) continue;
      const status = await this.runtime.callGuest(this.syncAddress, [module.base, 0, 0, 0]);
      if (status) throw failure(status);
      this.registered.delete(module);
    }
  }
  check(pointer, size, write = false) {
    try {
      return this.runtime.check(pointer, size, write);
    } catch {
      throw failure(0xc0000005);
    }
  }
  countedString(pointer, wide) {
    const r = this.runtime;
    this.check(pointer, 8);
    const size = r.guestMemory.read(pointer, 2),
      max = r.guestMemory.read(pointer + 2, 2);
    const buffer = r.read32(pointer + 4),
      width = wide ? 2 : 1;
    if (!buffer || !size || size > max || size > 65534 || size % width)
      throw failure(INVALID_PARAMETER);
    this.check(buffer, size);
    let text = '';
    for (let offset = 0; offset < size; offset += width) {
      const character = r.guestMemory.read(buffer + offset, width);
      if (!character || (!wide && character > 127)) throw failure(INVALID_PARAMETER);
      text += String.fromCharCode(character);
    }
    return text;
  }
  searchOptions(pointer) {
    if (!pointer) return {};
    // Wine uses low pointer values for encoded search flags; those policies
    // need separate support. Ordinary path lists remain confined to the volume.
    if (pointer < 65536) throw failure(NOT_SUPPORTED);
    const directories = [];
    for (const path of this.runtime.wideString(pointer).split(';')) {
      if (!path) continue;
      try {
        const directory = resolveGuestPath(path);
        directories.push(directory ? directory + '/' : '');
      } catch {
        // Windows system directories have no package files. Builtin and host
        // DLL resolution still follows the graph's explicit fallback policy.
      }
    }
    return directories.length ? { searchDirectories: directories } : {};
  }
  async call(a) {
    const r = this.runtime,
      moduleAt = (base) => [...r.graph.modules.values()].find((m) => m.base === base);
    try {
      switch (a(0)) {
        case 1: {
          // LdrLoadDll(path, flags, UNICODE_STRING*, HMODULE*)
          if (a(2)) return NOT_SUPPORTED;
          this.check(a(4), 4, true);
          const name = this.countedString(a(3), true),
            options = this.searchOptions(a(1));
          const base = await r.loadLibrary(name, options);
          r.write32(a(4), base);
          return 0;
        }
        case 2: {
          // LdrGetProcedureAddress(module, ANSI_STRING*, ordinal, void**)
          this.check(a(4), 4, true);
          const module = moduleAt(a(1));
          if (!module) return DLL_NOT_FOUND;
          const symbol = a(2) ? this.countedString(a(2), false) : a(3);
          const address = await r.resolveExport(module, symbol);
          r.write32(a(4), address);
          return 0;
        }
        case 3: {
          // LdrGetDllHandleEx(flags, path, characteristics, name, base)
          const flags = a(1);
          if (flags & ~3 || flags === 3) return INVALID_PARAMETER;
          if (a(2) || a(3)) return NOT_SUPPORTED;
          this.check(a(5), 4, true);
          const module = r.graph.findLoaded(this.countedString(a(4), true));
          if (!module) return DLL_NOT_FOUND;
          if (flags & 2) module.pinned = true;
          if (!(flags & 1)) module.refs++;
          await this.sync();
          r.write32(a(5), module.base);
          return 0;
        }
        case 4: {
          // LdrAddRefDll(flags, module)
          if (a(1) & ~1) return INVALID_PARAMETER;
          const module = moduleAt(a(2));
          if (!module) return DLL_NOT_FOUND;
          if (a(1) & 1) module.pinned = true;
          module.refs++;
          await this.sync();
          return 0;
        }
        case 5:
          return (await r.freeLibrary(a(1))) ? 0 : DLL_NOT_FOUND;
        case 6:
          if ([1, 2, 3, 4, 5].some((index) => a(index))) return INVALID_PARAMETER;
          await r.shutdownProcess();
          return 0;
        default:
          return NOT_SUPPORTED;
      }
    } catch (error) {
      if (error.ntStatus) return error.ntStatus;
      if (error.win32Error)
        return (
          { 126: DLL_NOT_FOUND, 127: PROCEDURE_NOT_FOUND, 193: 0xc000007b, 1114: 0xc0000142 }[
            error.win32Error
          ] ?? NOT_SUPPORTED
        );
      // Unsupported CPU/API execution is a real runtime failure, never a
      // fabricated NT success or a misleading missing-DLL status.
      throw error;
    }
  }
}
