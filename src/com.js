// PE32 COM objects are guest pointers to vtables of stdcall thunks. The host
// owns their lifetime; a released pointer stays reserved so stale calls fail.
import { registerThunk } from './thunk-addresses.js';
const E_NOINTERFACE = 0x80004002;
const E_POINTER = 0x80004003;
const IUNKNOWN = '00000000-0000-0000-c000-000000000046';

function guid(runtime, address) {
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

export class ComObjects {
  constructor(runtime) {
    this.runtime = runtime;
    this.objects = new Map();
  }

  create({ name, iid, methodNames, methods = {}, onRelease, state = {} }) {
    if (this.objects.size >= 64) throw Error('COM object limit exceeded');
    if (methodNames.length < 3 || methodNames.length > 128)
      throw Error(`Invalid ${name} vtable size`);
    const runtime = this.runtime;
    const vtable = runtime.allocate(methodNames.length * 4);
    const pointer = runtime.allocate(4);
    runtime.write32(pointer, vtable);
    const object = { name, iid: iid.toLowerCase(), pointer, vtable, refs: 1, state, onRelease };
    this.objects.set(pointer, object);
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
            const requested = guid(runtime, argument(1) >>> 0);
            if (requested !== IUNKNOWN && requested !== object.iid) {
              runtime.write32(out, 0);
              return { result: E_NOINTERFACE, argc: 3 };
            }
            if (object.refs >= 0x7fffffff) throw Error(`${name} reference count limit exceeded`);
            object.refs++;
            runtime.write32(out, pointer);
            return { result: 0, argc: 3 };
          }
          if (slot === 1) {
            if (object.refs >= 0x7fffffff) throw Error(`${name} reference count limit exceeded`);
            return { result: ++object.refs, argc: 1 };
          }
          if (slot === 2) {
            const refs = --object.refs;
            if (!refs) await object.onRelease?.(object);
            return { result: refs, argc: 1 };
          }
          const method = methods[slot];
          if (!method) throw Error(`Unsupported COM method ${name}.${methodName}`);
          return { result: await method.invoke(runtime, argument, object), argc: method.argc };
        },
      });
      runtime.write32(vtable + slot * 4, address);
    }
    return object;
  }
}
