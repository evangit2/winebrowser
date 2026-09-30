// Input-method (imm32) and common-dialog (comdlg32) services.
//
// The browser desktop has no IME bridge, so an IME context is a real per-window
// object that reports an empty composition and accepts the font/window calls a
// program makes while setting one up. The common file and font dialogs cannot
// open a native picker inside the sandbox, so each validates the caller's
// structure and reports the documented "the user cancelled" outcome, which is a
// legal result the application already handles.

const ok = (result = 0, argc = 0) => ({ result: result >>> 0, argc });
const fail = (r, error, argc = 0, value = 0) => {
  r.lastError = error;
  return ok(value, argc);
};
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_WINDOW_HANDLE = 1400;

function imeState(r) {
  r.ime ??= { nextContext: 0x71000000, byWindow: new Map() };
  return r.ime;
}

// ImmGetContext(hwnd) returns the IME context for a window, creating one on
// first use. The context is per-window, which is what the API guarantees.
function immGetContext(r, a) {
  const window = r.windows.windows.get(a(0));
  if (!window) return fail(r, ERROR_INVALID_WINDOW_HANDLE, 1);
  const state = imeState(r);
  let context = state.byWindow.get(a(0) >>> 0);
  if (!context) {
    context = state.nextContext++;
    state.byWindow.set(a(0) >>> 0, context);
  }
  return ok(context, 1);
}
function immReleaseContext(r, a) {
  const window = r.windows.windows.get(a(0));
  if (!window) return fail(r, ERROR_INVALID_WINDOW_HANDLE, 2);
  const state = imeState(r);
  const context = state.byWindow.get(a(0) >>> 0);
  if (context === undefined || context !== a(1) >>> 0) return fail(r, 6, 2);
  // Releasing frees the association but keeps the window usable for a later
  // ImmGetContext, which is the documented contract.
  state.byWindow.delete(a(0) >>> 0);
  return ok(1, 2);
}
function validContext(r, context) {
  const state = imeState(r);
  for (const value of state.byWindow.values()) if (value === context >>> 0) return true;
  return false;
}
// ImmGetCompositionStringW(hIMC, dwIndex, lpBuf, dwBufLen). There is no
// composition in progress, so every index reports an empty result: a zero
// length, or 0 bytes copied into the caller's buffer.
function immGetCompositionString(r, a, wide) {
  if (!validContext(r, a(0))) return fail(r, 6, 4);
  const buffer = a(2);
  const capacity = a(3) | 0;
  if (capacity < 0) return fail(r, ERROR_INVALID_PARAMETER, 4);
  if (buffer && capacity > 0) {
    r.check(buffer, capacity, true);
    r.data.fill(0, buffer, buffer + capacity);
  }
  void wide;
  return ok(0, 4);
}
// ImmSetCompositionFontA/W and ImmSetCompositionWindow describe where a
// composition would be drawn; there is none, so they validate and succeed.
function immSetCompositionFont(r, a) {
  if (!validContext(r, a(0))) return fail(r, 6, 2);
  if (a(1)) r.check(a(1), 60);
  return ok(1, 2);
}
function immSetCompositionWindow(r, a) {
  if (!validContext(r, a(0))) return fail(r, 6, 2);
  if (!a(1)) return fail(r, ERROR_INVALID_PARAMETER, 2);
  r.check(a(1), 28);
  return ok(1, 2);
}
// The remaining query calls answer the neutral "no composition" state the
// runtime is in, which is what an application reads before it starts typing.
function immGetDefaultIMEWnd(r, a) {
  if (!r.windows.windows.has(a(0))) return fail(r, ERROR_INVALID_WINDOW_HANDLE, 1);
  return ok(0, 1);
}
function immIsIME(r, a) {
  if (!validContext(r, a(0))) return fail(r, 6, 1);
  return ok(0, 1); // no IME is attached to the browser desktop
}

// ---------------------------------------------------------------------------
// The common dialogs. OPENFILENAMEA/W carries an owner window, a filter and the
// buffer the chosen path is written into. Since no native picker can open, the
// dialog reports "cancelled": GetOpenFileName returns FALSE and the extended
// error stays zero, which the documentation defines as a user cancel.
function validateOpenFileName(r, pointer, wide) {
  if (!pointer) return null;
  // OPENFILENAMEA is 76 bytes and OPENFILENAMEW is 88 on i386; the common
  // prefix up to the owner window is identical, so the size field is what
  // distinguishes a well-formed structure.
  const lStructSize = r.guestMemory.read(pointer, 4);
  if (lStructSize !== (wide ? 88 : 76)) return null;
  r.check(pointer, lStructSize);
  const owner = r.read32(pointer + 4);
  if (owner && !r.windows.windows.has(owner)) return null;
  const buffer = r.read32(pointer + 28);
  const maxFile = r.read32(pointer + 32);
  if (!buffer || maxFile < 1 || maxFile > 0xffff) return null;
  r.check(buffer, wide ? maxFile * 2 : maxFile, true);
  return { buffer, maxFile };
}
function openSaveFileName(r, a, wide) {
  const parsed = validateOpenFileName(r, a(0), wide);
  if (!parsed) return fail(r, ERROR_INVALID_PARAMETER, 1);
  // A cancel leaves the caller's buffer holding an empty string.
  if (wide) r.guestMemory.write(parsed.buffer, 0, 2);
  else r.data[parsed.buffer] = 0;
  r.lastError = 0;
  return ok(0, 1);
}
// ChooseFontA/W takes a CHOOSEFONT whose lpLogFont describes the current
// selection. A cancel leaves that structure unchanged.
function chooseFont(r, a, wide) {
  const pointer = a(0);
  if (!pointer) return fail(r, ERROR_INVALID_PARAMETER, 1);
  const lStructSize = r.guestMemory.read(pointer, 4);
  if (lStructSize !== (wide ? 60 : 60)) return fail(r, ERROR_INVALID_PARAMETER, 1);
  r.check(pointer, lStructSize);
  const owner = r.read32(pointer + 4);
  if (owner && !r.windows.windows.has(owner)) return fail(r, ERROR_INVALID_PARAMETER, 1);
  const logFont = r.read32(pointer + 12);
  if (!logFont) return fail(r, ERROR_INVALID_PARAMETER, 1);
  r.check(logFont, wide ? 92 : 60);
  r.lastError = 0;
  return ok(0, 1);
}

export const imeApis = {
  'imm32.dll!ImmGetContext': immGetContext,
  'imm32.dll!ImmReleaseContext': immReleaseContext,
  'imm32.dll!ImmGetCompositionStringA': (r, a) => immGetCompositionString(r, a, false),
  'imm32.dll!ImmGetCompositionStringW': (r, a) => immGetCompositionString(r, a, true),
  'imm32.dll!ImmSetCompositionFontA': immSetCompositionFont,
  'imm32.dll!ImmSetCompositionFontW': immSetCompositionFont,
  'imm32.dll!ImmSetCompositionWindow': immSetCompositionWindow,
  'imm32.dll!ImmGetDefaultIMEWnd': immGetDefaultIMEWnd,
  'imm32.dll!ImmIsIME': immIsIME,
  'imm32.dll!ImmAssociateContext': (r, a) => {
    if (!r.windows.windows.has(a(0))) return fail(r, ERROR_INVALID_WINDOW_HANDLE, 2);
    const state = imeState(r);
    const previous = state.byWindow.get(a(0) >>> 0) ?? 0;
    if (a(1)) state.byWindow.set(a(0) >>> 0, a(1) >>> 0);
    else state.byWindow.delete(a(0) >>> 0);
    return ok(previous, 2);
  },
  'imm32.dll!ImmAssociateContextEx': (r, a) =>
    r.windows.windows.has(a(0)) ? ok(1, 3) : fail(r, ERROR_INVALID_WINDOW_HANDLE, 3),
  'imm32.dll!ImmNotifyIME': (r, a) => (validContext(r, a(0)) ? ok(1, 4) : fail(r, 6, 4)),
};

export const comDlgApis = {
  'comdlg32.dll!GetOpenFileNameA': (r, a) => openSaveFileName(r, a, false),
  'comdlg32.dll!GetOpenFileNameW': (r, a) => openSaveFileName(r, a, true),
  'comdlg32.dll!GetSaveFileNameA': (r, a) => openSaveFileName(r, a, false),
  'comdlg32.dll!GetSaveFileNameW': (r, a) => openSaveFileName(r, a, true),
  'comdlg32.dll!ChooseFontA': (r, a) => chooseFont(r, a, false),
  'comdlg32.dll!ChooseFontW': (r, a) => chooseFont(r, a, true),
  // CommDlgExtendedError reports the last common-dialog error. A cancel is not
  // an error, so it reports zero.
  'comdlg32.dll!CommDlgExtendedError': () => ok(0, 0),
};
