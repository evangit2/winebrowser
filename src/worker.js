import { unpackPackage } from './package.js';
import wineLibrary from '../runtime/wine/manifest.json';
import { inspect, Runtime } from './runtime.js';
import { packageId, savePackage, saveOutputs } from './storage.js';
let pkg,
  id,
  iced,
  builtinFiles = new Map(),
  pending = new Map(),
  seq = 0,
  busy = false;
const emit = (message) => postMessage(message);
const request = (kind, detail) =>
  new Promise((resolve) => {
    const token = ++seq;
    pending.set(token, resolve);
    emit({ type: 'request', kind, token, ...detail });
  });
onmessage = async ({ data }) => {
  if (data.type === 'reply') {
    pending.get(data.token)?.(data.value);
    pending.delete(data.token);
    return;
  }
  if (busy) return;
  busy = true;
  try {
    if (data.type === 'load') {
      const bytes = new Uint8Array(data.bytes);
      pkg = await unpackPackage(bytes, data.name);
      if (!builtinFiles.size) {
        const response = await fetch('/runtime/shell32.dll');
        if (!response.ok) throw Error('Wine helper unavailable');
        const dll = new Uint8Array(await response.arrayBuffer());
        if ((await packageId(dll)) !== wineLibrary.dllSha256)
          throw Error('Wine helper hash mismatch');
        builtinFiles.set('shell32.dll', dll);
      }
      id = await packageId(bytes);
      try {
        await savePackage(id, bytes);
      } catch (e) {
        emit({ type: 'log', text: 'Package cache unavailable: ' + e.message });
      }
      const executables = pkg.executables.map((path) => {
        try {
          return { path, pe: inspect(pkg.files.get(path), pkg.files, path, builtinFiles) };
        } catch (e) {
          return { path, error: e.message };
        }
      });
      emit({ type: 'loaded', id, executables, files: pkg.files.size });
    } else if (data.type === 'run') {
      if (!pkg?.executables.includes(data.exe))
        throw Error('Select an executable from the loaded package');
      if (!iced) {
        emit({ type: 'log', text: 'Loading x86 decoder…' });
        const url = '/vendor/iced.js';
        iced = await (await import(/* @vite-ignore */ url)).init();
      }
      const runtime = new Runtime(iced, {
        files: pkg.files,
        exe: data.exe,
        args: data.args ?? [],
        builtinFiles,
        emit,
        request,
      });
      const result = await runtime.run();
      try {
        await saveOutputs(id, result.outputs);
      } catch (e) {
        emit({ type: 'log', text: 'Output persistence unavailable: ' + e.message });
      }
      emit({ type: 'done', ...result });
    }
  } catch (e) {
    emit({ type: 'error', text: e.message });
  } finally {
    busy = false;
  }
};
