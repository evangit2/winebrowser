export function quoteArgument(value) {
  if (value && !/[\s"]/u.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

export function processCommandLine(runtime) {
  return [runtime.exe, ...runtime.args].map(quoteArgument).join(' ');
}
