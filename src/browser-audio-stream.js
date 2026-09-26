// One mixed DirectSound stream per guest process. Individual PCM sources are
// short lived; stalled pages cannot grow an unbounded Web Audio queue.
export class BrowserAudioStream {
  constructor() {
    this.sources = new Set();
    this.nextTime = 0;
  }
  write(context, wave, muted = false) {
    if (context.state !== 'running') {
      this.stop();
      return false;
    }
    const now = context.currentTime;
    if (this.nextTime > now + 0.15) this.stop();
    const buffer = context.createBuffer(wave.samples.length, wave.frames, wave.sampleRate);
    wave.samples.forEach((channel, i) => buffer.copyToChannel(channel, i));
    const source = context.createBufferSource(),
      gain = context.createGain();
    source.buffer = buffer;
    gain.gain.value = muted ? 0 : 1;
    source.connect(gain).connect(context.destination);
    const item = { source, gain };
    const cleanup = () => {
      this.sources.delete(item);
      source.disconnect();
      gain.disconnect();
    };
    source.onended = cleanup;
    this.sources.add(item);
    const start = Math.max(now + 0.02, this.nextTime);
    this.nextTime = start + wave.frames / wave.sampleRate;
    source.start(start);
    return true;
  }
  stop() {
    for (const { source, gain } of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {}
      source.disconnect();
      gain.disconnect();
    }
    this.sources.clear();
    this.nextTime = 0;
  }
}
