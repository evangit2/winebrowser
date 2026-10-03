// The browser runtime has no installed Windows printer queues. Enumerating
// local/connected queues is a genuine empty result; submitting print jobs and
// accessing remote print servers are not implemented by this provider.
const result = (value, argc) => ({ result: value >>> 0, argc });
function fail(r, error, argc) {
  r.lastError = error;
  return result(0, argc);
}
function enumPrinters(r, a, wide) {
  const flags = a(0),
    name = a(1),
    level = a(2),
    buffer = a(3),
    bytes = a(4),
    needed = a(5),
    returned = a(6);
  if (!needed || !returned || (bytes && !buffer)) return fail(r, 87, 7);
  r.check(needed, 4, true);
  r.check(returned, 4, true);
  if (![1, 2, 4, 5].includes(level)) return fail(r, 124, 7);
  if (flags & ~7) return fail(r, 1004, 7);
  if (name && (wide ? r.wideString(name) : r.string(name))) return fail(r, 123, 7);
  if (bytes) r.check(buffer, bytes, true);
  r.write32(needed, 0);
  r.write32(returned, 0);
  return result(1, 7);
}
function defaultPrinter(r, a) {
  const size = a(1);
  if (!size) return fail(r, 87, 2);
  r.check(size, 4, true);
  r.write32(size, 0);
  return fail(r, 2, 2);
}
function openPrinter(r, a, wide) {
  const out = a(1);
  if (!out) return fail(r, 87, 3);
  r.check(out, 4, true);
  r.write32(out, 0);
  if (a(0)) wide ? r.wideString(a(0)) : r.string(a(0));
  return fail(r, 1801, 3);
}
export const printerApis = {
  'winspool.drv!EnumPrintersA': (r, a) => enumPrinters(r, a, false),
  'winspool.drv!EnumPrintersW': (r, a) => enumPrinters(r, a, true),
  'winspool.drv!GetDefaultPrinterA': defaultPrinter,
  'winspool.drv!GetDefaultPrinterW': defaultPrinter,
  'winspool.drv!OpenPrinterA': (r, a) => openPrinter(r, a, false),
  'winspool.drv!OpenPrinterW': (r, a) => openPrinter(r, a, true),
  'winspool.drv!ClosePrinter': (r) => fail(r, 6, 1),
};
