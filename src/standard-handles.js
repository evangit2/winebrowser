// Standard output handles and their duplicated aliases have independent
// lifetimes. Each alias still writes to the same browser output stream.
export function standardOutputId(runtime, handle) {
  handle >>>= 0;
  if (handle === 1 || handle === 2) return runtime.closedStandardOutputs?.has(handle) ? 0 : handle;
  const opened = runtime.handles.get(handle);
  return opened?.kind === 'standard-output' ? opened.stream : 0;
}
