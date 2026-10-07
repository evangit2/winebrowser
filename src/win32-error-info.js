// COM transfers one real IErrorInfo reference through the calling thread.
const response = (result, argc) => ({ result: result >>> 0, argc });
const E_INVALIDARG = 0x80070057;
export async function releaseThreadErrorInfo(runtime, thread) {
  const pointer = thread.errorInfo ?? 0;
  thread.errorInfo = 0;
  if (pointer) await runtime.callGuest(runtime.read32(runtime.read32(pointer) + 8), [pointer]);
}
function getErrorInfo(r, a) {
  if (a(0) || !a(1)) return response(E_INVALIDARG, 2);
  r.check(a(1), 4, true);
  const thread = r.threads.current;
  const pointer = thread.errorInfo ?? 0;
  r.write32(a(1), pointer);
  // Ownership transfers to the caller, without another AddRef/Release pair.
  thread.errorInfo = 0;
  return response(pointer ? 0 : 1, 2);
}
async function setErrorInfo(r, a) {
  if (a(0)) return response(E_INVALIDARG, 2);
  const thread = r.threads.current,
    pointer = a(1) >>> 0;
  await releaseThreadErrorInfo(r, thread);
  thread.errorInfo = pointer;
  if (pointer) await r.callGuest(r.read32(r.read32(pointer) + 4), [pointer]);
  return response(0, 2);
}
export const errorInfoApis = {};
for (const dll of ['oleaut32.dll', 'ole32.dll', 'combase.dll']) {
  errorInfoApis[dll + '!GetErrorInfo'] = getErrorInfo;
  errorInfoApis[dll + '!SetErrorInfo'] = setErrorInfo;
}
