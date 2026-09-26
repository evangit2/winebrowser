import { ComObjects } from './com.js';

// ID3DBlob owns a copy of compiler output independently of its compiler/module.
export function createBlob(runtime, bytes) {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 1024 * 1024)
    throw Error('Invalid ID3DBlob size');
  runtime.comObjects ??= new ComObjects(runtime);
  const pointer = runtime.allocate(bytes.length);
  runtime.data.set(bytes, pointer);
  try {
    return runtime.comObjects.create({
      name: 'ID3DBlob',
      iid: '8ba5fb08-5195-40e2-ac58-0d989c3a0102',
      methodNames: ['QueryInterface', 'AddRef', 'Release', 'GetBufferPointer', 'GetBufferSize'],
      methods: {
        3: { argc: 1, invoke: () => pointer },
        4: { argc: 1, invoke: () => bytes.length },
      },
      onRelease: () => runtime.free(pointer),
    });
  } catch (error) {
    runtime.free(pointer);
    throw error;
  }
}
