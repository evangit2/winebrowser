// Defaults describe the virtual Windows volume, never the host environment.
export const DEFAULT_ENVIRONMENT = Object.freeze([
  '=C:=C:\\',
  'PATH=C:\\',
  'PATHEXT=.COM;.EXE;.BAT;.CMD',
  'SystemRoot=C:\\Windows',
  'WINDIR=C:\\Windows',
  'SystemDrive=C:',
]);

export function environmentEntries(runtime, wide = false) {
  runtime.environment ??= {
    ansi: [...DEFAULT_ENVIRONMENT],
    wide: [...DEFAULT_ENVIRONMENT],
  };
  return runtime.environment[wide ? 'wide' : 'ansi'];
}

export function allocateEnvironmentBlock(runtime, allocate = (size) => runtime.allocate(size)) {
  const value = environmentEntries(runtime, true).join('\0') + '\0\0';
  const address = allocate(value.length * 2);
  for (let i = 0; i < value.length; i++)
    runtime.guestMemory.write(address + i * 2, value.charCodeAt(i), 2);
  return address;
}
