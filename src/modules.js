import { parsePE, mapPE } from './pe.js';
import { resolveGuestPath } from './guest-paths.js';
import { importKey } from './win32.js';
import { registerThunk } from './thunk-addresses.js';
import { hostModuleImage } from './host-module-image.js';
import { canonicalHostSymbol, isHostDataExport } from './host-export-ordinals.js';
import { resolveApiSet } from './api-sets.js';

// A DLL reached through the Windows system directory rather than the package
// volume: such a path names a runtime-provided Windows module.
const SYSTEM_DLL_PATH = /^(?:[a-z]:)?\/windows\/system32\//i;
const dllName = (name) => {
  if (typeof name !== 'string' || !name || name.includes('\0')) throw Error('Invalid DLL name');
  name = name.replaceAll('\\', '/');
  const basename = name.split('/').at(-1);
  if (!basename || basename === '.' || basename === '..') throw Error('Invalid DLL name');
  return name.endsWith('.') ? name.slice(0, -1) : basename.includes('.') ? name : name + '.dll';
};
/** A PE module graph. Guest exports remain guest addresses, including forwarded exports. */
export class ModuleGraph {
  constructor(files, exe, apiNames, builtinFiles = new Map(), { hostModuleImages = false } = {}) {
    this.hostModuleImages = hostModuleImages;
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
  loadPath(path, dll = true, refs = 0, options = {}) {
    const name = path.split('/').at(-1).toLowerCase();
    const existing = [...this.modules.values()].find((m) => m.path === path);
    if (existing) return existing;
    if (this.modules.size >= 128) throw Error('Module count limit exceeded');
    const bytes = options.builtin ? this.builtinFiles.get(path.slice(9)) : this.files.get(path);
    if (!bytes) throw Error(`Missing module ${path}`);
    let pe;
    try {
      pe = parsePE(bytes, { allowDll: dll });
      if (dll && !pe.isDll) throw Error(`${path} is not a DLL`);
    } catch (error) {
      error.win32Error = 193; // ERROR_BAD_EXE_FORMAT
      throw error;
    }
    const key = this.modules.has(name) ? path : name;
    const module = {
      key,
      name,
      path,
      searchDirectories: options.searchDirectories,
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
    this.modules.set(key, module); // Break import cycles before visiting dependencies.
    return module;
  }
  paths(name, searchDirectories = [this.cwd, '']) {
    const paths = [];
    for (const directory of searchDirectories) {
      try {
        const path = resolveGuestPath(name, directory);
        if (!paths.includes(path)) paths.push(path);
      } catch {
        // A relative parent path may be valid from the application directory
        // but escape the volume from another search directory.
      }
    }
    return paths;
  }
  findLoaded(name) {
    name = resolveApiSet(dllName(name));
    if (!/[/:]/.test(name))
      return [...this.modules.values()].find((module) => module.name === name.toLowerCase());
    for (const path of this.paths(name)) {
      const found = [...this.modules.values()].find((module) => module.path === path);
      if (found) return found;
    }
  }
  load(name, retain = false, options = {}) {
    name = resolveApiSet(dllName(name));
    const qualified = /[/:]/.test(name);
    const paths = this.paths(name, options.searchDirectories);
    const targetPath = paths.find(
      (path) => this.files.has(path) || [...this.modules.values()].some((m) => m.path === path),
    );
    let module = qualified
      ? targetPath === undefined
        ? undefined
        : [...this.modules.values()].find((m) => m.path === targetPath)
      : [...this.modules.values()].find((m) => m.name === name.toLowerCase());
    if (module) {
      if (retain) module.refs++;
      return module;
    }
    for (const path of paths)
      if (this.files.has(path)) return this.loadPath(path, true, retain ? 1 : 0, options);
    // A path under the Windows system directory names a DLL the runtime
    // provides as a host module: LoadLibraryA("C:\\Windows\\System32\\ws2_32.dll")
    // must resolve to the same provider a bare "ws2_32.dll" import reaches.
    // A path anywhere else is a literal package path, so a missing file there
    // is a genuine failure rather than a same-named module from elsewhere.
    if (qualified && !SYSTEM_DLL_PATH.test(name.replaceAll('\\', '/')))
      throw Error(`Missing DLL ${name}`);
    const basename = name.split(/[/\\]/).at(-1).toLowerCase();
    const rest = qualified ? basename : name.toLowerCase();
    if (qualified) {
      const located = [...this.modules.values()].find((m) => m.name === basename);
      if (located) {
        if (retain) located.refs = (located.refs ?? 0) + 1;
        return located;
      }
    }
    if (this.builtinFiles.has(rest))
      return this.loadPath('@runtime/' + rest, true, retain ? 1 : 0, { ...options, builtin: true });
    if (this.apiNames[rest]) return this.loadHost(rest, retain ? 1 : 0);
    throw Error(`Missing DLL ${name}`);
    name = name.toLowerCase();
    if (this.builtinFiles.has(name))
      return this.loadPath('@runtime/' + name, true, retain ? 1 : 0, { ...options, builtin: true });
    if (this.apiNames[name]) return this.loadHost(name, retain ? 1 : 0);
    throw Error(`Missing DLL ${name}`);
  }
  hostProxy(name) {
    let module = this.modules.get('@proxy/' + name);
    if (module) return module;
    if (this.modules.size >= 128) throw Error('Module count limit exceeded');
    if (this.nextHostBase >= 0x80000000) throw Error('Host module handle space exhausted');
    module = {
      key: '@proxy/' + name,
      name,
      host: true,
      proxy: true,
      base: this.nextHostBase,
      refs: 0,
      initialized: true,
    };
    this.nextHostBase += 0x10000;
    this.modules.set(module.key, module);
    return module;
  }
  loadHost(name, refs = 0, { proxyPath } = {}) {
    if (this.modules.size >= 128) throw Error('Module count limit exceeded');
    if (this.nextHostBase >= 0x80000000) throw Error('Host module handle space exhausted');
    const module = {
      key: name,
      name,
      host: true,
      proxyPath,
      base: this.nextHostBase,
      refs,
      initialized: true,
    };
    this.nextHostBase += 0x10000;
    if (this.hostModuleImages) {
      const image = hostModuleImage(name, this.apiNames[name], (symbol) =>
        this.hostThunk({ module, symbol }),
      );
      Object.assign(module, {
        path: proxyPath ?? '@host/' + name,
        bytes: image.bytes,
        pe: parsePE(image.bytes, { allowDll: true }),
        exportRvas: image.rvas,
        base: 0,
        dependencies: [],
      });
    }
    // A builtin guest component may share this DLL name; keep both entries so
    // unimplemented exports can still delegate to the host provider. A proxy
    // reuses the guest path, so it is not a distinct module to native loaders.
    if (this.modules.has(name)) module.key = '@host/' + name;
    else if (proxyPath) module.key = '@host/' + name;
    this.modules.set(module.key, module);
    return module;
  }
  linkAll() {
    for (const module of this.modules.values()) {
      if (module.host || module.linked) continue;
      module.linked = true;
      module.importModules = new Map();
      for (const entry of module.pe.imports) {
        try {
          const dependency = this.load(entry.dll, false, {
            searchDirectories: module.searchDirectories,
          });
          module.importModules.set(entry.iatRva, dependency);
          module.dependencies.push(dependency);
          this.resolve(dependency, entry.name ?? entry.ordinal);
        } catch (e) {
          this.unresolved.push({ module: module.name, entry, error: e.message });
        }
      }
    }
  }
  resolve(module, symbol, seen = new Set()) {
    const key = importKey(module.key, symbol);
    if (seen.has(key) || seen.size > 32) throw Error(`Export forwarder cycle: ${key}`);
    seen.add(key);
    if (module.host) {
      symbol = canonicalHostSymbol(module.name, symbol, this.apiNames[module.name]);
      // Ordinals may be provided explicitly as "#N" by a host export table.
      // Diagnostics use this only to install a fail-on-call trap.
      if (typeof symbol === 'number')
        symbol = module.pe?.exports.find((entry) => entry.ordinal === symbol)?.name ?? `#${symbol}`;
      if (!this.apiNames[module.name]?.includes(symbol)) throw Error(`Unsupported import ${key}`);
      return { host: true, module, symbol };
    }
    const entry = module.pe.exports.find((e) =>
      typeof symbol === 'number' ? e.ordinal === symbol : e.name === symbol,
    );
    if (!entry) {
      // A partial guest component (for example the source-built shell32 with
      // only CommandLineToArgvW) delegates every other named export to the
      // host provider registered for the same DLL name. Explicit failures are
      // preserved when no host implementation exists.
      if (!module.path?.startsWith('@runtime/')) throw Error(`Missing export ${key}`);
      const hostName =
        typeof symbol === 'number'
          ? undefined
          : canonicalHostSymbol(module.name, symbol, this.apiNames[module.name] ?? []);
      if (hostName && this.apiNames[module.name]?.includes(hostName)) {
        // Thunk-only host provider. It has no PE image, so it is never mapped
        // or registered with the native Wine loader: the guest component
        // remains the single module for this DLL name.
        return { host: true, module: this.hostProxy(module.name), symbol: hostName };
      }
      throw Error(`Missing export ${key}`);
    }
    if (entry.forwarder) {
      const split = entry.forwarder.lastIndexOf('.');
      if (split < 1) throw Error(`Invalid forwarder ${entry.forwarder}`);
      const dll = entry.forwarder.slice(0, split),
        name = entry.forwarder.slice(split + 1);
      const dependency = this.load(dll, false, { searchDirectories: module.searchDirectories });
      if (!module.dependencies.includes(dependency)) module.dependencies.push(dependency);
      return this.resolve(dependency, name.startsWith('#') ? Number(name.slice(1)) : name, seen);
    }
    return { module, rva: entry.rva };
  }
  map(memory, regions) {
    this.linkAll();
    if (this.unresolved.length)
      throw Error(this.unresolved.map((u) => `${u.module}: ${u.error}`).join('\n'));
    // Resolve every import target before mapping. Resolving can discover a
    // host provider for an export a partial guest component does not implement,
    // and that host image has to be mapped before any IAT can reference it.
    const pending = [];
    for (const module of this.modules.values()) {
      if (module.host || module.importsPatched) continue;
      for (const entry of module.pe.imports)
        pending.push({
          module,
          entry,
          target: this.resolve(module.importModules.get(entry.iatRva), entry.name ?? entry.ordinal),
        });
    }
    for (const module of this.modules.values()) {
      if (!module.pe || module.mapped) continue;
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
        module: module.key,
      });
      regions.push({
        start: base,
        // Windows maps the whole header page, including its zero padding.
        end:
          base +
          Math.min(
            Math.ceil(module.pe.headersSize / 0x1000) * 0x1000,
            ...module.pe.sections.map((section) => section.rva),
          ),
        write: false,
        exec: false,
        module: module.key,
      });
      for (const section of module.pe.sections) {
        const endRva = section.rva + Math.max(section.rawSize, section.virtualSize);
        const nextRva = Math.min(
          module.pe.imageSize,
          ...module.pe.sections.filter((next) => next.rva > section.rva).map((next) => next.rva),
        );
        regions.push({
          start: base + section.rva,
          end: base + Math.min(Math.ceil(endRva / 0x1000) * 0x1000, nextRva),
          write: !!(section.characteristics & 0x80000000),
          exec: !!(section.characteristics & 0x20000000),
          module: module.key,
        });
      }
    }
    const view = new DataView(memory.buffer);
    // A host data export (msvcrt's _iob and the other CRT globals) is a value,
    // not a function: its IAT slot must hold the storage address, never a thunk
    // or an export stub. The storage can only be materialized once the runtime
    // heap exists, which is later than mapping, so the slots are recorded here
    // and the Runtime rewrites them after it constructs the heap.
    this.hostDataSlots = [];
    for (const { module, entry, target } of pending) {
      if (target.host && isHostDataExport(target.module.name, target.symbol))
        this.hostDataSlots.push({
          iat: module.base + entry.iatRva,
          dll: target.module.name,
          symbol: target.symbol,
        });
      view.setUint32(module.base + entry.iatRva, this.address(target), true);
    }
    for (const module of this.modules.values()) if (!module.host) module.importsPatched = true;
  }
  address(target) {
    if (!target.host) {
      if (!target.module.mapped) throw Error(`Module is not mapped: ${target.module.name}`);
      return target.module.base + target.rva;
    }
    if (target.module.exportRvas) {
      if (!target.module.mapped) throw Error(`Module is not mapped: ${target.module.name}`);
      const rva = target.module.exportRvas.get(target.symbol);
      if (rva === undefined) throw Error(`Missing host export ${target.symbol}`);
      return target.module.base + rva;
    }
    return this.hostThunk(target);
  }
  hostThunk(target) {
    const key = importKey(target.module.name, target.symbol);
    let thunk = [...this.thunks].find(
      ([, entry]) =>
        entry.kind === undefined &&
        typeof entry.dll === 'string' &&
        typeof entry.name === 'string' &&
        importKey(entry.dll, entry.name) === key,
    )?.[0];
    if (thunk === undefined) {
      thunk = registerThunk(this.thunks, { dll: target.module.name, name: target.symbol });
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
      path: m.path,
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
