// Original WineBrowser contributors, MIT. Geometry captured from native SDK controls.
export function nativeMulDiv(a, b, divisor) {
  a |= 0;
  b |= 0;
  divisor |= 0;
  if (!divisor) return -1;
  const value = (a * b) / divisor;
  const rounded = Math.sign(value) * Math.floor(Math.abs(value) + 0.5);
  return rounded < -2147483648 || rounded > 2147483647 ? -1 : rounded;
}
export function scrollbarGeometry(length, state, disabled = 0) {
  const arrow = length <= 38 ? Math.max(0, Math.trunc((length - 4) / 2)) : 17;
  const space = Math.max(0, length - 2 * arrow);
  const proportional = state.page ? nativeMulDiv(space, state.page, state.max - state.min + 1) : 0;
  let thumb = proportional ? Math.max(8, proportional) : 17;
  if (thumb > space || disabled === 3) thumb = 0;
  const span = state.max - state.min - Math.max(0, state.page - 1);
  const top = !thumb
    ? 0
    : arrow +
      (span
        ? nativeMulDiv(space - thumb, (state.tracking ? state.track : state.pos) - state.min, span)
        : 0);
  return { length, arrow, thumb, top, bottom: top + thumb, space };
}
