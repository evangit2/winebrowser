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
  // OPENFILENAMEA and OPENFILENAMEW are both 88 bytes on i386; the wide form
  // does not grow the structure because every member is a DWORD or a pointer.
  // The size field is what distinguishes a well-formed structure.
  const lStructSize = r.guestMemory.read(pointer, 4);
  void wide;
  if (lStructSize !== 88) return null;
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

// ---------------------------------------------------------------------------
// Serial ports and named pipes. The browser sandbox has no COM port or
// inter-process pipe, so every one of these reports the documented
// "not found"/"invalid handle" outcome instead of handing back a handle that
// would never carry bytes. PuTTY probes these while enumerating connection
// methods and handles their absence.
// The browser sandbox has no COM port and no inter-process pipe. A serial call
// on a handle the runtime never opened is ERROR_INVALID_HANDLE; anything that
// tries to create or open a port or pipe name reports ERROR_FILE_NOT_FOUND,
// which is what Windows returns for a device that is not installed.
function serialApi(r, a, argc) {
  const handle = a(0) >>> 0;
  if (!r.handles?.has(handle)) return fail(r, 6, argc);
  // A handle the runtime did open is a file or a standard stream, not a serial
  // port, so the serial control calls do not apply to it.
  return fail(r, 6, argc);
}
function namedPipeApi(r, a, argc) {
  return fail(r, 2, argc);
}
export const serialApis = {
  'kernel32.dll!GetCommState': (r, a) => serialApi(r, a, 2),
  'kernel32.dll!SetCommState': (r, a) => serialApi(r, a, 2),
  'kernel32.dll!SetCommTimeouts': (r, a) => serialApi(r, a, 2),
  'kernel32.dll!ClearCommBreak': (r, a) => serialApi(r, a, 1),
  'kernel32.dll!SetCommBreak': (r, a) => serialApi(r, a, 1),
  'kernel32.dll!ClearCommError': (r, a) => serialApi(r, a, 3),
  'kernel32.dll!GetCommModemStatus': (r, a) => serialApi(r, a, 2),
  'kernel32.dll!PurgeComm': (r, a) => serialApi(r, a, 2),
  'kernel32.dll!EscapeCommFunction': (r, a) => serialApi(r, a, 2),
  'kernel32.dll!CreateNamedPipeA': (r, a) => namedPipeApi(r, a, 8),
  'kernel32.dll!CreateNamedPipeW': (r, a) => namedPipeApi(r, a, 8),
  'kernel32.dll!ConnectNamedPipe': (r, a) => namedPipeApi(r, a, 2),
  'kernel32.dll!WaitNamedPipeA': (r, a) => namedPipeApi(r, a, 2),
  'kernel32.dll!WaitNamedPipeW': (r, a) => namedPipeApi(r, a, 2),
  'kernel32.dll!DisconnectNamedPipe': (r, a) => namedPipeApi(r, a, 1),
  'kernel32.dll!CallNamedPipeA': (r, a) => namedPipeApi(r, a, 7),
  'kernel32.dll!CallNamedPipeW': (r, a) => namedPipeApi(r, a, 7),
  'kernel32.dll!TransactNamedPipe': (r, a) => namedPipeApi(r, a, 7),
};

// ToAsciiEx(VirtualKey, ScanCode, KeyState[256], Word *Out, Flags, HKL) maps a
// key to the characters it produces. The runtime's keyboard layout is US-ASCII,
// so the mapping covers the printable keys and reports zero translated
// characters for everything else, which is what ToAsciiEx documents.
function toAsciiEx(r, a) {
  const vk = a(0) >>> 0;
  const statePointer = a(2);
  const out = a(3);
  const flags = a(4) >>> 0;
  if (!statePointer || !out) return fail(r, ERROR_INVALID_PARAMETER, 6);
  if (flags & ~0x3) return fail(r, ERROR_INVALID_PARAMETER, 6);
  r.check(statePointer, 256);
  r.check(out, 2, true);
  r.guestMemory.write(out, 0, 2);
  const shift = !!(r.data[statePointer + 0x10] & 0x80);
  const caps = !!(r.data[statePointer + 0x14] & 0x01);
  if (vk >= 0x41 && vk <= 0x5a) {
    // A letter key honours Shift XOR Caps Lock.
    const upper = shift !== caps;
    const code = upper ? vk : vk + 0x20;
    r.guestMemory.write(out, code, 2);
    return ok(1, 6);
  }
  const digits = shift
    ? {
        0x30: ')',
        0x31: '!',
        0x32: '@',
        0x33: '#',
        0x34: '$',
        0x35: '%',
        0x36: '^',
        0x37: '&',
        0x38: '*',
        0x39: '(',
      }
    : null;
  if (vk >= 0x30 && vk <= 0x39) {
    r.guestMemory.write(out, digits ? digits[vk].charCodeAt(0) : vk, 2);
    return ok(1, 6);
  }
  const punctuation = {
    0x20: ' ',
    0xbd: shift ? '_' : '-',
    0xbb: shift ? '+' : '=',
    0xdb: shift ? '{' : '[',
    0xdd: shift ? '}' : ']',
    0xdc: shift ? '|' : '\\',
    0xba: shift ? ':' : ';',
    0xde: shift ? '"' : "'",
    0xbc: shift ? '<' : ',',
    0xbe: shift ? '>' : '.',
    0xbf: shift ? '?' : '/',
    0xc0: shift ? '~' : '`',
  };
  const code = punctuation[vk];
  if (code) {
    r.guestMemory.write(out, code.charCodeAt(0), 2);
    return ok(1, 6);
  }
  return ok(0, 6);
}
// MsgWaitForMultipleObjects waits for the handles or for a new message. The
// runtime has no cross-process handles, so it waits on its own message queue
// and reports QS_ALLINPUT when a message arrives.
async function msgWaitForMultipleObjects(r, a, multiple, extended) {
  const argc = multiple ? (extended ? 6 : 5) : 3;
  const timeoutIndex = multiple ? (extended ? 4 : 3) : 1;
  const milliseconds = a(timeoutIndex) >>> 0;
  const hasMessage = () => r.windows.next(0, 0, 0, false) !== null;
  if (hasMessage()) return ok(0, argc);
  if (milliseconds === 0xffffffff) {
    while (!hasMessage()) await r.threads.yield();
    return ok(0, argc);
  }
  const deadline = Date.now() + milliseconds;
  while (!hasMessage() && Date.now() < deadline) {
    await r.threads.block(new Promise((resolve) => setTimeout(resolve, 1)));
  }
  if (hasMessage()) return ok(0, argc); // WAIT_OBJECT_0 + the message index
  return ok(0x102, argc); // WAIT_TIMEOUT
}
// LoadImageA/W loads an icon, cursor or bitmap from a module or a file. The
// runtime already decodes icons and cursors from PE resources, so this routes
// to the same loaders for the resource forms.
function loadImage(r, a, wide) {
  const type = a(1) >>> 0;
  const name = a(2);
  const flags = a(4) >>> 0;
  if (flags & ~(0x1 | 0x2 | 0x10 | 0x20 | 0x40 | 0x4000 | 0x8000))
    return fail(r, ERROR_INVALID_PARAMETER, 6);
  if (type === 1) {
    // IMAGE_ICON: delegate to LoadIcon, which decodes a real RT_GROUP_ICON.
    const handler = r.apiProvider.get('user32.dll!LoadIcon' + (wide ? 'W' : 'A'));
    return handler ? handler(r, (i) => [a(0), name][i] ?? 0) : fail(r, 6, 6);
  }
  if (type === 2) {
    const handler = r.apiProvider.get('user32.dll!LoadCursor' + (wide ? 'W' : 'A'));
    return handler ? handler(r, (i) => [a(0), name][i] ?? 0) : fail(r, 6, 6);
  }
  // IMAGE_BITMAP needs a bitmap resource decoder the runtime does not have, so
  // this reports failure rather than a handle that would not paint.
  return fail(r, 6, 6);
}
// GetClipboardOwner reports the window that currently owns the clipboard. The
// runtime has a single in-process clipboard, so the owner is the window the
// last SetClipboardData call came from.
function getClipboardOwner(r) {
  return ok(r.clipboardOwner ?? 0, 0);
}
export const imeExtraApis = {
  'user32.dll!ToAsciiEx': toAsciiEx,
  'user32.dll!ToUnicodeEx': (r, a) => {
    // ToUnicodeEx fills a 16-bit buffer of translated characters; it shares the
    // US-ASCII mapping with ToAsciiEx.
    const out = a(2);
    const count = a(3) | 0;
    if (!out || count < 1) return fail(r, ERROR_INVALID_PARAMETER, 7);
    r.check(out, count * 2, true);
    const mapped = toAsciiEx(r, (i) => [a(0), a(1), a(4), out, a(5)][i] ?? 0);
    if (!mapped.result) r.guestMemory.write(out, 0, 2);
    return ok(mapped.result, 7);
  },
  'user32.dll!MsgWaitForMultipleObjects': (r, a) => msgWaitForMultipleObjects(r, a, true, false),
  'user32.dll!MsgWaitForMultipleObjectsEx': (r, a) => msgWaitForMultipleObjects(r, a, true, true),
  'user32.dll!LoadImageA': (r, a) => loadImage(r, a, false),
  'user32.dll!LoadImageW': (r, a) => loadImage(r, a, true),
  'user32.dll!GetClipboardOwner': getClipboardOwner,
};

// MessageBoxIndirectW takes a MSGBOXPARAMSW describing the same dialog
// MessageBoxW shows. The runtime's message box already renders that dialog, so
// this reads the structure and routes through the same request path.
async function messageBoxIndirect(r, a, wide = true) {
  const pointer = a(0);
  if (!pointer) return fail(r, ERROR_INVALID_PARAMETER, 1);
  const size = r.guestMemory.read(pointer, 4);
  // MSGBOXPARAMSA and MSGBOXPARAMSW are both 40 bytes on i386: the members are
  // DWORDs and pointers, so the wide form does not grow the structure. The
  // caller's entry point decides which string form the pointers carry.
  if (size !== 40) return fail(r, ERROR_INVALID_PARAMETER, 1);
  r.check(pointer, size);
  const owner = r.read32(pointer + 4);
  if (owner && !r.windows.windows.has(owner)) return fail(r, ERROR_INVALID_WINDOW_HANDLE, 1);
  const textPointer = r.read32(pointer + 8);
  const captionPointer = r.read32(pointer + 12);
  const style = r.read32(pointer + 16);
  const text = textPointer ? (wide ? r.wideString(textPointer) : r.string(textPointer)) : '';
  const caption = captionPointer
    ? wide
      ? r.wideString(captionPointer)
      : r.string(captionPointer)
    : '';
  // The body of the dialog is the same request MessageBoxW makes; a caller
  // that supplied an icon from a resource is honoured by passing the icon
  // handle through as the detail's icon when it names one.
  const iconHandle = r.read32(pointer + 32);
  const detail = {
    owner,
    text,
    title: caption || 'Error',
    icon: iconHandle ? 'information' : null,
    style,
  };
  if (
    style &
    ~(
      7 |
      0x70 |
      0xf00 |
      0x1000 |
      0x2000 |
      0x4000 |
      0x8000 |
      0x10000 |
      0x20000 |
      0x40000 |
      0x80000 |
      0x100000 |
      0x200000
    )
  )
    return fail(r, ERROR_INVALID_PARAMETER, 1);
  const answer = await r.request('messagebox', detail);
  return ok(answer, 1);
}
// ChooseColorA/W takes a CHOOSECOLORA/W. No native colour picker can open in
// the sandbox, so this validates the structure and reports the documented
// user-cancel result; the caller's colour fields are left untouched.
function chooseColor(r, a) {
  const pointer = a(0);
  if (!pointer) return fail(r, ERROR_INVALID_PARAMETER, 1);
  if (r.guestMemory.read(pointer, 4) !== 36) return fail(r, ERROR_INVALID_PARAMETER, 1);
  r.check(pointer, 36);
  const owner = r.read32(pointer + 4);
  if (owner && !r.windows.windows.has(owner)) return fail(r, ERROR_INVALID_PARAMETER, 1);
  const customColors = r.read32(pointer + 16);
  if (customColors) r.check(customColors, 64, true);
  r.lastError = 0;
  return ok(0, 1);
}
export const dialogExtraApis = {
  'user32.dll!MessageBoxIndirectW': messageBoxIndirect,
  'user32.dll!MessageBoxIndirectA': (r, a) => messageBoxIndirect(r, a, false),
  'comdlg32.dll!ChooseColorA': chooseColor,
  'comdlg32.dll!ChooseColorW': chooseColor,
};
