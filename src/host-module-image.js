// A real, relocatable PE32 view of a browser-provided DLL. Programs and native
// loaders may inspect its headers and exports just like any mapped DLL. Each
// export tail-calls a host thunk without disturbing the caller's registers,
// flags, return address, or arguments. There is no guest-specific code here.
export function hostModuleImage(name, symbols, thunkAddress) {
  const align = (value, boundary) => Math.ceil(value / boundary) * boundary;
  const ascii = (value) => {
    if (!value || /[^\x01-\x7f]/.test(value)) throw Error('Invalid host export name');
    return new TextEncoder().encode(value + '\0');
  };
  const entries = [...new Set(symbols)].map((symbol) => ({ symbol }));
  const occupied = new Set();
  for (const entry of entries) {
    if (!entry.symbol.startsWith('#')) continue;
    const ordinal = Number(entry.symbol.slice(1));
    if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 65535)
      throw Error('Invalid host export ordinal');
    entry.ordinal = ordinal;
    occupied.add(ordinal);
  }
  let ordinal = 1;
  for (const entry of entries) {
    if (entry.ordinal) continue;
    while (occupied.has(ordinal)) ordinal++;
    if (ordinal > 65535) throw Error('Host export table exhausted');
    entry.ordinal = ordinal;
    occupied.add(ordinal++);
    entry.nameBytes = ascii(entry.symbol);
  }
  const named = entries
    .filter((e) => e.nameBytes)
    .sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  const functions = Math.max(1, ...occupied);
  const dllName = ascii(name);
  const codeSize = Math.max(1, entries.length * 8);
  const textRva = 0x1000,
    exportsRva = align(textRva + codeSize, 0x1000);
  const exportSize =
    40 +
    functions * 4 +
    named.length * 6 +
    dllName.length +
    named.reduce((n, e) => n + e.nameBytes.length, 0);
  const relocRva = align(exportsRva + exportSize, 0x1000);
  const textRaw = 0x200,
    exportRaw = textRaw + align(codeSize, 0x200);
  const relocRaw = exportRaw + align(exportSize, 0x200);
  const bytes = new Uint8Array(relocRaw + 0x200);
  const view = new DataView(bytes.buffer);
  const u16 = (offset, value) => view.setUint16(offset, value, true);
  const u32 = (offset, value) => view.setUint32(offset, value, true);
  u16(0, 0x5a4d);
  u32(0x3c, 0x80);
  u32(0x80, 0x4550);
  u16(0x84, 0x14c);
  u16(0x86, 3);
  u16(0x94, 224);
  u16(0x96, 0x2102);
  const opt = 0x98;
  u16(opt, 0x10b);
  u32(opt + 4, align(codeSize, 0x200));
  u32(opt + 8, bytes.length - exportRaw);
  u32(opt + 20, textRva);
  u32(opt + 24, exportsRva);
  u32(opt + 28, 0x10000000);
  u32(opt + 32, 0x1000);
  u32(opt + 36, 0x200);
  u16(opt + 40, 4);
  u16(opt + 48, 4);
  u32(opt + 56, relocRva + 0x1000);
  u32(opt + 60, 0x200);
  u16(opt + 68, 3);
  u16(opt + 70, 0x140);
  u32(opt + 72, 0x100000);
  u32(opt + 76, 0x1000);
  u32(opt + 80, 0x100000);
  u32(opt + 84, 0x1000);
  u32(opt + 92, 16);
  u32(opt + 96, exportsRva);
  u32(opt + 100, exportSize);
  u32(opt + 136, relocRva);
  u32(opt + 140, 12);
  const sections = [
    ['.text', codeSize, textRva, textRaw, 0x60000020],
    ['.edata', exportSize, exportsRva, exportRaw, 0x40000040],
    ['.reloc', 12, relocRva, relocRaw, 0x42000040],
  ];
  sections.forEach(([label, size, rva, raw, flags], i) => {
    const p = opt + 224 + i * 40;
    bytes.set(ascii(label), p);
    u32(p + 8, size);
    u32(p + 12, rva);
    u32(p + 16, align(size, 0x200));
    u32(p + 20, raw);
    u32(p + 36, flags);
  });
  const eat = 40,
    names = eat + functions * 4,
    ordinals = names + named.length * 4;
  let strings = ordinals + named.length * 2;
  u32(exportRaw + 12, exportsRva + strings);
  bytes.set(dllName, exportRaw + strings);
  strings += dllName.length;
  u32(exportRaw + 16, 1);
  u32(exportRaw + 20, functions);
  u32(exportRaw + 24, named.length);
  u32(exportRaw + 28, exportsRva + eat);
  u32(exportRaw + 32, exportsRva + names);
  u32(exportRaw + 36, exportsRva + ordinals);
  const rvas = new Map();
  entries.forEach((entry, i) => {
    const rva = textRva + i * 8,
      raw = textRaw + i * 8;
    bytes[raw] = 0x68;
    u32(raw + 1, thunkAddress(entry.symbol));
    bytes[raw + 5] = 0xc3;
    u32(exportRaw + eat + (entry.ordinal - 1) * 4, rva);
    rvas.set(entry.symbol, rva);
  });
  named.forEach((entry, i) => {
    u32(exportRaw + names + i * 4, exportsRva + strings);
    u16(exportRaw + ordinals + i * 2, entry.ordinal - 1);
    bytes.set(entry.nameBytes, exportRaw + strings);
    strings += entry.nameBytes.length;
  });
  // ABSOLUTE relocation padding: all internal references are RVAs and host
  // thunk addresses are absolute outside guest image space.
  u32(relocRaw, textRva);
  u32(relocRaw + 4, 12);
  return { bytes, rvas };
}
