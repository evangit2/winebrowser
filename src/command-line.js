export function quoteArgument(value) {
  if (value && !/[\s"]/u.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

export function processCommandLine(runtime) {
  return [runtime.exe, ...runtime.args].map(quoteArgument).join(' ');
}

// The process argument vector with argv[0] naming the executable, which is what
// a C runtime hands main(). An isolated process always has at least one entry.
export function processArguments(runtime) {
  return [runtime.exe, ...runtime.args];
}
