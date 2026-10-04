import { activeGdiDC } from './win32-gdi.js';

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

// PE32 packed PRINTDLG is 66 bytes; PAGESETUPDLG is 84. Layouts and
// printerless contracts checked against Wine db11d0fe6a169c457e23d007e20404643d067aa8
// dlls/comdlg32/printdlg.c and dlls/win32u/driver.c. This provider has no
// printer DCs, spool output or positive StartDoc job ids.
function dialogFailure(r, code) {
  r.commonDialogError = code;
  return result(0, 1);
}
async function printerWarning(r, owner, title, message, icon = 0x30) {
  const text = r.allocString(message),
    caption = r.allocString(title);
  try {
    await r.apiProvider.get('user32.dll!MessageBoxA')(r, (i) => [owner, text, caption, icon][i]);
  } finally {
    r.free(text);
    r.free(caption);
  }
}
async function printDialog(r, a) {
  r.commonDialogError = 0;
  const p = a(0);
  if (!p) return dialogFailure(r, 2); // CDERR_INITIALIZATION
  r.check(p, 4);
  if (r.read32(p) !== 66) return dialogFailure(r, 1); // CDERR_STRUCTSIZE
  r.check(p, 66);
  const flags = r.read32(p + 20);
  if (flags & 0x400) {
    // PD_RETURNDEFAULT never displays a dialog.
    if (r.read32(p + 8) || r.read32(p + 12)) return dialogFailure(r, 0x1003);
    return dialogFailure(r, 0x1008); // PDERR_NODEFAULTPRN
  }
  // Wine's interactive zero-queue path warns, then closes the dialog with
  // FALSE and no extended error. This is an actual notice, not silent cancel.
  await printerWarning(r, r.read32(p + 4), 'Print', 'No Windows printers are installed.');
  return dialogFailure(r, 0);
}
async function pageSetupDialog(r, a) {
  r.commonDialogError = 0;
  const p = a(0);
  if (!p) return dialogFailure(r, 2);
  r.check(p, 4);
  if (r.read32(p) !== 84) return dialogFailure(r, 1);
  r.check(p, 84, true);
  let flags = r.read32(p + 16);
  if (flags & 0x40000 && !r.read32(p + 72)) return dialogFailure(r, 0xb); // CDERR_NOHOOK
  if (!(flags & 0xc)) r.write32(p + 16, (flags |= 4)); // Runtime's en-US measurement units.
  const code = r.read32(p + 8) && r.read32(p + 12) ? 0x100b : 0x1008;
  if (!(flags & 0x80))
    await printerWarning(
      r,
      r.read32(p + 4),
      'Page Setup',
      'No default Windows printer is installed.',
      0x10,
    );
  return dialogFailure(r, code);
}
async function startDoc(r, a, wide) {
  const p = a(1);
  if (p) {
    r.check(p, 20);
    for (const offset of [4, 8, 12]) {
      const value = r.read32(p + offset);
      if (value) wide ? r.wideString(value) : r.string(value);
    }
  }
  const dc = activeGdiDC(r, a(0));
  if (!dc) return result(-1, 2);
  if (dc.abortProc) await r.callGuest(dc.abortProc, [a(0), 0]);
  // Display/bitmap DCs have Wine's null-driver contract. No job was started,
  // irrespective of the callback's result; positive job ids are never faked.
  return result(0, 2);
}
Object.assign(printerApis, {
  'comdlg32.dll!PrintDlgA': printDialog,
  'comdlg32.dll!PrintDlgW': printDialog,
  'comdlg32.dll!PageSetupDlgA': pageSetupDialog,
  'comdlg32.dll!PageSetupDlgW': pageSetupDialog,
  'gdi32.dll!StartDocA': (r, a) => startDoc(r, a, false),
  'gdi32.dll!StartDocW': (r, a) => startDoc(r, a, true),
  'gdi32.dll!SetAbortProc': (r, a) => {
    const dc = activeGdiDC(r, a(0));
    if (!dc) return result(0, 2);
    dc.abortProc = a(1) >>> 0;
    return result(1, 2);
  },
  'gdi32.dll!StartPage': (r, a) => result(activeGdiDC(r, a(0)) ? 1 : -1, 1),
  'gdi32.dll!EndPage': (r, a) => result(activeGdiDC(r, a(0)) ? 0 : -1, 1),
  'gdi32.dll!EndDoc': (r, a) => result(activeGdiDC(r, a(0)) ? 0 : -1, 1),
  'gdi32.dll!AbortDoc': (r, a) => result(activeGdiDC(r, a(0)) ? 0 : -1, 1),
});
