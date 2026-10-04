// Horizontal PE32 progress controls, following Wine comctl32/progress.c.
function model(w) {
  return (w.progress ??= {
    low: 0,
    high: 100,
    position: 0,
    step: 10,
    state: 1,
    foreground: 0xff000000,
    background: 0xff000000,
    marquee: false,
  });
}
export function describeProgress(w) {
  return w.controlType === 'progress' ? { ...model(w) } : undefined;
}
export function progressMessage(r, w, msg, wp, lp, fallback) {
  const p = model(w),
    old = p.position;
  const clamp = () => {
    p.position = Math.max(p.low, Math.min(p.high, p.position));
  };
  const emit = () => r.windows.emit(w);
  if (msg === 0x401 || msg === 0x406) {
    const previous = ((p.high << 16) | (p.low & 0xffff)) >>> 0;
    p.low = msg === 0x401 ? lp & 0xffff : wp | 0;
    p.high = msg === 0x401 ? lp >>> 16 : lp | 0;
    clamp();
    emit();
    return previous;
  }
  if (msg === 0x402 || msg === 0x403) {
    if (msg === 0x402 && w.style & 8) return 1;
    p.position = msg === 0x402 ? wp | 0 : (old + (wp | 0)) | 0;
    clamp();
    emit();
    return old;
  }
  if (msg === 0x404) {
    const oldStep = p.step;
    p.step = wp | 0;
    return oldStep;
  }
  if (msg === 0x405) {
    if (p.low !== p.high) {
      p.position = (old + p.step) | 0;
      if (p.position > p.high) p.position = ((p.position - p.low) % (p.high - p.low)) + p.low;
      if (p.position < p.low) p.position = ((p.position - p.low) % (p.high - p.low)) + p.high;
      emit();
    }
    return old;
  }
  if (msg === 0x407) {
    if (lp) {
      r.check(lp, 8, true);
      r.write32(lp, p.low);
      r.write32(lp + 4, p.high);
    }
    return wp ? p.low : p.high;
  }
  if (msg === 0x408) return p.position;
  if (msg === 0x409 || msg === 0x2001) {
    const field = msg === 0x409 ? 'foreground' : 'background',
      previous = p[field];
    p[field] = lp >>> 0;
    emit();
    return previous;
  }
  if (msg === 0x40a) {
    p.marquee = !!wp;
    emit();
    return +p.marquee;
  }
  if (msg === 0x40d) return p.step;
  if (msg === 0x40e) return p.background;
  if (msg === 0x40f) return p.foreground;
  if (msg === 0x410) {
    if (![1, 2, 3].includes(wp)) return 0;
    const previous = p.state;
    p.state = wp;
    emit();
    return previous;
  }
  if (msg === 0x411) return p.state;
  if (msg >= 0x400 && msg < 0x8000)
    throw Error(`Unsupported progress message 0x${msg.toString(16)}`);
  return fallback();
}
