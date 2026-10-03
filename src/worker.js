import { unpackFiles } from './import-files.js';
import wineLibrary from '../runtime/wine/manifest.json';
import wineFormat from '../runtime/wine-format/manifest.json';
import { inspect, Runtime } from './runtime.js';
import { createCanvasTextRasterizer } from './gdi-text.js';
import { WebGPURenderer } from './webgpu-renderer.js';
import { D3D12Renderer } from './d3d12-renderer.js';
import { OpenGLRenderer } from './opengl-renderer.js';
import { loadWineBaseAssets, packageNeedsNativeBase } from './wine-base-assets.js';
import { ProcessSession } from './process-session.js';
import {
  packageId,
  packageFilesId,
  savePackage,
  savePackageFiles,
  saveOutputs,
} from './storage.js';
let pkg,
  activeSession,
  id,
  iced,
  builtinFiles = new Map(),
  nativeBase,
  executableProfiles = new Map(),
  pending = new Map(),
  seq = 0,
  busy = false;
const emit = (message) => postMessage(message, message.bitmap ? [message.bitmap] : []);
const request = (kind, detail) =>
  new Promise((resolve) => {
    const token = ++seq;
    pending.set(token, resolve);
    emit({ type: 'request', kind, token, ...detail });
  });
onmessage = async ({ data }) => {
  if (data.type === 'input') {
    if (data.event && typeof data.event.type === 'string') activeSession?.input(data.event);
    return;
  }
  if (data.type === 'reply') {
    pending.get(data.token)?.(data.value);
    pending.delete(data.token);
    return;
  }
  if (busy) return;
  busy = true;
  try {
    if (data.type === 'load') {
      const started = performance.now();
      pkg = await unpackFiles(data.inputs);
      if (!builtinFiles.size) {
        const components = new Map();
        for (const [name, manifest] of [
          ['shell32.dll', wineLibrary],
          ['wine-format.dll', wineFormat],
        ]) {
          const response = await fetch(`${import.meta.env.BASE_URL}runtime/${name}`);
          if (!response.ok) throw Error(`Wine component unavailable: ${name}`);
          const dll = new Uint8Array(await response.arrayBuffer());
          if ((await packageId(dll)) !== manifest.dllSha256)
            throw Error(`Wine component hash mismatch: ${name}`);
          components.set(name, dll);
        }
        builtinFiles = components;
      }
      id = pkg.original ? await packageId(pkg.original) : await packageFilesId(pkg.files);
      try {
        if (pkg.original) await savePackage(id, pkg.original);
        else await savePackageFiles(id, pkg.files);
      } catch (e) {
        emit({ type: 'log', text: 'Package cache unavailable: ' + e.message });
      }
      const inspectExecutable = (path, components) => {
        try {
          return { path, pe: inspect(pkg.files.get(path), pkg.files, path, components) };
        } catch (e) {
          return { path, error: e.message };
        }
      };
      executableProfiles = new Map();
      const dynamicNativeBase = packageNeedsNativeBase(pkg.files);
      const executables = [];
      for (const path of pkg.executables) {
        let entry = inspectExecutable(path, builtinFiles);
        if (
          dynamicNativeBase ||
          /^Missing DLL /.test(entry.error ?? '') ||
          entry.pe?.unsupported.length
        ) {
          nativeBase ??= await loadWineBaseAssets(import.meta.env.BASE_URL);
          const components = new Map([...builtinFiles, ...nativeBase.builtinFiles]);
          const nativeEntry = inspectExecutable(path, components);
          if (
            !nativeEntry.error &&
            ((dynamicNativeBase && !nativeEntry.pe.unsupported.length) ||
              !entry.pe ||
              nativeEntry.pe.unsupported.length < entry.pe.unsupported.length)
          ) {
            entry = { ...nativeEntry, wineBase: true };
            executableProfiles.set(path, components);
          }
        }
        executables.push(entry);
      }
      delete pkg.original;
      emit({
        type: 'loaded',
        id,
        executables,
        files: pkg.files.size,
        loadMs: performance.now() - started,
      });
    } else if (data.type === 'run') {
      if (!pkg?.executables.includes(data.exe))
        throw Error('Select an executable from the loaded package');
      if (!iced) {
        emit({ type: 'log', text: 'Loading x86 decoder…' });
        // Vite adds ?import to relative dynamic URLs in dev, but public/
        // assets must be loaded directly. Keep iced's own import.meta.url at
        // /vendor/iced.js so its adjacent WASM resolves in dev and Pages.
        const url = new URL(`${import.meta.env.BASE_URL}vendor/iced.js`, self.location.origin).href;
        iced = await (await import(/* @vite-ignore */ url)).init();
      }
      const resources = [];
      const session = new ProcessSession(pkg.files, (options) => {
        const graphics = new WebGPURenderer({ emit, forceReadback: data.forceReadback === true });
        const graphics12 = new D3D12Renderer(graphics);
        const opengl = new OpenGLRenderer({ emit });
        resources.push({ graphics, graphics12, opengl });
        const runtime = new Runtime(iced, {
          ...options,
          builtinFiles: executableProfiles.get(options.exe) ?? builtinFiles,
          nlsFiles: executableProfiles.has(options.exe) ? nativeBase.nlsFiles : undefined,
          graphics,
          graphics12,
          opengl,
          emit,
          request,
          // Manual sessions last until the guest exits or the user presses Stop.
          // The dispatcher still yields, and memory/block-cache limits still apply.
          maxBlocks: data.interactive ? Infinity : 1_000_000,
        });
        runtime.gdiTextRasterizer = createCanvasTextRasterizer();
        resources.at(-1).runtime = runtime;
        return runtime;
      });
      activeSession = session;
      let result;
      try {
        const root = session.create({ exe: data.exe, args: data.args ?? [] });
        if (root.status) throw Error(`Cannot create process: 0x${root.status.toString(16)}`);
        result = await session.run(root.record);
      } finally {
        activeSession = null;
        for (const { runtime, graphics12, graphics, opengl } of resources) {
          runtime?.vulkan?.dispose();
          graphics12.dispose();
          graphics.dispose();
          opengl.dispose();
        }
      }
      try {
        await saveOutputs(id, result.outputs, result.deletedFiles);
      } catch (e) {
        emit({ type: 'log', text: 'Output persistence unavailable: ' + e.message });
      }
      emit({ type: 'done', ...result });
    }
  } catch (e) {
    // A guest fault that no handler accepted stops the run. The runtime keeps
    // the location and the guest call stack on the error, which is what makes
    // the stop reproducible instead of just a bare address.
    emit({
      type: 'error',
      text: e.message,
      ...(e.process ? { process: e.process } : {}),
      ...(e.guestDiagnostic ? { diagnostic: e.guestDiagnostic } : {}),
    });
  } finally {
    busy = false;
  }
};
