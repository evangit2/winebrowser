import { encodeAnsi } from './encoding.js';

/** Convert synchronous system text messages at the ANSI/Unicode WndProc boundary. */
export async function sendWindowMessage(r, hwnd, message, wParam, lParam, wide) {
  const window = r.windows.windows.get(hwnd);
  const targetWide = !!window?.cls?.wide;
  if (!window || wide === targetWide || ![0xc, 0xd].includes(message))
    return r.windows.send(hwnd, message, wParam, lParam);
  let temporary;
  try {
    if (message === 0xc) {
      const value = wide ? r.wideString(lParam) : r.string(lParam);
      const bytes = targetWide ? null : encodeAnsi(value).bytes;
      temporary = targetWide ? r.allocString(value, true) : r.allocate(bytes.length + 1);
      if (bytes) r.data.set(bytes, temporary);
      return await r.windows.send(hwnd, message, wParam, temporary);
    }
    if (!wParam) return r.windows.send(hwnd, message, 0, lParam);
    if (wParam > 32768) throw Error('Window text buffer exceeds runtime limit');
    temporary = r.allocate(wParam * (targetWide ? 2 : 1));
    const copied = await r.windows.send(hwnd, message, wParam, temporary);
    const length = Math.min(copied, wParam - 1);
    let value = '';
    if (targetWide) {
      for (let i = 0; i < length; i++)
        value += String.fromCharCode(r.guestMemory.read(temporary + i * 2, 2));
    } else
      value = new TextDecoder('windows-1252').decode(
        r.data.subarray(temporary, temporary + length),
      );
    if (wide) {
      r.check(lParam, (value.length + 1) * 2, true);
      for (let i = 0; i <= value.length; i++)
        r.guestMemory.write(lParam + i * 2, i === value.length ? 0 : value.charCodeAt(i), 2);
      return value.length;
    }
    const bytes = encodeAnsi(value).bytes.subarray(0, wParam - 1);
    r.check(lParam, bytes.length + 1, true);
    r.data.set(bytes, lParam);
    r.guestMemory.write(lParam + bytes.length, 0, 1);
    return bytes.length;
  } finally {
    if (temporary) r.free(temporary);
  }
}
