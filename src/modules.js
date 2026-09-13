import { parsePE, mapPE } from './pe.js';
import { normalizePath } from './package.js';
import { importKey } from './win32.js';

const dllName = (name) => {
  const path = normalizePath(name);
  if (path.includes('/')) throw Error('DLL search accepts basenames only');
  return path.includes('.') ? path : path + '.dll';
};
/** A PE module graph. Guest exports remain guest addresses, including forwarded exports. */
export class ModuleGraph {
  constructor(files, exe, apiNames, builtinFiles = new Map()) {
    this.files = files;
    this.builtinFiles = builtinFiles;
    this.exe = exe;
    this.cwd = exe.includes('/') ? exe.slice(0, exe.lastIndexOf('/') + 1) : '';
    this.apiNames = apiNames;
    this.modules = new Map();
    this.unresolved = [];
    this.thunks = new Map();
    this.nextBase = 0x1000000;
    this.nextHostBase = 0x70000000;
    this.main = this.loadPath(exe, false);
    this.linkAll();
    // The initial executable/import closure stays resident for process life.
    this.startupModules = new Set(this.modules.values());
  }
  loadPath(path, dll = true, refs = 0) {
    const name = path.split('/').at(-1).toLowerCase();
    if (this.modules.has(name)) return this.modules.get(name);
    if (this.modules.size >= 128) throw Error('Module count limit exceeded');
    const bytes = path.startsWith('@runtime/')
      ? this.builtinFiles.get(path.slice(9))
      : this.files.get(path);
    if (!bytes) throw Error(`Missing module ${path}`);
    const pe = parsePE(bytes, { allowDll: dll });
    if (dll && !pe.isDll) throw Error(`${path} is not a DLL`);
    const module = {
      name,
      path,
      bytes,
      pe,
      base: 0,
      // Import edges and startup roots are tracked separately from explicit
      // LoadLibrary references.
      refs,
      dependencies: [],
      mapped: false,
      initialized: false,
    };
    this.modules.set(name, module); // Break import cycles before visiting dependencies.
    return module;
  }
  load(name, retain = false) {
    name = dllName(name);
    let module = this.modules.get(name);
    if (module) {
      if (retain) module.refs++;
      return module;
    }
    for (const path of [this.cwd + name, name])
      if (this.files.has(path)) return this.loadPath(path, true, retain ? 1 : 0);
    if (this.builtinFiles.has(name)) return this.loadPath('@runtime/' + name, true, retain ? 1 : 0);
    if (this.apiNames[name]) {
      if (this.nextHostBase >= 0x80000000) throw Error('Host module handle space exhausted');
      module = {
        name,
        host: true,
        base: this.nextHostBase,
        refs: retain ? 1 : 0,
        initialized: true,
      };
      this.nextHostBase += 0x10000;
      this.modules.set(name, module);
      return module;
    }
    throw Error(`Missing DLL ${name}`);
  }
  linkAll() {
    for (const module of this.modules.values()) {
      if (module.host || module.linked) continue;
      module.linked = true;
      for (const entry of module.pe.imports) {
        try {
          const dependency = this.load(entry.dll);
          module.dependencies.push(dependency);
          this.resolve(dependency, entry.name ?? entry.ordinal);
        } catch (e) {
          this.unresolved.push({ module: module.name, entry, error: e.message });
        }
      }
    }
  }
  resolve(module, symbol, seen = new Set()) {
    const key = importKey(module.name, symbol);
    if (seen.has(key) || seen.size > 32) throw Error(`Export forwarder cycle: ${key}`);
    seen.add(key);
    if (module.host) {
      if (typeof symbol !== 'string' || !this.apiNames[module.name]?.includes(symbol))
        throw Error(`Unsupported import ${key}`);
      return { host: true, module, symbol };
    }
    const entry = module.pe.exports.find((e) =>
      typeof symbol === 'number' ? e.ordinal === symbol : e.name === symbol,
    );
    if (!entry) throw Error(`Missing export ${key}`);
    if (entry.forwarder) {
      const split = entry.forwarder.lastIndexOf('.');
      if (split < 1) throw Error(`Invalid forwarder ${entry.forwarder}`);
      const dll = entry.forwarder.slice(0, split),
        name = entry.forwarder.slice(split + 1);
      const dependency = this.load(dll);
      if (!module.dependencies.includes(dependency)) module.dependencies.push(dependency);
      return this.resolve(dependency, name.startsWith('#') ? Number(name.slice(1)) : name, seen);
    }
    return { module, rva: entry.rva };
  }
  map(memory, regions) {
    this.linkAll();
    if (this.unresolved.length)
      throw Error(this.unresolved.map((u) => `${u.module}: ${u.error}`).join('\n'));
    for (const module of this.modules.values()) {
      if (module.host || module.mapped) continue;
      const preferred = module.pe.imageBase,
        size = module.pe.imageSize;
      const available = (base) =>
        base >= 0x10000 &&
        base + size < 0x2e00000 &&
        !regions.some((r) => base < r.end && base + size > r.start);
      let base = preferred;
      if (!available(base)) {
        base = this.nextBase;
        while (!available(base) && base + size < 0x2e00000) base += 0x10000;
        if (!available(base)) throw Error('Module address space exhausted');
        this.nextBase = (base + size + 0xffff) & ~0xffff;
      }
      module.pe = mapPE(module.pe, module.bytes, memory, base);
      module.base = base;
      module.mapped = true;
      // Reserve image gaps too. Actual header/section regions below grant
      // access; this guard only keeps virtual allocations out of the image.
      regions.push({
        start: base,
        end: base + size,
        read: false,
        write: false,
        exec: false,
        kind: 'image-reservation',
        module: module.name,
      });
      regions.push({
        start: base,
        end: base + module.pe.headersSize,
        write: false,
        exec: false,
        module: module.name,
      });
      for (const s of module.pe.sections)
        regions.push({
          start: base + s.rva,
          end: base + s.rva + Math.max(s.rawSize, s.virtualSize),
          write: !!(s.characteristics & 0x80000000),
          exec: !!(s.characteristics & 0x20000000),
          module: module.name,
        });
    }
    const view = new DataView(memory.buffer);
    for (const module of this.modules.values()) {
      if (module.host || module.importsPatched) continue;
      for (const entry of module.pe.imports) {
        const target = this.resolve(
          this.modules.get(dllName(entry.dll)),
          entry.name ?? entry.ordinal,
        );
        view.setUint32(module.base + entry.iatRva, this.address(target), true);
      }
      module.importsPatched = true;
    }
  }
  address(target) {
    if (!target.host) {
      if (!target.module.mapped) throw Error(`Module is not mapped: ${target.module.name}`);
      return target.module.base + target.rva;
    }
    const key = importKey(target.module.name, target.symbol);
    let thunk = [...this.thunks].find(([, entry]) => importKey(entry.dll, entry.name) === key)?.[0];
    if (thunk === undefined) {
      thunk = 0x80000000 + this.thunks.size * 16;
      this.thunks.set(thunk, { dll: target.module.name, name: target.symbol });
    }
    return thunk;
  }
  initializationOrder() {
    const seen = new Set(),
      order = [];
    const visit = (module) => {
      if (seen.has(module) || module.host) return;
      seen.add(module);
      for (const dep of module.dependencies) visit(dep);
      if (module !== this.main) order.push(module);
    };
    for (const module of this.modules.values()) visit(module);
    return order;
  }
  describe() {
    return [...this.modules.values()].map((m) => ({
      name: m.name,
      host: !!m.host,
      base: m.base,
      preferredBase: m.pe?.preferredImageBase ?? m.pe?.imageBase,
      refs: m.refs,
      initialized: m.initialized,
    }));
  }
  checkpoint() {
    return {
      modules: new Map(
        [...this.modules].map(([name, module]) => [
          name,
          {
            module,
            state: { ...module, dependencies: module.dependencies?.slice() },
          },
        ]),
      ),
      unresolved: this.unresolved.slice(),
      thunks: new Map(this.thunks),
      nextBase: this.nextBase,
      nextHostBase: this.nextHostBase,
    };
  }
  restore(checkpoint) {
    this.modules.clear();
    for (const [name, { module, state }] of checkpoint.modules) {
      for (const key of Object.keys(module)) delete module[key];
      Object.assign(module, state);
      this.modules.set(name, module);
    }
    this.unresolved = checkpoint.unresolved;
    this.thunks.clear();
    for (const [address, thunk] of checkpoint.thunks) this.thunks.set(address, thunk);
    this.nextBase = checkpoint.nextBase;
    this.nextHostBase = checkpoint.nextHostBase;
  }
}
