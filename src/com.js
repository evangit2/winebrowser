// PE32 COM objects are guest pointers to vtables of stdcall thunks. The host
// owns their lifetime; a released pointer stays reserved so stale calls fail.
import { registerThunk } from './thunk-addresses.js';
const E_NOINTERFACE = 0x80004002;
const E_POINTER = 0x80004003;
const IUNKNOWN = '00000000-0000-0000-c000-000000000046';

export function readGuid(runtime, address) {
  runtime.check(address, 16);
  const bytes = runtime.data;
  const hex = (start, count) =>
    Array.from(bytes.subarray(address + start, address + start + count), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
  return (
    [hex(3, 1), hex(2, 1), hex(1, 1), hex(0, 1)].join('') +
    '-' +
    [hex(5, 1), hex(4, 1)].join('') +
    '-' +
    [hex(7, 1), hex(6, 1)].join('') +
    '-' +
    hex(8, 2) +
    '-' +
    hex(10, 6)
  );
}

// Upper bound on simultaneously live COM objects. Released pointers stay
// reserved in `objects` so stale guest calls keep failing, so capacity is
// tracked separately from the map size.
const MAX_LIVE_OBJECTS = 4096;

export class ComObjects {
  constructor(runtime) {
    this.runtime = runtime;
    this.objects = new Map();
    this.liveObjects = 0;
  }

  create({
    name,
    iid,
    iids = [],
    methodNames,
    methods = {},
    onRelease,
    state = {},
    queryInterface,
  }) {
    if (this.liveObjects >= MAX_LIVE_OBJECTS) throw Error('COM object limit exceeded');
    if (methodNames.length < 3 || methodNames.length > 128)
      throw Error(`Invalid ${name} vtable size`);
    const runtime = this.runtime;
    const vtable = runtime.allocate(methodNames.length * 4);
    const pointer = runtime.allocate(4);
    runtime.write32(pointer, vtable);
    const object = {
      name,
      iid: iid.toLowerCase(),
      iids: new Set([iid.toLowerCase(), ...iids.map((value) => value.toLowerCase())]),
      pointer,
      vtable,
      refs: 1,
      state,
      onRelease,
    };
    this.objects.set(pointer, object);
    this.liveObjects++;
    for (const [slot, methodName] of methodNames.entries()) {
      const address = registerThunk(runtime.thunks, {
        kind: 'com',
        name: `${name}.${methodName}`,
        invoke: async (calledRuntime, argument) => {
          if (calledRuntime !== runtime) throw Error('COM thunk belongs to another runtime');
          if (argument(0) >>> 0 !== pointer) throw Error(`Invalid ${name} this pointer`);
          if (!object.refs) throw Error(`Released COM object ${name}`);
          if (slot === 0) {
            const out = argument(2) >>> 0;
            if (!out) return { result: E_POINTER, argc: 3 };
            runtime.check(out, 4, true);
            const requested = readGuid(runtime, argument(1) >>> 0);
            // A diagnostic switch records which identity each object was asked
            // for. A request no interface can satisfy is usually a caller that
            // passed the wrong argument, which the identity alone shows.
            if (runtime.queryTrace) {
              const stack = runtime.cpu.r[4].value >>> 0;
              runtime.queryTrace.push({
                name,
                pointer: '0x' + (object.pointer >>> 0).toString(16),
                requested,
                // The argument words and the caller's return address say
                // whether the request is well formed: an identity read from a
                // stack slot that holds a float is a caller whose argument
                // count disagrees with the vtable, not a missing interface.
                caller: '0x' + (runtime.read32(stack) >>> 0).toString(16),
                args: [1, 2, 3].map(
                  (i) => '0x' + (runtime.read32(stack + i * 4) >>> 0).toString(16),
                ),
              });
              if (runtime.queryTrace.length > 64) runtime.queryTrace.shift();
            }
            const target = queryInterface
              ? queryInterface(requested, object)
              : requested === IUNKNOWN || object.iids.has(requested)
                ? object
                : null;
            if (!target) {
              runtime.write32(out, 0);
              return { result: E_NOINTERFACE, argc: 3 };
            }
            if (this.objects.get(target.pointer) !== target || !target.refs)
              throw Error(`Invalid ${name} interface target`);
            if (target.refs >= 0x7fffffff) throw Error(`${name} reference count limit exceeded`);
            target.refs++;
            runtime.write32(out, target.pointer);
            return { result: 0, argc: 3 };
          }
          if (slot === 1) {
            if (object.refs >= 0x7fffffff) throw Error(`${name} reference count limit exceeded`);
            return { result: ++object.refs, argc: 1 };
          }
          if (slot === 2) {
            const refs = --object.refs;
            if (!refs) {
              this.liveObjects--;
              await object.onRelease?.(object);
            }
            return { result: refs, argc: 1 };
          }
          const method = methods[slot];
          if (!method) throw Error(`Unsupported COM method ${name}.${methodName}`);
          const response = await method.invoke(runtime, argument, object);
          return typeof response === 'object' && response !== null
            ? { ...response, argc: method.argc }
            : { result: response, argc: method.argc };
        },
      });
      runtime.write32(vtable + slot * 4, address);
    }
    return object;
  }
}
