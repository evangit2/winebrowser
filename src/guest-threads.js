import { PROCESS_LAYOUT, initializeThreadLayout } from './process-layout.js';
import { SYNC, syncObjects } from './sync-objects.js';

class ThreadStopped extends Error {}
const ALL_ACCESS = 0x1fffff;
export class GuestThreads {
  constructor(runtime) {
    this.r = runtime;
    this.initialContext = runtime.cpu.captureContext();
    this.main = {
      id: 1,
      teb: PROCESS_LAYOUT.teb,
      suspend: 0,
      code: null,
      done: false,
      stop: false,
      depth: 0,
      started: true,
    };
    this.current = this.main;
    this.schedulerNow = () => performance.now();
    this.starvationMilliseconds = 3000;
    this.quantumMilliseconds = 20;
    this.records = new Map([[1, this.main]]);
    this.nextId = 2;
    this.queue = [];
    this.timers = new Set();
    this.fatal = null;
    this.closing = false;
    this.lock = { owner: null, depth: 0, waiters: [] };
  }
  checkRunning(thread = this.current) {
    if (thread?.cleanup) return;
    if (this.fatal) throw this.fatal;
    if (thread?.stop && !thread.detaching) throw new ThreadStopped('Guest thread stopped');
  }
  save(thread) {
    this.accountBoost(thread);
    thread.context = this.r.cpu.captureContext();
    thread.depth = this.r.callDepth;
  }
  activate(thread) {
    this.current = thread;
    this.r.cpu.restoreContext(thread.context);
    this.r.callDepth = thread.depth;
    if (thread.boostQuanta) thread.boostSince = this.schedulerNow();
  }
  pump() {
    if (this.current) return;
    const eligible = this.queue.filter(
      (t) =>
        (!t.suspend || t.stop) &&
        !(
          t === this.main &&
          this.processExitOwner &&
          this.processExitOwner !== t &&
          !this.processExitOwner.done
        ),
    );
    if (!eligible.length) return;
    const next = eligible.reduce((a, b) =>
      this.schedulingPriority(b) > this.schedulingPriority(a) ? b : a,
    );
    // Windows temporarily boosts starved variable-priority threads. Without
    // this, a CPU-bound priority-15 codec worker can prevent the UI thread
    // from ever resuming, even though both are in the ready queue.
    if (this.starved(next)) {
      next.boostQuanta = 2;
      next.boostElapsed = 0;
    }
    next.readySince = undefined;
    const index = this.queue.indexOf(next);
    const [thread] = this.queue.splice(index, 1);
    this.activate(thread);
    const resume = thread.resume;
    thread.resume = null;
    resume();
  }
  ready(thread) {
    if (!this.queue.includes(thread)) {
      thread.readySince = this.schedulerNow();
      this.queue.push(thread);
    }
    this.pump();
  }
  block(promise) {
    if (!promise || typeof promise.then !== 'function') return promise;
    // API contract tests and host callers outside guest execution do not own a
    // suspended x86 stack. Their independent waits must not park the main CPU.
    if (this.current === this.main && !this.r.callDepth && !this.main.cleanup) return promise;
    return this.park(promise);
  }
  async park(promise) {
    const thread = this.current;
    if (!thread) throw Error('Guest wait has no owning thread');
    this.checkRunning(thread);
    let value,
      error,
      settled = false;
    const resumed = new Promise((resolve) => {
      thread.resume = resolve;
    });
    const settle = (result, failure) => {
      if (settled) return;
      settled = true;
      value = result;
      error = failure;
      thread.cancel = null;
      this.ready(thread);
    };
    thread.cancel = () => settle(undefined, new ThreadStopped('Guest thread stopped'));
    Promise.resolve(promise).then(
      (v) => settle(v),
      (e) => settle(undefined, e),
    );
    this.save(thread);
    this.current = null;
    this.pump();
    await resumed;
    this.checkRunning(thread);
    if (error) throw error;
    return value;
  }
  async yield() {
    this.checkRunning();
    this.accountBoost(this.current);
    if (
      this.current.suspend ||
      this.queue.some(
        (t) => !t.suspend && this.schedulingPriority(t) >= this.schedulingPriority(this.current),
      )
    )
      await this.block(Promise.resolve());
  }
  accountBoost(thread) {
    if (!thread.boostQuanta || thread.boostSince === undefined) return;
    const now = this.schedulerNow();
    thread.boostElapsed = (thread.boostElapsed ?? 0) + Math.max(0, now - thread.boostSince);
    while (thread.boostQuanta && thread.boostElapsed >= this.quantumMilliseconds) {
      thread.boostElapsed -= this.quantumMilliseconds;
      thread.boostQuanta--;
    }
    thread.boostSince = thread.boostQuanta ? now : undefined;
  }
  starved(thread) {
    return (
      thread.readySince !== undefined &&
      this.schedulerNow() - thread.readySince >= this.starvationMilliseconds
    );
  }
  schedulingPriority(thread) {
    return thread.boostQuanta || this.starved(thread) ? 15 : this.priority(thread);
  }
  priority(thread) {
    const delta = thread.relativePriority ?? 0;
    return delta === -15 ? 1 : delta === 15 ? 15 : 8 + delta;
  }
  setPriority(handle, delta) {
    const found = this.lookup(handle, 0x20);
    if (found.status) return found.status;
    if (![-15, -2, -1, 0, 1, 2, 15].includes(delta)) return SYNC.INVALID;
    if (found.thread.done) return 0xc000004b;
    found.thread.relativePriority = delta;
    return 0;
  }
  async delay(milliseconds) {
    let timer;
    try {
      await this.block(
        new Promise((resolve) => {
          timer = setTimeout(resolve, milliseconds);
          this.timers.add(timer);
        }),
      );
    } finally {
      clearTimeout(timer);
      this.timers.delete(timer);
    }
  }
  alertObject(thread) {
    if (!thread.alertHandle) {
      const result = syncObjects(this.r).event();
      if (result.status) return result;
      thread.alertHandle = result.handle;
    }
    return { status: 0, handle: thread.alertHandle };
  }
  alert(id) {
    const thread = this.records.get(id);
    if (!thread || thread.done) return 0xc000000b;
    const result = this.alertObject(thread);
    return result.status || syncObjects(this.r).change(result.handle, 'set').status;
  }
  async waitAlert(timeout) {
    const result = this.alertObject(this.current);
    if (result.status) return result.status;
    const status = await this.block(syncObjects(this.r).wait([result.handle], false, timeout));
    return status === 0 ? 0x101 : status;
  }
  async withLoaderLock(work) {
    const thread = this.current,
      lock = this.lock;
    if (lock.owner && lock.owner !== thread)
      await this.block(new Promise((resolve) => lock.waiters.push({ thread, resolve })));
    this.checkRunning(thread);
    lock.owner = thread;
    lock.depth++;
    try {
      return await work();
    } finally {
      if (!--lock.depth) {
        lock.owner = null;
        let waiter;
        while ((waiter = lock.waiters.shift())) {
          if (waiter.thread.stop || waiter.thread.done) continue;
          lock.owner = waiter.thread;
          waiter.resolve();
          break;
        }
      }
    }
  }
  lookup(handle, access = 0) {
    if (handle >>> 0 === 0xfffffffe) return { status: 0, thread: this.current };
    const found = syncObjects(this.r).lookup(handle >>> 0, 'sync-thread', access);
    return found.status ? found : { status: 0, thread: found.object.thread };
  }
  objectFor(thread) {
    return (thread.object ??= {
      kind: 'sync-thread',
      manual: true,
      signaled: thread.done,
      refs: 0,
      thread,
    });
  }
  create({
    start,
    parameter,
    reserve = 0,
    commit = 0,
    suspended = false,
    access = ALL_ACCESS,
    inherit = false,
  }) {
    const r = this.r;
    if (this.closing || this.records.size >= 32) return { status: SYNC.MEMORY };
    if (access & ~ALL_ACCESS) return { status: SYNC.ACCESS };
    if (!r.cpu.ranges.some(([lo, hi]) => start >= lo && start < hi) && !r.thunks.has(start))
      return { status: SYNC.FAULT };
    if (reserve > 4 * 1024 * 1024 || commit > 4 * 1024 * 1024) return { status: SYNC.MEMORY };
    if (r.wineLoader && !r.wineLoader.threadAttachAddress)
      throw Error('Guest Wine threads require the thread-enabled source loader');
    const size =
      Math.ceil(Math.max(reserve || r.pe.stackReserve || 1024 * 1024, commit, 65536) / 4096) * 4096;
    let tebAllocation, stack;
    const object = { kind: 'sync-thread', manual: true, signaled: false, refs: 0 };
    try {
      tebAllocation = r.allocate(0x3000);
      stack = r.allocate(size);
      const teb = Math.ceil(tebAllocation / 4096) * 4096,
        id = this.nextId++;
      const dispatcher = r.graph.modules.get('ntdll.dll')?.ntBridge?.address ?? 0;
      initializeThreadLayout(r, {
        teb,
        peb: PROCESS_LAYOUT.peb,
        stackLimit: stack,
        stackBase: stack + size,
        threadId: id,
        syscallDispatcher: dispatcher,
      });
      const context = structuredClone(this.initialContext);
      context.fsBase = teb;
      context.registers[4] = stack + size - 16;
      const thread = {
        id,
        teb,
        tebAllocation,
        stack,
        start,
        parameter,
        context,
        depth: 0,
        code: null,
        done: false,
        stop: false,
        suspend: Number(suspended),
        object,
      };
      object.thread = thread;
      const opened = syncObjects(r).openHandle(object, access, inherit);
      if (opened.status) {
        r.free(stack);
        r.free(tebAllocation);
        return opened;
      }
      this.records.set(id, thread);
      thread.completion = new Promise((resolve) => {
        thread.complete = resolve;
      });
      thread.resume = () => {
        void this.run(thread);
      };
      this.ready(thread);
      return { ...opened, thread };
    } catch (error) {
      if (stack) r.free(stack);
      if (tebAllocation) r.free(tebAllocation);
      if (error.message === 'Guest heap exhausted') return { status: SYNC.MEMORY };
      throw error;
    }
  }
  async run(thread) {
    const r = this.r;
    try {
      this.checkRunning(thread);
      thread.started = true;
      await this.withLoaderLock(async () => {
        if (r.wineLoader) {
          r.tls.createThread(thread);
          const status = await r.callGuest(r.wineLoader.threadAttachAddress);
          if (status) throw Error(`Wine thread initialization failed: 0x${status.toString(16)}`);
        } else {
          r.tls.createThread(thread);
          for (const module of r.graph.initializationOrder()) {
            if (!module.initialized || module.threadCallsDisabled) continue;
            await r.tls.notifyThread(module, 2);
            if (module.pe.entryPoint) await r.callGuest(module.pe.entryPoint, [module.base, 2, 0]);
          }
          await r.tls.notifyThread(r.graph.main, 2);
        }
        thread.attached = true;
      });
      thread.code = await r.callGuest(thread.start, [thread.parameter]);
      if (r.wineLoader) await r.callGuest(r.wineLoader.threadExitAddress, [thread.code]);
      else if ([...this.records.values()].filter((t) => !t.done).length === 1) {
        r.exitCode = thread.code;
        await r.shutdownProcess();
        this.terminateProcess(thread.code);
      }
    } catch (error) {
      if (!(error instanceof ThreadStopped)) this.fail(error);
    } finally {
      if (!this.closing && !this.fatal && thread.attached && !thread.forcedTermination) {
        thread.detaching = true;
        try {
          await this.withLoaderLock(async () => {
            if (r.wineLoader) {
              if (!thread.nativeDetached) await r.callGuest(r.wineLoader.threadDetachAddress);
            } else {
              for (const module of r.graph.initializationOrder().reverse()) {
                if (!module.initialized || module.threadCallsDisabled) continue;
                await r.tls.notifyThread(module, 3);
                if (module.pe.entryPoint)
                  await r.callGuest(module.pe.entryPoint, [module.base, 3, 0]);
              }
              await r.tls.notifyThread(r.graph.main, 3);
            }
          });
        } catch (error) {
          if (!(error instanceof ThreadStopped)) this.fail(error);
        }
      }
      r.tls.freeThread(thread);
      if (thread.alertHandle) syncObjects(r).close(thread.alertHandle);
      thread.code ??= 0;
      thread.done = true;
      thread.object.signaled = true;
      syncObjects(r).dispatch();
      this.records.delete(thread.id);
      r.free(thread.stack);
      r.free(thread.tebAllocation);
      thread.complete();
      this.current = null;
      this.pump();
    }
  }
  fail(error) {
    this.fatal ??= error;
    for (const thread of this.records.values()) {
      thread.stop = true;
      thread.cancel?.();
    }
  }
  resume(handle) {
    const found = this.lookup(handle, 2);
    if (found.status) return found;
    const thread = found.thread,
      previous = thread.suspend;
    if (thread.done) return { status: 0xc000004b };
    if (thread.suspend) thread.suspend--;
    this.pump();
    return { status: 0, previous };
  }
  suspend(handle) {
    const found = this.lookup(handle, 2);
    if (found.status) return found;
    const thread = found.thread;
    if (thread.done) return { status: 0xc000004b };
    if (thread.suspend >= 127) return { status: 0xc000004a };
    return { status: 0, previous: thread.suspend++ };
  }
  terminate(handle, code) {
    const found = this.lookup(handle || 0xfffffffe, 1);
    if (found.status) return found.status;
    const thread = found.thread;
    if (thread.done || thread.stop) return 0;
    if (thread === this.current) {
      thread.nativeDetached = true;
      this.exit(code);
    }
    // TerminateThread skips DLL_THREAD_DETACH. Resume parked or suspended
    // stacks only to unwind host waits and release their private CPU storage.
    thread.code = code >>> 0;
    thread.forcedTermination = true;
    thread.stop = true;
    thread.cancel?.();
    this.pump();
    return 0;
  }
  exit(code) {
    this.current.code = code >>> 0;
    this.current.stop = true;
    throw new ThreadStopped('Guest thread exited');
  }
  async exitHost(code) {
    if (this.current === this.main) {
      if ([...this.records.values()].filter((t) => !t.done).length === 1) {
        this.r.exitCode = code;
        await this.r.shutdownProcess();
        this.terminateProcess(code);
      } else {
        await this.withLoaderLock(async () => {
          for (const module of this.r.graph.initializationOrder().reverse()) {
            if (!module.initialized || module.threadCallsDisabled) continue;
            await this.r.tls.notifyThread(module, 3);
            if (module.pe.entryPoint)
              await this.r.callGuest(module.pe.entryPoint, [module.base, 3, 0]);
          }
          await this.r.tls.notifyThread(this.r.graph.main, 3);
        });
      }
    }
    this.exit(code);
  }
  isExit(error) {
    return error instanceof ThreadStopped;
  }
  terminateProcess(code) {
    this.r.exitCode = code >>> 0;
    this.closing = true;
    for (const thread of this.records.values()) {
      if (thread === this.current && thread === this.main) continue;
      thread.stop = true;
      thread.cancel?.();
    }
    if (this.current !== this.main) throw new ThreadStopped('Guest process exited');
  }
  async waitForChildren() {
    this.main.done = true;
    if (this.main.object) {
      this.main.object.signaled = true;
      syncObjects(this.r).dispatch();
    }
    this.main.cleanup = true;
    try {
      while (this.records.size > 1)
        try {
          await this.block(
            Promise.race(
              [...this.records.values()].filter((t) => t !== this.main).map((t) => t.completion),
            ),
          );
        } catch (error) {
          if (error instanceof ThreadStopped && this.r.exitCode !== null) return;
          throw error;
        }
    } finally {
      this.main.cleanup = false;
    }
  }
  async stopOthers() {
    const caller = this.current;
    this.closing = true;
    this.processExitOwner ??= caller;
    const pending = [];
    for (const thread of this.records.values()) {
      if (thread === caller || thread.done) continue;
      thread.stop = true;
      thread.cancel?.();
      if (thread === this.main) continue;
      pending.push(thread.completion);
    }
    if (pending.length) {
      // Cancellation must unwind each suspended JS stack while it owns the CPU.
      const cleanup = caller.cleanup;
      caller.cleanup = true;
      try {
        await this.block(Promise.all(pending));
      } finally {
        caller.cleanup = cleanup;
      }
    }
  }
}
