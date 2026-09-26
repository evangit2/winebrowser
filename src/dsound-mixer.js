import { applyMixerGain } from './winmm-mixer.js';

export const SOUND_RATE = 44100;
const CHUNK = 1024;
export const soundTime = (r) => Number(r.performanceClock.read()) / 1e9;
export const decibelGain = (value) => (value <= -10000 ? 0 : 10 ** (value / 2000));

// Positions are source frames, anchored to the monotonic guest clock. Rendering
// ahead must never move the cursor reported to a polling application.
export function soundPosition(b, time) {
  const position = b.position + (b.playing ? Math.max(0, time - b.time) * b.frequency : 0);
  return b.looping ? position % b.frames : position;
}
export function syncSound(b, time) {
  if (!b.playing || b.primary) return;
  b.position = soundPosition(b, time);
  b.time = time;
  if (b.position >= b.frames) {
    b.position = 0;
    b.playing = false;
  }
}

function audible(r, b) {
  if (!b.device.state.cooperative) return false;
  if (b.flags & 0xc000) return true; // Global/sticky focus within this browser process.
  const focused = r.directInput?.focused !== false;
  const hwnd = b.device.state.window;
  return focused && (hwnd === 0x101 || r.windows.active === hwnd);
}

export function mixSound(r, buffers, start, frames, sampleRate = SOUND_RATE) {
  const samples = [new Float32Array(frames), new Float32Array(frames)];
  for (const b of buffers) {
    if (b.primary || !b.playing || !audible(r, b)) continue;
    const primary = b.device.state.primary?.state;
    const volume = decibelGain(b.volume) * decibelGain(primary?.volume ?? 0);
    const gains = [
      volume * decibelGain(-Math.max(0, b.pan)) * decibelGain(-Math.max(0, primary?.pan ?? 0)),
      volume * decibelGain(Math.min(0, b.pan)) * decibelGain(Math.min(0, primary?.pan ?? 0)),
    ];
    const f = b.format,
      stride = f.bits / 8;
    const sample = (frame, channel) => {
      const p = b.storage.pointer + frame * f.align + (f.channels === 1 ? 0 : channel * stride);
      return f.bits === 8 ? (r.data[p] - 128) / 128 : r.view.getInt16(p, true) / 32768;
    };
    for (let i = 0; i < frames; i++) {
      const time = start + i / sampleRate;
      if (time < b.time) continue;
      const position = soundPosition(b, time);
      if (position >= b.frames) break;
      const frame = Math.floor(position),
        fraction = position - frame;
      const next = frame + 1 < b.frames ? frame + 1 : b.looping ? 0 : frame;
      for (let c = 0; c < 2; c++) {
        const first = sample(frame, c);
        samples[c][i] += (first + (sample(next, c) - first) * fraction) * gains[c];
      }
    }
  }
  for (const channel of samples)
    for (let i = 0; i < frames; i++) channel[i] = Math.max(-1, Math.min(1, channel[i]));
  return applyMixerGain(r, { samples, frames, sampleRate });
}

export class DirectSoundMixer {
  constructor(runtime, { automatic = true } = {}) {
    this.runtime = runtime;
    this.buffers = new Set();
    this.automatic = automatic;
    this.nextTime = null;
    this.timer = null;
    this.disposed = false;
  }
  start() {
    if (this.disposed) return;
    if (this.automatic && !this.timer) {
      this.pump();
      this.timer = setInterval(() => this.pump(), 15);
    }
  }
  pump() {
    if (this.disposed) return;
    const now = soundTime(this.runtime);
    if (this.nextTime === null || this.nextTime < now - 0.05) this.nextTime = now;
    // At most three chunks after a scheduling stall: skip stale audio instead
    // of accumulating seconds of latency. Guest cursors still follow time.
    for (let chunks = 0; chunks < 3 && this.nextTime < now + 0.03; chunks++) {
      if (
        ![...this.buffers].some(
          (b) => !b.primary && b.playing && soundPosition(b, this.nextTime) < b.frames,
        )
      )
        break;
      const wave = mixSound(this.runtime, this.buffers, this.nextTime, CHUNK);
      this.runtime.emit({ type: 'audio-stream', ...wave });
      this.nextTime += CHUNK / SOUND_RATE;
    }
    for (const b of this.buffers) syncSound(b, now);
    if (![...this.buffers].some((b) => !b.primary && b.playing)) {
      clearInterval(this.timer);
      this.timer = null;
      this.nextTime = null;
    }
  }
  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    this.timer = null;
    this.buffers.clear();
    this.runtime.emit({ type: 'audio-stream-stop' });
  }
}
