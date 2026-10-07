import { SYNC, SyncDomain, syncObjects } from './sync-objects.js';
import { resolveGuestPath } from './guest-paths.js';
import { PROCESS_LAYOUT } from './process-layout.js';

// A run owns a process family. Each Runtime has a private CPU/address space;
// package files and their dirty set are shared immediately, not copied at fork.
export class ProcessSession {
  constructor(files, createRuntime) {
    this.files = new Map([...files].map(([path, bytes]) => [path, bytes.slice()]));
    this.dirty = new Set();
    this.fileState = { virtualDirectories: new Set(), fileTimes: new Map(), fileIds: new Map() };
    this.syncDomain = new SyncDomain(16 * 4096);
    this.createRuntime = createRuntime;
    this.records = new Map();
    this.nextId = 1;
    this.nextWindow = 0x20000;
    this.error = null;
  }
  resolveImage(image, cwd) {
    let path;
    try {
      path = resolveGuestPath(image, cwd);
    } catch {
      return { status: SYNC.PATH };
    }
    const found = [...this.files.keys()].find((key) => key.toLowerCase() === path.toLowerCase());
    return found ? { status: 0, exe: found } : { status: SYNC.NOT_FOUND };
  }
  create(options, parent = null) {
    if (this.error || this.records.size >= 16) return { status: SYNC.MEMORY };
    const id = this.nextId++;
    let runtime;
    try {
      runtime = this.createRuntime({
        ...options,
        processId: id,
        processSession: this,
        files: this.files,
        sharedFiles: true,
        dirty: this.dirty,
        fileState: this.fileState,
      });
    } catch (error) {
      // Never return successful creation for an image that could not be mapped.
      parent?.emit({ type: 'log', text: `Child image ${options.exe}: ${error.message}` });
      return { status: error.win32Error === 126 ? 0xc0000135 : 0xc000007b };
    }
    let complete;
    const record = {
      id,
      parentId: parent?.processId ?? 0,
      exe: options.exe,
      runtime,
      done: false,
      code: 259,
      result: null,
      started: false,
      completion: new Promise((resolve) => {
        complete = resolve;
      }),
      complete,
      object: { kind: 'sync-process', manual: true, signaled: false, refs: 0 },
      thread: {
        id: (id - 1) * 256 + 1,
        processId: id,
        teb: PROCESS_LAYOUT.teb,
        start: runtime.pe?.entryPoint,
        suspend: options.suspended ? 1 : 0,
        done: false,
        code: null,
      },
    };
    record.object.process = record;
    record.thread.process = record;
    record.thread.object = {
      kind: 'sync-thread',
      manual: true,
      signaled: false,
      refs: 0,
      thread: record.thread,
    };
    this.records.set(id, record);
    runtime.processRecord = record;
    return { status: 0, record };
  }
  handles(
    parent,
    record,
    processAccess,
    threadAccess,
    processInherit = false,
    threadInherit = false,
  ) {
    const objects = syncObjects(parent);
    const process = objects.openHandle(record.object, processAccess, processInherit);
    if (process.status) return process;
    const thread = objects.openHandle(record.thread.object, threadAccess, threadInherit);
    if (thread.status) {
      objects.close(process.handle);
      return thread;
    }
    return { status: 0, process: process.handle, thread: thread.handle };
  }
  start(record) {
    if (record.started || record.done || record.thread.suspend) return;
    record.started = true;
    record.runtime.emit({ type: 'log', text: `Process ${record.id}: ${record.exe}` });
    // Consume rejections here so an exiting parent cannot hide a child fault.
    record.runtime.run().then(
      (result) => this.finish(record, result.exitCode, result),
      (error) => {
        error.process ??= { id: record.id, parentId: record.parentId, exe: record.exe };
        this.error ??= error;
        this.finish(record, 0xc0000001);
        this.stopOthers(record);
      },
    );
  }
  resume(record) {
    if (record.done) return { status: 0xc000004b };
    const previous = record.thread.suspend;
    if (previous) record.thread.suspend--;
    this.start(record);
    return { status: 0, previous };
  }
  finish(record, code, result = null) {
    if (record.done) return;
    Object.assign(record, { done: true, code: code >>> 0, result });
    Object.assign(record.thread, { done: true, code: code >>> 0 });
    record.object.signaled = record.thread.object.signaled = true;
    this.syncDomain.dispatch();
    record.complete();
  }
  terminate(record, code) {
    if (!record.done) {
      if (!record.started) {
        record.runtime.syncObjects?.dispose();
        record.runtime.cpu.dispose();
        record.runtime.windows.dispose();
        this.finish(record, code);
      } else {
        record.runtime.nativeProcessTerminated = true;
        record.runtime.exitCode = code >>> 0;
        record.runtime.threads.closing = true;
        for (const thread of record.runtime.threads.records.values()) {
          thread.stop = true;
          thread.cancel?.();
        }
      }
    }
    return 0;
  }
  stopOthers(except) {
    for (const record of this.records.values()) {
      if (record === except || record.done) continue;
      if (!record.started) this.terminate(record, 0xc0000120);
      else record.runtime.threads.fail(this.error ?? Error('Process session stopped'));
    }
  }
  async run(root) {
    const started = performance.now();
    this.start(root);
    // Children may add grandchildren while the current batch is running.
    while ([...this.records.values()].some((r) => !r.done))
      await Promise.all([...this.records.values()].filter((r) => !r.done).map((r) => r.completion));
    if (this.error) throw this.error;
    const results = [...this.records.values()].filter((r) => r.result);
    const aggregate = {
      ...root.result,
      processes: [...this.records.values()].map((r) => ({
        id: r.id,
        parentId: r.parentId,
        exe: r.exe,
        ...(r.result ?? { exitCode: r.code, terminatedBeforeEntry: true }),
        outputs: undefined,
        deletedFiles: undefined,
      })),
    };
    for (const key of [
      'blocks',
      'instructions',
      'compiledBlocks',
      'totalCompiledBlocks',
      'x86TranslationMs',
      'wasmBytes',
      'apiCalls',
    ])
      aggregate[key] = results.reduce((total, r) => total + (r.result[key] ?? 0), 0);
    aggregate.elapsedMs = performance.now() - started;
    aggregate.outputs = [...this.dirty]
      .filter((p) => this.files.has(p))
      .map((path) => ({ path, bytes: this.files.get(path) }));
    aggregate.deletedFiles = [...this.dirty].filter((p) => !this.files.has(p));
    return aggregate;
  }
  input(event) {
    for (const record of this.records.values()) {
      if (!record.done && record.runtime.windows.windows.has(event.windowId)) {
        record.runtime.windows.input(event);
        return;
      }
    }
  }
}

export function processLookup(runtime, handle, access = 0) {
  if (handle >>> 0 === 0xffffffff)
    return {
      status: 0,
      process: runtime.processRecord ?? {
        id: runtime.processId ?? 1,
        parentId: 0,
        runtime,
        done: false,
        code: 259,
      },
    };
  const found = syncObjects(runtime).lookup(handle >>> 0, 'sync-process', access);
  return found.status ? found : { status: 0, process: found.object.process };
}
