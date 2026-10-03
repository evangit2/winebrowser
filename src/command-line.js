export function quoteArgument(value) {
  if (value && !/[\s"]/u.test(value)) return value;
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
}

export function processCommandLine(runtime) {
  return runtime.commandLine ?? [runtime.exe, ...runtime.args].map(quoteArgument).join(' ');
}

// The process argument vector with argv[0] naming the executable, which is what
// a C runtime hands main(). An isolated process always has at least one entry.
export function processArguments(runtime) {
  return [runtime.argv0 ?? runtime.exe, ...runtime.args];
}

// Windows CRT quoting: backslashes are literal except immediately before a
// quote, where pairs become backslashes and an odd remainder escapes the quote.
export function parseCommandLine(value) {
  const args = [];
  let i = 0;
  while (i < value.length) {
    while (/\s/u.test(value[i] ?? '') && i < value.length) i++;
    if (i === value.length) break;
    let arg = '',
      quoted = false;
    while (i < value.length && (quoted || !/\s/u.test(value[i]))) {
      let slashes = 0;
      while (value[i] === '\\') {
        slashes++;
        i++;
      }
      if (value[i] === '"') {
        arg += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) arg += '"';
        else if (quoted && value[i + 1] === '"') {
          arg += '"';
          i++;
        } else quoted = !quoted;
        i++;
      } else {
        arg += '\\'.repeat(slashes);
        if (i < value.length && (quoted || !/\s/u.test(value[i]))) arg += value[i++];
      }
    }
    args.push(arg);
  }
  return args;
}
